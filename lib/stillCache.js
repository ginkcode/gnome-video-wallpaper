import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {spawnAsync} from './async.js';
import {cacheKey} from './cacheKey.js';
import {findProgram} from './deps.js';
import {FitMode, ffmpegScaleFilter} from './geometry.js';
import {createLogger} from './log.js';
import {SharedWork} from './sharedWork.js';

for (const method of ['copy_async', 'move_async', 'delete_async', 'enumerate_children_async',
    'load_contents_async'])
    Gio._promisify(Gio.File.prototype, method);
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const APP = 'gink-video-wallpaper';
const STAT = 'standard::type,standard::size,time::modified,time::modified-usec,unix::nlink';
const COMPLETED = ['stills', 'spanned', 'media'];
const MATRICES = {
    bt709: 'bt709', smpte170m: 'smpte170m', bt470bg: 'bt470', fcc: 'fcc', smpte240m: 'smpte240m',
    bt2020nc: 'bt2020', bt2020c: 'bt2020',
};
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const logger = createLogger('still-cache');
const references = new Map();
const producers = new Map();
const stills = new SharedWork();

export class CacheError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'CacheError';
        this.code = code;
    }
}

function xdgDir(variable, fallback) {
    const value = GLib.getenv(variable);
    return GLib.build_filenamev([value && GLib.path_is_absolute(value)
        ? value
        : GLib.build_filenamev([GLib.get_home_dir(), ...fallback]), APP]);
}

export function cacheRoot() {
    return xdgDir('XDG_CACHE_HOME', ['.cache']);
}

export function wallpaperDir() {
    return GLib.build_filenamev([xdgDir('XDG_DATA_HOME', ['.local', 'share']), 'wallpapers']);
}

function uniqueName() {
    return `${new Gio.Credentials().get_unix_pid()}-${GLib.uuid_string_random()}`;
}

function isIoError(error, code) {
    return error instanceof GLib.Error && error.matches(Gio.io_error_quark(), code);
}

async function makeDir(path, cancellable) {
    const file = Gio.File.new_for_path(path);
    try {
        await file.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable);
    } catch (error) {
        if (isIoError(error, Gio.IOErrorEnum.EXISTS))
            return;
        if (!isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
            throw error;
        await makeDir(file.get_parent().get_path(), cancellable);
        await makeDir(path, cancellable);
    }
}

