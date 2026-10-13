import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {waitUntil} from './async.js';
import {BackgroundLayer} from './backgroundLayer.js';
import {stat} from './cacheFs.js';
import {readMonitorConfigs} from './config.js';
import {createLogger} from './log.js';
import {ProbeError, probe} from './mediaProbe.js';
import {FailureNotifier} from './notifier.js';
import {getMonitors} from './monitorIdentity.js';
import {planTargets, selectionKey} from './monitorTopology.js';
import {monitorIndexForConnector} from './monitors.js';
import {buildMpvArgv} from './mpvArgs.js';
import {MpvIpc} from './mpvIpc.js';
import {PlayerProcess, preparePlayerSocket, releasePlayerSocket} from './playerProcess.js';
import {PlayerManagerLifecycle} from './playerManagerLifecycle.js';
import {waitForStartup} from './startupGate.js';
import {CacheError, acquirePlaybackAsset, ensureNativeStill, ensureStill, publishWallpaper, releasePlaybackAsset}
    from './stillCache.js';
import {canOptimize, optimizedPath, shouldOptimize} from './transcoder.js';
import {WallpaperSync} from './wallpaperSync.js';

const log = createLogger('monitors');

const VIDEO_OUTPUTS = {
    'auto': 'dmabuf-wayland,wlshm',
    'gpu-next': 'gpu-next',
    'dmabuf-wayland': 'dmabuf-wayland',
};

function videoOutput(settings) {
    return VIDEO_OUTPUTS[settings.get_string('video-output')] ?? VIDEO_OUTPUTS.auto;
}

function optimizedFor(media, geometry, optimize) {
    return shouldOptimize(media, {optimize}, false) && canOptimize(geometry) ? optimizedPath(media, geometry) : null;
}

async function assetSelection(file, geometry, optimize, cancellable) {
    let media;
    try {
        media = await probe(file, cancellable);
    } catch (error) {
        if (error instanceof ProbeError)
            return null;
        throw error;
    }
    const path = optimizedFor(media, geometry, optimize);
    const optimized = path ? await stat(path, cancellable) : null;
    return [media.size, media.mtime, optimized?.get_size() ?? null,
        optimized?.get_attribute_uint64('time::modified') ?? null,
        optimized?.get_attribute_uint32('time::modified-usec') ?? null];
}

async function resolveTargets(settings, fileFor, cancellable) {
    const topology = await getMonitors(cancellable);
    cancellable?.set_error_if_cancelled();
    const plans = planTargets(topology, readMonitorConfigs(settings), {
        defaultFitMode: settings.get_string('default-fit-mode'),
        optimizeVideos: settings.get_boolean('optimize-videos'),
        vo: videoOutput(settings),
        monitorIndexFor: monitorIndexForConnector,
        fileFor: (id, config) => fileFor(id, config.files),
        logger: log,
    });
    const targets = [];
    for (const plan of plans) {
        const asset = await assetSelection(plan.file, plan.geometry, plan.optimize, cancellable);
        cancellable?.set_error_if_cancelled();
        targets.push({...plan, selectionKey: selectionKey(plan, asset)});
    }
    return targets;
}

const DRIVER_HINT = 'Install the VA-API driver for your GPU, for example intel-media-va-driver on Intel ' +
    'or mesa-va-drivers on AMD.';

const TRANSIENT_CACHE_ERRORS = new Set(['SOURCE_CHANGED', 'STILL_MISSING']);

function classify(error) {
    if (error instanceof ProbeError)
        return 'permanent';
    if (error instanceof CacheError && !TRANSIENT_CACHE_ERRORS.has(error.code))
        return 'permanent';
    return 'transient';
}

export class PlayerManager extends PlayerManagerLifecycle {
    constructor({settings, openPreferences = () => {}, fileFor = (_id, files) => files[0],
        logger = createLogger('player-manager')}) {
        let sync = null;
        let notifier = null;
        super({logger, env: {
            waitForStartup: ({cancellable}) => waitForStartup({cancellable,
                delayMs: settings.get_uint('startup-delay-ms')}),
            staggerMs: () => settings.get_uint('stagger-ms'),
            waitForPaintable: ({cancellable}) =>
                waitUntil(Main.overview, 'hidden', () => !Main.overview.visible, cancellable),
            resolveTargets: ({cancellable}) => resolveTargets(settings, fileFor, cancellable),
            probe: (path, cancellable) => probe(path, cancellable),
            acquireAsset: (media, geometry, {optimize, cancellable}) => acquirePlaybackAsset(media, geometry, {
                cancellable, optimizedPath: optimizedFor(media, geometry, optimize)}),
            releaseAsset: asset => releasePlaybackAsset(asset),
            ensureStill: (asset, geometry, cancellable) => ensureStill(asset, geometry, cancellable),
            publishWallpaper: (stillPath, cancellable) => publishWallpaper(stillPath, cancellable),
            nativeStill: (media, cancellable) => ensureNativeStill(media, cancellable),
            primaryMonitorIndex: () => Main.layoutManager.primaryIndex,
            applyWallpaper: (path, options = 'zoom') => {
                sync ??= new WallpaperSync(settings, createLogger('wallpaper-sync'));
                sync.apply(Gio.File.new_for_path(path).get_uri(), options);
            },
            classify,
            maxRetries: () => settings.get_uint('max-retries'),
            notify: (_key, message) => {
                notifier ??= new FailureNotifier({openPreferences});
                notifier.notify('Video wallpaper stopped', `${message}\nThe still image stays as the wallpaper. ` +
                    'If this keeps happening, make sure the VA-API driver for your GPU is installed.');
            },
            softwareDecoding: () => {
                notifier ??= new FailureNotifier({openPreferences});
                notifier.notify('Video wallpaper uses the CPU',
                    `Hardware video decoding is unavailable, so playback uses more CPU and power. ${DRIVER_HINT}`);
            },
            restoreWallpaper: () => {
                if (Object.keys(readMonitorConfigs(settings)).length > 0)
                    return;
                sync ??= new WallpaperSync(settings, createLogger('wallpaper-sync'));
                const applied = sync.isApplied;
                sync.restore();
                sync.destroy();
                sync = null;
                return applied ? 1500 : 0;
            },
            onStop: ({restore}) => {
                if (restore) {
                    sync ??= new WallpaperSync(settings, createLogger('wallpaper-sync'));
                    sync.restore();
                }
                sync?.destroy();
                sync = null;
                notifier?.destroy();
                notifier = null;
            },
            createLayer: target => new BackgroundLayer({monitorIndex: target.monitorIndex,
                logger: createLogger('background')}),
            prepareSocket: options => preparePlayerSocket(options),
            releaseSocket: socketPath => releasePlayerSocket(socketPath),
            createProcess: ({socketPath, vo}) => new PlayerProcess({socketPath, logger: createLogger('mpv'),
                argv: buildMpvArgv({mpvPath: 'mpv', socketPath, vo: vo ?? videoOutput(settings)})}),
            createIpc: socketPath => new MpvIpc(socketPath, createLogger('mpv-ipc')),
        }});
    }
}
