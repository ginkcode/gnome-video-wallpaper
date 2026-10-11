// Primary logical monitor only until per-monitor players land. With no stored
// selections, GINK_VW_TEST_FILE stages a fixture for nested testing.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {waitUntil} from './async.js';
import {BackgroundLayer} from './backgroundLayer.js';
import {readMonitorConfigs} from './config.js';
import {targetGeometry} from './geometry.js';
import {createLogger} from './log.js';
import {ProbeError, probe} from './mediaProbe.js';
import {FailureNotifier} from './notifier.js';
import {getMonitors} from './monitorIdentity.js';
import {monitorIndexForConnector} from './monitors.js';
import {buildMpvArgv} from './mpvArgs.js';
import {MpvIpc} from './mpvIpc.js';
import {PlayerProcess, preparePlayerSocket, releasePlayerSocket} from './playerProcess.js';
import {PlayerManagerLifecycle} from './playerManagerLifecycle.js';
import {waitForStartup} from './startupGate.js';
import {CacheError, acquirePlaybackAsset, ensureStill, publishWallpaper, releasePlaybackAsset} from './stillCache.js';
import {canOptimize, optimizedPath, shouldOptimize} from './transcoder.js';
import {WallpaperSync} from './wallpaperSync.js';

const VIDEO_OUTPUTS = {
    'auto': 'dmabuf-wayland,wlshm',
    'gpu-next': 'gpu-next',
    'dmabuf-wayland': 'dmabuf-wayland',
};

function testSelection() {
    const file = GLib.getenv('GINK_VW_TEST_FILE');
    if (!file || !GLib.path_is_absolute(file))
        return null;
    return {file, fitMode: null, optimize: null};
}

async function resolveTargets(settings, cancellable) {
    const {physicalMonitors, logicalMonitors} = await getMonitors(cancellable);
    const logical = logicalMonitors.find(monitor => monitor.primary) ?? logicalMonitors[0];
    if (!logical)
        return [];
    const configs = readMonitorConfigs(settings);
    const members = logical.connectors.map(connector =>
        physicalMonitors.find(physical => physical.connector === connector)).filter(Boolean);
    let selected = members.find(physical => configs[physical.id]);
    let config = selected ? configs[selected.id] : null;
    if (!config && Object.keys(configs).length === 0) {
        config = testSelection();
        selected = members[0];
    }
    if (!config || !selected)
        return [];
    const monitorIndex = monitorIndexForConnector(logical.connectors[0]);
    if (monitorIndex < 0)
        throw new Error(`logical monitor ${logical.key} has no layout index`);
    const fitMode = config.fitMode ?? settings.get_string('default-fit-mode');
    const geometry = targetGeometry(logical, fitMode);
    const optimize = config.optimize ?? settings.get_boolean('optimize-videos');
    return [{
        logicalMonitorKey: logical.key,
        selectedPhysicalMonitorId: selected.id,
        selectionKey: JSON.stringify([selected.id, config.file, geometry, optimize]),
        monitorIndex,
        file: config.file,
        optimize,
        geometry,
        systemWallpaper: logicalMonitors.length === 1,
    }];
}

const TRANSIENT_CACHE_ERRORS = new Set(['SOURCE_CHANGED', 'STILL_MISSING']);

function classify(error) {
    if (error instanceof ProbeError)
        return 'permanent';
    if (error instanceof CacheError && !TRANSIENT_CACHE_ERRORS.has(error.code))
        return 'permanent';
    return 'transient';
}

export class PlayerManager extends PlayerManagerLifecycle {
    constructor({settings, openPreferences = () => {}, logger = createLogger('player-manager')}) {
        const vo = () => VIDEO_OUTPUTS[settings.get_string('video-output')] ?? VIDEO_OUTPUTS.auto;
        let sync = null;
        let notifier = null;
        super({logger, env: {
            waitForStartup: ({cancellable}) => waitForStartup({cancellable,
                delayMs: settings.get_uint('startup-delay-ms')}),
            staggerMs: () => settings.get_uint('stagger-ms'),
            waitForPaintable: ({cancellable}) =>
                waitUntil(Main.overview, 'hidden', () => !Main.overview.visible, cancellable),
            resolveTargets: ({cancellable}) => resolveTargets(settings, cancellable),
            probe: (path, cancellable) => probe(path, cancellable),
            acquireAsset: (media, geometry, {optimize, cancellable}) => acquirePlaybackAsset(media, geometry, {
                cancellable,
                optimizedPath: shouldOptimize(media, {optimize}, false) && canOptimize(geometry)
                    ? optimizedPath(media, geometry)
                    : null,
            }),
            releaseAsset: asset => releasePlaybackAsset(asset),
            ensureStill: (asset, geometry, cancellable) => ensureStill(asset, geometry, cancellable),
            publishWallpaper: (stillPath, cancellable) => publishWallpaper(stillPath, cancellable),
            applyWallpaper: path => {
                sync ??= new WallpaperSync(settings, createLogger('wallpaper-sync'));
                sync.apply(Gio.File.new_for_path(path).get_uri());
            },
            classify,
            maxRetries: () => settings.get_uint('max-retries'),
            notify: (_key, message) => {
                notifier ??= new FailureNotifier({openPreferences});
                notifier.notify('Video wallpaper stopped', `${message}\nThe still image stays as the wallpaper.`);
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
            createProcess: ({socketPath}) => new PlayerProcess({socketPath, logger: createLogger('mpv'),
                argv: buildMpvArgv({mpvPath: 'mpv', socketPath, vo: vo()})}),
            createIpc: socketPath => new MpvIpc(socketPath, createLogger('mpv-ipc')),
        }});
    }
}