async function stat(path, cancellable, flags = Gio.FileQueryInfoFlags.NONE) {
    try {
        return await Gio.File.new_for_path(path).query_info_async(STAT, flags,
            GLib.PRIORITY_DEFAULT, cancellable);
    } catch (error) {
        if (isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
            return null;
        throw error;
    }
}

function fileIdentity(info) {
    return {
        size: info.get_size(),
        mtime: info.get_attribute_uint64('time::modified') * 1e6 +
            info.get_attribute_uint32('time::modified-usec'),
    };
}

async function children(path, cancellable) {
    let enumerator;
    try {
        enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
            `standard::name,${STAT}`, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_LOW, cancellable);
    } catch (error) {
        if (isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
            return [];
        throw error;
    }
    const infos = [];
    for (;;) {
        const batch = await enumerator.next_files_async(64, GLib.PRIORITY_LOW, cancellable);
        if (batch.length === 0)
            break;
        infos.push(...batch);
    }
    return infos;
}

async function removeFile(path) {
    try {
        await Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null);
    } catch (error) {
        if (!isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
            throw error;
    }
}

async function removeTree(path) {
    for (const info of await children(path, null)) {
        const child = GLib.build_filenamev([path, info.get_name()]);
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            await removeTree(child);
        else
            await removeFile(child);
    }
    await removeFile(path);
}

async function treeSize(path) {
    let total = 0;
    for (const info of await children(path, null)) {
        total += info.get_file_type() === Gio.FileType.DIRECTORY
            ? await treeSize(GLib.build_filenamev([path, info.get_name()]))
            : info.get_size();
    }
    return total;
}

async function linkOrCopy(source, dest, cancellable) {
    const {status} = await spawnAsync(['ln', '-L', '-T', '--', source, dest],
        {cancellable, stdout: false, stderr: false});
    if (status === 0)
        return true;
    try {
        await Gio.File.new_for_path(source).copy_async(Gio.File.new_for_path(dest),
            Gio.FileCopyFlags.ALL_METADATA, GLib.PRIORITY_LOW, cancellable, null);
        return true;
    } catch (error) {
        await removeFile(dest);
        if (isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
            return false;
        throw error;
    }
}

async function acquireReference(source, expected, dest, cancellable) {
    const before = await stat(source, cancellable);
    if (!before || before.get_file_type() !== Gio.FileType.REGULAR)
        return null;
    const identity = fileIdentity(before);
    if (expected && (identity.size !== expected.size || identity.mtime !== expected.mtime))
        throw new CacheError('SOURCE_CHANGED', `${source} changed after it was probed; probe it again.`);
    if (!await linkOrCopy(source, dest, cancellable))
        return null;
    const after = await stat(dest, cancellable);
    if (!after || after.get_size() !== identity.size || fileIdentity(after).mtime !== identity.mtime) {
        await removeFile(dest);
        throw new CacheError('SOURCE_CHANGED', `${source} changed while it was being acquired.`);
    }
    return {path: dest, ...identity};
}

function validateGeometry(geometry) {
    const {width, height, scale, fitMode, transformVersion} = geometry ?? {};
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
        throw new CacheError('INVALID_GEOMETRY', 'Target geometry needs positive integer raster width/height.');
    if (!Number.isFinite(scale) || scale <= 0 || !Number.isInteger(transformVersion) ||
        !Object.values(FitMode).includes(fitMode))
        throw new CacheError('INVALID_GEOMETRY', 'Target geometry needs scale, fitMode and transformVersion.');
}

function geometryLabel({width, height, scale, fitMode, transformVersion}) {
    return `${width}x${height}@${scale}|${fitMode}|v${transformVersion}`;
}

export async function acquirePlaybackAsset(media, geometry, {optimizedPath = null, cancellable = null} = {}) {
    cancellable?.set_error_if_cancelled();
    validateGeometry(geometry);
    const directory = GLib.build_filenamev([cacheRoot(), 'refs', uniqueName()]);
    try {
        await makeDir(directory, cancellable);
        let kind = 'optimized';
        let reference = optimizedPath
            ? await acquireReference(optimizedPath, null, `${directory}/optimized`, cancellable)
            : null;
        if (!reference) {
            kind = 'original';
            reference = await acquireReference(media.path, media, `${directory}/original`, cancellable);
        }
        if (!reference)
            throw new CacheError('SOURCE_MISSING', `${media.path} no longer exists; choose the video again.`);
        cancellable?.set_error_if_cancelled();
        const sourcePath = kind === 'optimized' ? optimizedPath : media.path;
        const asset = {
            path: reference.path,
            identity: `${kind}:${sourcePath}|${reference.size}|${reference.mtime}|${geometryLabel(geometry)}`,
            geometryBaked: kind === 'optimized',
            source: media,
            geometry: {...geometry},
        };
        references.set(asset, directory);
        return asset;
    } catch (error) {
        await removeTree(directory);
        throw error;
    }
}

export function releasePlaybackAsset(asset) {
    const directory = references.get(asset);
    if (!directory)
        return Promise.resolve();
    references.delete(asset);
    return removeTree(directory).catch(error => logger.warn(`release failed: ${error.message}`));
}

function colorInput(source) {
    if (!source || source.isGif || source.codec === 'gif')
        return '';
    const guess = (source.codedWidth ?? source.width) >= 1280 || (source.codedHeight ?? source.height) > 576
        ? 'bt709'
        : 'bt601';
    const matrix = source.colorSpace ? MATRICES[source.colorSpace] ?? 'auto' : guess;
    const range = source.colorRange === 'pc' ? 'full' : 'tv';
    return `:in_color_matrix=${matrix}:in_range=${range}`;
}

export function stillFilter(asset, geometry) {
    const input = colorInput(asset.source);
    if (asset.geometryBaked)
        return `scale=iw:ih${input},setsar=1`;
    return `scale=round(iw*sar):ih:flags=lanczos${input},setsar=1,` +
        `${ffmpegScaleFilter(geometry.width, geometry.height, geometry.fitMode)},setsar=1`;
}

async function pngInfo(path, cancellable) {
    const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
    if (bytes.length < 24 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value))
        throw new CacheError('INVALID_STILL', `${path} is not a complete PNG.`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        width: view.getUint32(16),
        height: view.getUint32(20),
        sha256: GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes),
    };
}

function lowPriority() {
    const nice = findProgram('nice');
    return nice ? [nice, '-n', '19'] : [];
}

async function produceStill(asset, geometry, output, cancellable) {
    const ffmpeg = findProgram('ffmpeg');
    if (!ffmpeg)
        throw new CacheError('FFMPEG_MISSING', 'ffmpeg is not installed. Install ffmpeg to create wallpaper stills.');
    const job = GLib.build_filenamev([cacheRoot(), 'jobs', uniqueName()]);
    try {
        await makeDir(job, cancellable);
        const temp = `${job}/still.png`;
        const {status, stderr} = await spawnAsync([...lowPriority(), ffmpeg, '-hide_banner', '-loglevel', 'error',
            '-nostdin', '-y', '-threads', '2', '-i', `file:${asset.path}`, '-map', '0:v:0',
            '-frames:v', '1', '-vf', stillFilter(asset, geometry), '-c:v', 'png', `file:${temp}`],
        {cancellable, stdout: false});
        if (status !== 0) {
            throw new CacheError('FFMPEG_FAILED',
                `ffmpeg could not extract a still from ${asset.source?.path ?? asset.path}: ${stderr.trim()}`);
        }
        const {width, height} = await pngInfo(temp, cancellable);
        if (width !== geometry.width || height !== geometry.height) {
            throw new CacheError('INVALID_GEOMETRY',
                `Still is ${width}×${height}, expected ${geometry.width}×${geometry.height}.`);
        }
        await makeDir(GLib.path_get_dirname(output), cancellable);
        cancellable.set_error_if_cancelled();
        await Gio.File.new_for_path(temp).move_async(Gio.File.new_for_path(output),
            Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, null, null);
        return output;
    } finally {
        await removeTree(job);
    }
}

