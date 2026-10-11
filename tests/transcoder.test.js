import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {findProgram} from '../lib/deps.js';
import {FitMode, TRANSFORM_VERSION} from '../lib/geometry.js';
import {probe} from '../lib/mediaProbe.js';
import {assertDeepEqual, assertEqual, run, test} from './harness.js';

const root = GLib.dir_make_tmp('gink-vw-transcode-XXXXXX');
GLib.setenv('XDG_CACHE_HOME', `${root}/cache`, true);
const {CacheError, acquirePlaybackAsset, cacheRoot, ensureStill, releasePlaybackAsset} =
    await import('../lib/stillCache.js');
const {canOptimize, colorPlan, ensureOptimized, optimizedPath, shouldOptimize} =
    await import('../lib/transcoder.js');

const decoder = new TextDecoder();

function geometry(fitMode, width = 64, height = 64) {
    return {width, height, scale: 1, fitMode, transformVersion: TRANSFORM_VERSION};
}

function spawn(argv) {
    const [, stdout, stderr, status] = GLib.spawn_sync(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
    if (status !== 0)
        throw new Error(`${argv[0]} failed: ${decoder.decode(stderr)}`);
    return decoder.decode(stdout);
}

function ffmpeg(name, ...args) {
    const path = `${root}/${name}`;
    spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args, path]);
    return path;
}

function pixel(path, x, y) {
    const raw = `${root}/pixel.rgb`;
    spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-frames:v', '1',
        '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
    return [...GLib.file_get_contents(raw)[1]];
}

function frameTimes(path) {
    return spawn(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time',
        '-of', 'csv=p=0', path]).trim().split('\n').map(line => Number(line.split(',')[0]));
}

function list(path) {
    if (!GLib.file_test(path, GLib.FileTest.IS_DIR))
        return [];
    const enumerator = Gio.File.new_for_path(path).enumerate_children('standard::name', 0, null);
    const names = [];
    for (let info; (info = enumerator.next_file(null));)
        names.push(info.get_name());
    return names;
}

function isBlack(rgb) {
    return rgb.every(value => value < 24);
}

async function expectCancelled(promise) {
    try {
        await promise;
    } catch (error) {
        if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        throw error;
    }
    throw new Error('expected cancellation');
}

test('optimization choices and identity', () => {
    const media = {path: '/v.mp4', size: 10, mtime: 5, isGif: false};
    assertEqual(shouldOptimize({...media, isGif: true}, {optimize: false}, false), true, 'gif always');
    assertEqual(shouldOptimize(media, {optimize: null}, true), true, 'default on');
    assertEqual(shouldOptimize(media, {optimize: false}, true), false, 'monitor off');
    assertEqual(shouldOptimize(media, {}, false), false, 'default off');
    assertEqual(canOptimize(geometry(FitMode.FILL, 1366, 768)), true);
    assertEqual(canOptimize(geometry(FitMode.FILL, 1367, 768)), false);
    const base = optimizedPath(media, geometry(FitMode.FILL));
    assertEqual(base.startsWith(`${cacheRoot()}/media/`) && base.endsWith('.mp4'), true, 'location');
    const variants = [
        optimizedPath(media, geometry(FitMode.FIT)),
        optimizedPath(media, {...geometry(FitMode.FILL), transformVersion: TRANSFORM_VERSION + 1}),
        optimizedPath(media, geometry(FitMode.FILL, 64, 32)),
        optimizedPath({...media, mtime: 6}, geometry(FitMode.FILL)),
        optimizedPath(media, {...geometry(FitMode.FILL), scale: 2}),
    ];
    assertEqual(new Set([base, ...variants]).size, 6, 'distinct identities');
    assertEqual(optimizedPath({...media}, geometry(FitMode.FILL)), base, 'stable');
});

test('color plan keeps the SDR interpretation', () => {
    assertDeepEqual(colorPlan({codec: 'h264', width: 1920, height: 1080, colorSpace: 'bt709', colorRange: 'pc',
        colorPrimaries: 'bt709', colorTransfer: 'bt709'}).tags,
    {colorspace: 'bt709', range: 'tv', color_primaries: 'bt709', color_trc: 'bt709'});
    const sd = colorPlan({codec: 'h264', width: 640, height: 480});
    assertEqual(sd.filter, ':out_color_matrix=bt601:out_range=tv');
    assertEqual(sd.tags.colorspace, 'smpte170m');
    assertEqual(colorPlan({codec: 'h264', width: 640, height: 480, colorSpace: 'bt2020nc'}).tags.colorspace,
        'bt709', 'unsupported matrix converted');
    assertEqual(colorPlan({isGif: true, codec: 'gif'}).tags.colorspace, 'bt709');
});

