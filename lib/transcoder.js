import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {spawnLines} from './async.js';
import {cacheKey} from './cacheKey.js';
import {cacheRoot, makeDir, removeTree, stat, uniqueName} from './cacheFs.js';
import {findProgram} from './deps.js';
import {ffmpegScaleFilter} from './geometry.js';
import {createLogger} from './log.js';
import {probe} from './mediaProbe.js';
import {SharedWork} from './sharedWork.js';
import {CacheError, colorInput} from './stillCache.js';

Gio._promisify(Gio.File.prototype, 'move_async');

const ASSET_IDENTITY = 'h264-sdr-v1';
const RENDER_NODE = '/dev/dri/renderD128';
const SPACES = {bt709: 'bt709', smpte170m: 'bt601', bt470bg: 'bt470', smpte240m: 'smpte240m', fcc: 'fcc'};
const PRIMARIES = {bt709: 'bt709', smpte170m: 'smpte170m', bt470bg: 'bt470bg', smpte240m: 'smpte240m',
    fcc: 'bt470m'};

const logger = createLogger('transcoder');
const work = new SharedWork();
const listeners = new Map();

export function canOptimize({width, height}) {
    return width % 2 === 0 && height % 2 === 0;
}

export function shouldOptimize(media, config, optimizeVideos) {
    return Boolean(media?.isGif) || (config?.optimize ?? optimizeVideos) === true;
}

export function optimizedPath(media, {width, height, scale, fitMode, transformVersion}) {
    const key = cacheKey({path: media.path, size: media.size, mtime: media.mtime, width, height, scale, fitMode,
        transformVersion, kind: 'media', assetIdentity: ASSET_IDENTITY});
    return GLib.build_filenamev([cacheRoot(), 'media', `${key}.mp4`]);
}

export function colorPlan(source) {
    if (source.isGif || source.codec === 'gif') {
        return {filter: ':out_color_matrix=bt709:out_range=tv',
            tags: {colorspace: 'bt709', range: 'tv', color_primaries: 'bt709', color_trc: 'bt709'}};
    }
    const input = colorInput(source);
    const kept = SPACES[source.colorSpace] ? source.colorSpace : null;
    const space = kept ?? (input.includes('=bt709') || source.colorSpace ? 'bt709' : 'smpte170m');
    const fallbackTransfer = space === 'bt709' ? 'bt709' : 'smpte170m';
    return {
        filter: `:out_color_matrix=${SPACES[space]}:out_range=tv`,
        tags: {
            colorspace: space,
            range: 'tv',
            color_primaries: (kept && source.colorPrimaries) || PRIMARIES[space],
            color_trc: (kept && source.colorTransfer) || fallbackTransfer,
        },
    };
}

export function transcodeArgs(media, geometry, {ffmpeg, output, vaapi}) {
    const color = colorPlan(media);
    const params = Object.entries(color.tags).map(([name, value]) => `${name}=${value}`).join(':');
    const filter = `scale=round(iw*sar):ih:flags=lanczos${colorInput(media)}${color.filter},setsar=1,` +
        `${ffmpegScaleFilter(geometry.width, geometry.height, geometry.fitMode)},setsar=1,setparams=${params},` +
        (vaapi ? 'format=nv12,hwupload' : 'format=yuv420p');
    const encoder = vaapi
        ? ['-c:v', 'h264_vaapi', '-qp', '20']
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
    return [ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        ...vaapi ? ['-vaapi_device', RENDER_NODE] : [],
        '-i', `file:${media.path}`, '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1',
        '-vf', filter, ...media.isGif ? ['-fps_mode', 'passthrough'] : [], ...encoder,
        '-force_key_frames', 'expr:gte(t,n_forced*2)',
        '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', `file:${output}`];
}

function priority() {
    const nice = findProgram('nice');
    const ionice = findProgram('ionice');
    return [...nice ? [nice, '-n', '15'] : [], ...ionice ? [ionice, '-c3'] : []];
}