export function stillKey(asset, geometry) {
    const {path, size, mtime} = asset.source;
    return cacheKey({path, size, mtime, width: geometry.width, height: geometry.height,
        scale: geometry.scale, fitMode: geometry.fitMode, transformVersion: geometry.transformVersion,
        kind: 'still', assetIdentity: asset.identity});
}

export async function ensureStill(asset, geometry = asset?.geometry, cancellable = null) {
    cancellable?.set_error_if_cancelled();
    if (!references.has(asset))
        throw new CacheError('NOT_ACQUIRED', 'Stills are extracted only from an acquired playback asset.');
    validateGeometry(geometry);
    const output = GLib.build_filenamev([cacheRoot(), 'stills', `${stillKey(asset, geometry)}.png`]);
    const existing = await stat(output, cancellable);
    cancellable?.set_error_if_cancelled();
    const path = existing?.get_file_type() === Gio.FileType.REGULAR && existing.get_size() > 0
        ? output
        : await stills.run(output, shared => produceStill(asset, geometry, output, shared), cancellable);
    producers.set(path, {asset, geometry});
    return path;
}

async function acquireStillInput(stillPath, input, cancellable) {
    if (await linkOrCopy(stillPath, input, cancellable))
        return;
    const producer = producers.get(stillPath);
    if (!producer || !references.has(producer.asset))
        throw new CacheError('STILL_MISSING', `${stillPath} was removed and its playback asset is no longer held.`);
    const regenerated = await ensureStill(producer.asset, producer.geometry, cancellable);
    if (!await linkOrCopy(regenerated, input, cancellable))
        throw new CacheError('STILL_MISSING', `${stillPath} was removed again while publishing.`);
}

export async function publishWallpaper(stillPath, cancellable = null) {
    cancellable?.set_error_if_cancelled();
    const job = GLib.build_filenamev([cacheRoot(), 'jobs', uniqueName()]);
    try {
        await makeDir(job, cancellable);
        const input = `${job}/input.png`;
        await acquireStillInput(stillPath, input, cancellable);
        const {sha256} = await pngInfo(input, cancellable);
        const directory = wallpaperDir();
        await makeDir(directory, cancellable);
        const target = GLib.build_filenamev([directory, `${sha256}.png`]);
        if ((await stat(target, cancellable))?.get_size() > 0)
            return target;
        const temp = GLib.build_filenamev([directory, `.${uniqueName()}.tmp`]);
        try {
            await Gio.File.new_for_path(input).copy_async(Gio.File.new_for_path(temp),
                Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, null);
            cancellable?.set_error_if_cancelled();
            await Gio.File.new_for_path(temp).move_async(Gio.File.new_for_path(target),
                Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, null, null);
        } catch (error) {
            await removeFile(temp);
            throw error;
        }
        return target;
    } finally {
        await removeTree(job);
    }
}

async function processAlive(name) {
    const pid = Number.parseInt(name, 10);
    return Number.isInteger(pid) && pid > 0 && Boolean(await stat(`/proc/${pid}`, null));
}

export async function clearCache(cancellable = null) {
    cancellable?.set_error_if_cancelled();
    const root = cacheRoot();
    let removedBytes = 0;
    let preservedActiveBytes = 0;
    for (const kind of COMPLETED) {
        for (const info of await children(GLib.build_filenamev([root, kind]), cancellable)) {
            if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_name().startsWith('.'))
                continue;
            if (info.get_attribute_uint32('unix::nlink') > 1) {
                preservedActiveBytes += info.get_size();
                continue;
            }
            cancellable?.set_error_if_cancelled();
            await removeFile(GLib.build_filenamev([root, kind, info.get_name()]));
            removedBytes += info.get_size();
        }
    }
    for (const kind of ['refs', 'jobs']) {
        for (const info of await children(GLib.build_filenamev([root, kind]), cancellable)) {
            const path = GLib.build_filenamev([root, kind, info.get_name()]);
            if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;
            if (await processAlive(info.get_name()))
                preservedActiveBytes += await treeSize(path);
            else
                await removeTree(path);
        }
    }
    let preservedWallpaperBytes = 0;
    for (const info of await children(wallpaperDir(), cancellable)) {
        if (info.get_file_type() === Gio.FileType.REGULAR && !info.get_name().startsWith('.'))
            preservedWallpaperBytes += info.get_size();
    }
    return {removedBytes, preservedActiveBytes, preservedWallpaperBytes};
}
