import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {spawnAsync} from './async.js';
import {findProgram} from './deps.js';

const QUERY_ATTRIBUTES = 'standard::type,standard::size,time::modified,time::modified-usec';
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);
const HDR_SIDE_DATA = /mastering display|content light|dovi|dolby vision|hdr dynamic metadata/i;
const MAX_DIMENSION = 16384;
const CACHE_LIMIT = 64;

const results = new Map();
const pending = new Map();

export class ProbeError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ProbeError';
        this.code = code;
    }
}

function cancelledError() {
    return new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Operation was cancelled');
}

function tag(value) {
    return typeof value === 'string' && value && value !== 'unknown' ? value : null;
}

function ratio(value) {
    const match = /^(\d+)[:/](\d+)$/.exec(value ?? '');
    if (!match)
        return null;
    const [num, den] = [Number(match[1]), Number(match[2])];
    return num > 0 && den > 0 ? {num, den} : null;
}

function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function clockwiseRotation(stream) {
    const matrix = (stream.side_data_list ?? []).find(item => item.rotation !== undefined);
    const degrees = matrix ? -Number(matrix.rotation) : Number(stream.tags?.rotate ?? 0);
    if (!Number.isFinite(degrees) || degrees % 90 !== 0) {
        throw new ProbeError('INVALID_GEOMETRY',
            `Unsupported rotation of ${matrix?.rotation ?? stream.tags?.rotate}°: only multiples of 90° are supported.`);
    }
    return ((degrees % 360) + 360) % 360;
}

function isHdrStream(stream) {
    return HDR_TRANSFERS.has(stream.color_transfer) ||
        (stream.side_data_list ?? []).some(item => HDR_SIDE_DATA.test(item.side_data_type ?? ''));
}

export function parseProbe(output, {path, size, mtime}) {
    let data;
    try {
        data = JSON.parse(output);
    } catch {
        throw new ProbeError('FFPROBE_FAILED', `ffprobe returned invalid JSON for ${path}`);
    }
    const stream = (data?.streams ?? []).find(item =>
        item.codec_type === 'video' && !item.disposition?.attached_pic);
    if (!stream)
        throw new ProbeError('NO_VIDEO_STREAM', `${path} has no video stream.`);
    if (isHdrStream(stream)) {
        throw new ProbeError('UNSUPPORTED_HDR',
            'HDR video is not supported because tone mapping is not implemented. ' +
            'Choose an SDR (BT.709) version of this video.');
    }

    const codedWidth = stream.width;
    const codedHeight = stream.height;
    if (!Number.isInteger(codedWidth) || !Number.isInteger(codedHeight) ||
        codedWidth <= 0 || codedHeight <= 0) {
        throw new ProbeError('INVALID_GEOMETRY', `${path} has no valid frame size.`);
    }
    const sar = ratio(stream.sample_aspect_ratio) ?? {num: 1, den: 1};
    const rotation = clockwiseRotation(stream);
    const scaledWidth = Math.round(codedWidth * sar.num / sar.den);
    const [width, height] = rotation % 180 === 0
        ? [scaledWidth, codedHeight]
        : [codedHeight, scaledWidth];
    if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new ProbeError('INVALID_GEOMETRY',
            `${path} has an unsupported display size of ${width}×${height}.`);
    }

    const frameRate = ratio(stream.avg_frame_rate) ?? ratio(stream.r_frame_rate);
    return {
        path,
        size,
        mtime,
        width,
        height,
        codedWidth,
        codedHeight,
        sampleAspectRatio: `${sar.num}:${sar.den}`,
        rotation,
        colorPrimaries: tag(stream.color_primaries),
        colorTransfer: tag(stream.color_transfer),
        colorSpace: tag(stream.color_space),
        colorRange: tag(stream.color_range),
        isHdr: false,
        durationSec: positiveNumber(data.format?.duration) ?? positiveNumber(stream.duration),
        codec: stream.codec_name ?? null,
        frameRate: frameRate ? frameRate.num / frameRate.den : null,
        isGif: String(data.format?.format_name ?? '').split(',').includes('gif'),
        hasVideo: true,
    };
}

async function queryFile(path, cancellable) {
    const file = Gio.File.new_for_path(path);
    let info;
    try {
        info = await file.query_info_async(QUERY_ATTRIBUTES, Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable);
    } catch (error) {
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw new ProbeError('NOT_FOUND', `${path} does not exist.`);
        throw error;
    }
    if (info.get_file_type() !== Gio.FileType.REGULAR)
        throw new ProbeError('NOT_REGULAR', `${path} is not a regular file.`);
    const mtime = info.get_attribute_uint64('time::modified') * 1e6 +
        info.get_attribute_uint32('time::modified-usec');
    return {path: file.get_path(), size: info.get_size(), mtime};
}

async function runFfprobe(identity, cancellable) {
    const ffprobe = findProgram('ffprobe');
    if (!ffprobe)
        throw new ProbeError('FFPROBE_MISSING', 'ffprobe is not installed. Install ffmpeg to validate videos.');
    const {status, stdout, stderr} = await spawnAsync([ffprobe, '-v', 'error', '-print_format', 'json',
        '-show_streams', '-show_format', '-select_streams', 'v:0', `file:${identity.path}`],
    {cancellable});
    if (status !== 0) {
        const detail = stderr.trim().split('\n').pop();
        throw new ProbeError('FFPROBE_FAILED', `ffprobe could not read ${identity.path}${detail ? `: ${detail}` : ''}`);
    }
    return parseProbe(stdout, identity);
}

function remember(key, result) {
    results.delete(key);
    results.set(key, result);
    if (results.size > CACHE_LIMIT)
        results.delete(results.keys().next().value);
}

function shared(key, identity) {
    let entry = pending.get(key);
    if (entry)
        return entry;
    const cancellable = new Gio.Cancellable();
    entry = {cancellable, waiters: 0};
    entry.promise = runFfprobe(identity, cancellable).then(result => {
        if (!cancellable.is_cancelled())
            remember(key, result);
        return result;
    }).finally(() => {
        if (pending.get(key) === entry)
            pending.delete(key);
    });
    entry.promise.catch(() => {});
    pending.set(key, entry);
    return entry;
}

async function join(key, entry, cancellable) {
    entry.waiters++;
    let handlerId = 0;
    try {
        const cancelled = new Promise((_, reject) => {
            handlerId = cancellable?.connect(() => reject(cancelledError())) ?? 0;
        });
        return await Promise.race([entry.promise, cancelled]);
    } finally {
        if (handlerId)
            cancellable.disconnect(handlerId);
        if (--entry.waiters === 0 && pending.get(key) === entry) {
            pending.delete(key);
            entry.cancellable.cancel();
        }
    }
}

export async function probe(path, cancellable = null) {
    cancellable?.set_error_if_cancelled();
    const identity = await queryFile(path, cancellable);
    cancellable?.set_error_if_cancelled();
    const key = `${identity.path}|${identity.size}|${identity.mtime}`;
    const cached = results.get(key);
    if (cached)
        return {...cached};
    return {...await join(key, shared(key, identity), cancellable)};
}

export function clearProbeCache() {
    results.clear();
}