if (findProgram('ffmpeg') && findProgram('ffprobe')) {
    test('GIF timing survives optimization', async () => {
        const gif = ffmpeg('timing.gif', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10:duration=2',
            '-vf', 'setpts=(N+if(gte(N\\,10)\\,(N-10)*1.5\\,0))*0.1/TB', '-fps_mode', 'passthrough');
        const media = await probe(gif);
        const progress = [];
        const out = await ensureOptimized(media, geometry(FitMode.FILL, 128, 96),
            {onProgress: value => progress.push(value)});
        const result = await probe(out);
        assertDeepEqual([result.codec, result.width, result.height, result.colorSpace, result.colorRange],
            ['h264', 128, 96, 'bt709', 'tv']);
        const source = frameTimes(gif);
        const optimized = frameTimes(out);
        assertEqual(optimized.length, source.length, 'frame count');
        optimized.forEach((time, index) =>
            assertEqual(Math.abs(time - source[index]) < 0.011, true, `frame ${index} at ${time}`));
        assertEqual(progress.at(-1), 1, 'final progress');
        assertDeepEqual(list(`${cacheRoot()}/jobs`), [], 'no temp left');
    });

    test('SAR and rotation are baked into the target geometry', async () => {
        const wide = ffmpeg('sar.mp4', '-f', 'lavfi', '-i', 'color=c=white:size=100x100:rate=5:duration=1',
            '-vf', 'setsar=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
        const sar = await ensureOptimized(await probe(wide), geometry(FitMode.FIT, 128, 128));
        assertEqual(isBlack(pixel(sar, 64, 4)), true, 'letterbox from SAR');
        assertEqual(isBlack(pixel(sar, 64, 64)), false, 'content');
        assertEqual((await probe(sar)).sampleAspectRatio, '1:1');

        const base = ffmpeg('base.mp4', '-f', 'lavfi', '-i', 'color=c=white:size=128x64:rate=5:duration=1',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
        const rotated = ffmpeg('rotated.mp4', '-display_rotation', '90', '-i', base, '-c', 'copy');
        const media = await probe(rotated);
        assertEqual(media.rotation % 180, 90, 'sample rotated');
        const out = await ensureOptimized(media, geometry(FitMode.FIT, 128, 64));
        assertEqual((await probe(out)).rotation, 0, 'no rotation left');
        assertEqual(isBlack(pixel(out, 4, 32)), true, 'pillarbox from rotation');
        assertEqual(isBlack(pixel(out, 64, 32)), false, 'content');
    });

    test('cancelling one caller keeps shared work; cancelling all leaves no temp', async () => {
        const long = ffmpeg('long.mp4', '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30:duration=20',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
        const media = await probe(long);
        const target = geometry(FitMode.FILL, 320, 240);
        const first = new Gio.Cancellable();
        const progress = {a: 0, b: 0};
        const a = ensureOptimized(media, target, {cancellable: first, onProgress: () => progress.a++});
        const b = ensureOptimized(media, target, {onProgress: () => progress.b++});
        while (list(`${cacheRoot()}/jobs`).length === 0)
            await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => resolve()));
        assertEqual(list(`${cacheRoot()}/jobs`).length, 1, 'one shared job');
        first.cancel();
        await expectCancelled(a);
        const out = await b;
        assertEqual(out, optimizedPath(media, target));
        assertEqual(progress.b > 0, true, 'surviving caller got progress');
        assertEqual((await probe(out)).width, 320);

        const other = geometry(FitMode.FIT, 320, 240);
        const cancellable = new Gio.Cancellable();
        const pending = ensureOptimized(media, other, {cancellable,
            onProgress: value => value > 0.05 && cancellable.cancel()});
        await expectCancelled(pending);
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => resolve()));
        assertDeepEqual(list(`${cacheRoot()}/jobs`), [], 'job removed');
        assertEqual(GLib.file_test(optimizedPath(media, other), GLib.FileTest.EXISTS), false, 'not published');
        const [, , , status] = GLib.spawn_sync(null, ['pgrep', '-f', `${cacheRoot()}/jobs`], null,
            GLib.SpawnFlags.SEARCH_PATH, null);
        assertEqual(status !== 0, true, 'ffmpeg exited');
    });

    test('deleted optimized media keeps playback and falls back to the original', async () => {
        const source = ffmpeg('fallback.mp4', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10:duration=1',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
        const media = await probe(source);
        const target = geometry(FitMode.FILL, 64, 64);
        const optimized = await ensureOptimized(media, target);
        const held = await acquirePlaybackAsset(media, target, {optimizedPath: optimized});
        assertEqual(held.geometryBaked, true, 'optimized acquired');
        const heldStill = await ensureStill(held);
        Gio.File.new_for_path(optimized).delete(null);
        assertEqual((await probe(held.path)).width, 64, 'private reference still playable');
        const later = await acquirePlaybackAsset(media, target, {optimizedPath: optimized});
        assertEqual(later.geometryBaked, false, 'original fallback');
        assertEqual(later.identity.startsWith('original:'), true);
        const laterStill = await ensureStill(later);
        assertEqual(laterStill !== heldStill, true, 'still follows the acquired asset');
        await releasePlaybackAsset(held);
        await releasePlaybackAsset(later);
    });

    test('odd raster sizes are refused before ffmpeg runs', async () => {
        try {
            await ensureOptimized({path: '/missing', size: 1, mtime: 1}, geometry(FitMode.FILL, 63, 64));
        } catch (error) {
            assertEqual(error instanceof CacheError && error.code, 'INVALID_GEOMETRY');
            return;
        }
        throw new Error('expected INVALID_GEOMETRY');
    });
}

try {
    await run();
} finally {
    Gio.Subprocess.new(['rm', '-rf', root], Gio.SubprocessFlags.NONE).wait(null);
}