function notify(output, fraction) {
    for (const listener of listeners.get(output) ?? []) {
        try {
            listener(Math.min(1, Math.max(0, fraction)));
        } catch (error) {
            logger.warn(`progress listener failed: ${error.message}`);
        }
    }
}

async function encode(media, geometry, temp, vaapi, output, cancellable) {
    const duration = media.durationSec;
    const messages = [];
    const status = await spawnLines([...priority(), ...transcodeArgs(media, geometry,
        {ffmpeg: findProgram('ffmpeg'), output: temp, vaapi})], {
        cancellable,
        onLine: line => {
            const [name, value] = line.split('=', 2);
            if (name === 'out_time_us' && duration)
                notify(output, Number(value) / 1e6 / duration);
            else if (name === 'progress' && value === 'end')
                notify(output, 1);
            else if (value === undefined && line.trim())
                messages.push(line.trim());
        },
    });
    return {status, message: messages.slice(0, 2).join(' ')};
}

async function verify(media, geometry, temp, cancellable) {
    const result = await probe(temp, cancellable);
    if (result.codec !== 'h264' || result.width !== geometry.width || result.height !== geometry.height) {
        throw new CacheError('TRANSCODE_FAILED', `Optimized video is ${result.codec} ${result.width}×${result.height}, ` +
            `expected h264 ${geometry.width}×${geometry.height}.`);
    }
    const source = await stat(media.path, cancellable);
    const mtime = source ? source.get_attribute_uint64('time::modified') * 1e6 +
        source.get_attribute_uint32('time::modified-usec') : null;
    if (!source || source.get_size() !== media.size || mtime !== media.mtime)
        throw new CacheError('SOURCE_CHANGED', `${media.path} changed while it was being optimized; choose it again.`);
}

async function produce(media, geometry, output, cancellable) {
    if (!findProgram('ffmpeg'))
        throw new CacheError('FFMPEG_MISSING', 'ffmpeg is not installed. Install ffmpeg to optimize videos.');
    const job = GLib.build_filenamev([cacheRoot(), 'jobs', uniqueName()]);
    try {
        await makeDir(job, cancellable);
        const temp = `${job}/optimized.mp4`;
        let result = {status: 1, message: ''};
        if (await stat(RENDER_NODE, cancellable)) {
            result = await encode(media, geometry, temp, true, output, cancellable);
            if (result.status !== 0)
                logger.info(`VA-API encoding failed, using libx264: ${result.message}`);
        }
        if (result.status !== 0)
            result = await encode(media, geometry, temp, false, output, cancellable);
        if (result.status !== 0) {
            throw new CacheError('TRANSCODE_FAILED',
                `ffmpeg could not optimize ${media.path}: ${result.message || `exit status ${result.status}`}`);
        }
        await verify(media, geometry, temp, cancellable);
        await makeDir(GLib.path_get_dirname(output), cancellable);
        cancellable.set_error_if_cancelled();
        await Gio.File.new_for_path(temp).move_async(Gio.File.new_for_path(output),
            Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, null, null);
        return output;
    } finally {
        await removeTree(job);
    }
}

export async function ensureOptimized(media, geometry, {onProgress = null, cancellable = null} = {}) {
    cancellable?.set_error_if_cancelled();
    if (!canOptimize(geometry)) {
        throw new CacheError('INVALID_GEOMETRY',
            `${geometry.width}×${geometry.height} cannot be encoded as H.264 4:2:0; the original is played.`);
    }
    const output = optimizedPath(media, geometry);
    const existing = await stat(output, cancellable);
    if (existing?.get_file_type() === Gio.FileType.REGULAR && existing.get_size() > 0)
        return output;
    if (!listeners.has(output))
        listeners.set(output, new Set());
    const listener = onProgress ? fraction => onProgress(fraction) : null;
    if (listener)
        listeners.get(output).add(listener);
    try {
        return await work.run(output, shared => produce(media, geometry, output, shared), cancellable);
    } finally {
        const set = listeners.get(output);
        set?.delete(listener);
        if (set?.size === 0)
            listeners.delete(output);
    }
}
