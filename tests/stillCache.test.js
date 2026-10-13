import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {sleep} from '../lib/async.js';
import {findProgram} from '../lib/deps.js';
import {FitMode, TRANSFORM_VERSION} from '../lib/geometry.js';
import {probe} from '../lib/mediaProbe.js';
import {assertEqual, run, test} from './harness.js';

const root = GLib.dir_make_tmp('gink-vw-still-XXXXXX');
GLib.setenv('XDG_CACHE_HOME', `${root}/cache`, true);
GLib.setenv('XDG_DATA_HOME', `${root}/data`, true);
const cache = await import('../lib/stillCache.js');
const {
    CacheError, acquirePlaybackAsset, cacheRoot, clearCache, ensureNativeStill, ensureStill, publishWallpaper,
    releasePlaybackAsset, stillFilter, wallpaperDir,
} = cache;

const ffmpeg = findProgram('ffmpeg');
const decoder = new TextDecoder();

function geometry(fitMode, width = 64, height = 64) {
    return {width, height, scale: 1, fitMode, transformVersion: TRANSFORM_VERSION};
}

function spawn(argv) {
    const [, stdout, stderr, status] = GLib.spawn_sync(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
    if (status !== 0)
        throw new Error(`${argv[0]} failed: ${decoder.decode(stderr)}`);
    return stdout;
}

function encode(name, input, args = []) {
    const path = `${root}/${name}`;
    spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', input,
        ...args, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path]);
    return path;
}

function pixel(path, x = 0, y = 0) {
    const raw = `${root}/pixel.rgb`;
    spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-frames:v', '1',
        '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
    return [...GLib.file_get_contents(raw)[1]];
}

function size(path) {
    const out = decoder.decode(spawn(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path])).trim();
    return out.replace(',', 'x');
}

function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

function list(path) {
    if (!exists(path))
        return [];
    const enumerator = Gio.File.new_for_path(path).enumerate_children('standard::name', 0, null);
    const names = [];
    let info;
    while ((info = enumerator.next_file(null)))
        names.push(info.get_name());
    return names;
}

async function expectCode(promise, code) {
    try {
        await promise;
    } catch (error) {
        if (!(error instanceof CacheError))
            throw error;
        assertEqual(error.code, code, 'error code');
        return;
    }
    throw new Error(`expected CacheError ${code}`);
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

if (ffmpeg && findProgram('ffprobe')) {
    const source = encode('wide.mp4', 'testsrc2=size=96x48:rate=10:duration=1');
    const media = await probe(source);

    test('native stills keep the source display size without fitting', async () => {
        const anamorphic = encode('anamorphic.mp4', 'testsrc2=size=64x48:rate=10:duration=1',
            ['-vf', 'setsar=2']);
        const source = await probe(anamorphic);
        const first = await ensureNativeStill(source);
        assertEqual(size(first), '128x48', 'sample aspect ratio applied without fitting');
        assertEqual(await ensureNativeStill(source), first, 'cached');
        assertEqual(await ensureNativeStill(media) !== first, true, 'source joins identity');
        assertEqual(size(await ensureNativeStill(media)), '96x48');
        await clearCache();
        const published = await publishWallpaper(first);
        assertEqual(size(published), '128x48', 'regenerated after clear');
        const cancel = new Gio.Cancellable();
        await clearCache();
        const pending = ensureNativeStill(source, cancel);
        const survivor = ensureNativeStill(source);
        await sleep(5);
        cancel.cancel();
        await expectCancelled(pending);
        assertEqual(size(await survivor), '128x48', 'shared survivor');
        GLib.usleep(10000);
        encode('anamorphic.mp4', 'testsrc2=size=32x48:rate=10:duration=1');
        await clearCache();
        await expectCode(ensureNativeStill(source), 'SOURCE_CHANGED');
        await sleep(200);
        assertEqual(list(`${cacheRoot()}/jobs`).length, 0, 'jobs cleaned');
    });

    test('stills match the raster geometry for fill, fit and stretch', async () => {
        for (const mode of [FitMode.FILL, FitMode.FIT, FitMode.STRETCH]) {
            const asset = await acquirePlaybackAsset(media, geometry(mode, 80, 60));
            try {
                const still = await ensureStill(asset, asset.geometry);
                assertEqual(size(still), '80x60', mode);
                assertEqual(still.startsWith(`${cacheRoot()}/stills/`), true, 'cache location');
            } finally {
                await releasePlaybackAsset(asset);
            }
        }
        const fit = await acquirePlaybackAsset(media, geometry(FitMode.FIT, 80, 80));
        assertEqual(pixel(await ensureStill(fit, fit.geometry)).join(), '0,0,0', 'fit pads with black');
        await releasePlaybackAsset(fit);
    });

    test('second call is cached without spawning ffmpeg', async () => {
        const asset = await acquirePlaybackAsset(media, geometry(FitMode.FILL));
        const first = await ensureStill(asset, asset.geometry);
        const path = GLib.getenv('PATH');
        GLib.setenv('PATH', `${root}/no-programs`, true);
        try {
            assertEqual(await ensureStill(asset, asset.geometry), first, 'cached path');
        } finally {
            GLib.setenv('PATH', path, true);
            await releasePlaybackAsset(asset);
        }
    });

    test('mtime, fit mode, transform version and asset choice change the still', async () => {
        const copy = `${root}/copy.mp4`;
        Gio.File.new_for_path(source).copy(Gio.File.new_for_path(copy), 0, null, null);
        const original = await probe(copy);
        const paths = new Set();
        const variants = [
            [original, geometry(FitMode.FILL), null],
            [original, geometry(FitMode.FIT), null],
            [original, {...geometry(FitMode.FILL), transformVersion: TRANSFORM_VERSION + 1}, null],
        ];
        for (const [item, target, optimizedPath] of variants) {
            const asset = await acquirePlaybackAsset(item, target, {optimizedPath});
            paths.add(await ensureStill(asset, target));
            await releasePlaybackAsset(asset);
        }
        GLib.usleep(10000);
        spawn(['touch', copy]);
        const touched = await probe(copy);
        const asset = await acquirePlaybackAsset(touched, geometry(FitMode.FILL));
        paths.add(await ensureStill(asset, asset.geometry));
        await releasePlaybackAsset(asset);
        assertEqual(paths.size, 4, 'distinct stills');
    });

    test('baked optimized media is not fitted again; missing optimized falls back', async () => {
        const optimized = encode('optimized.mp4', 'testsrc2=size=64x40:rate=10:duration=1');
        for (const mode of [FitMode.FIT, FitMode.STRETCH]) {
            const target = geometry(mode, 64, 40);
            const asset = await acquirePlaybackAsset(media, target, {optimizedPath: optimized});
            assertEqual(asset.geometryBaked, true, 'baked');
            assertEqual(asset.identity.startsWith('optimized:'), true, 'optimized identity');
            assertEqual(/force_original|pad=|crop=/.test(stillFilter(asset, target)), false, 'no refit');
            assertEqual(size(await ensureStill(asset, target)), '64x40', `${mode} size`);
            await expectCode(ensureStill(asset, geometry(mode, 80, 60)), 'INVALID_GEOMETRY');
            await releasePlaybackAsset(asset);
        }
        const fallback = await acquirePlaybackAsset(media, geometry(FitMode.FIT),
            {optimizedPath: `${root}/deleted.mp4`});
        assertEqual(fallback.geometryBaked, false, 'original not baked');
        assertEqual(fallback.identity.startsWith(`original:${source}|`), true, 'original identity');
        assertEqual(size(await ensureStill(fallback, fallback.geometry)), '64x64', 'original still');
        await releasePlaybackAsset(fallback);
    });

    test('GIF still is the first frame', async () => {
        const gif = `${root}/frames.gif`;
        spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
            '-f', 'lavfi', '-i', 'color=c=red:s=64x48:r=10:d=0.3',
            '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=10:d=0.7',
            '-filter_complex', '[0][1]concat=n=2:v=1', gif]);
        const asset = await acquirePlaybackAsset(await probe(gif), geometry(FitMode.STRETCH, 32, 24));
        const [r, g, b] = pixel(await ensureStill(asset, asset.geometry));
        assertEqual(r > 200 && g < 50 && b < 50, true, `first frame is red, got ${[r, g, b]}`);
        await releasePlaybackAsset(asset);
    });

    test('source replacement and deletion are detected at acquisition', async () => {
        const before = list(`${cacheRoot()}/refs`).length;
        const path = encode('replaced.mp4', 'testsrc2=size=96x48:rate=10:duration=1');
        const stale = await probe(path);
        GLib.usleep(10000);
        encode('replaced.mp4', 'testsrc2=size=64x48:rate=10:duration=1');
        await expectCode(acquirePlaybackAsset(stale, geometry(FitMode.FILL)), 'SOURCE_CHANGED');
        GLib.unlink(path);
        await expectCode(acquirePlaybackAsset(stale, geometry(FitMode.FILL)), 'SOURCE_MISSING');
        assertEqual(list(`${cacheRoot()}/refs`).length, before, 'failed acquisitions leave no references');
    });

    test('references are private and release only their own copy', async () => {
        const deleted = encode('private.mp4', 'testsrc2=size=96x48:rate=10:duration=1');
        const item = await probe(deleted);
        const a = await acquirePlaybackAsset(item, geometry(FitMode.FILL));
        const b = await acquirePlaybackAsset(item, geometry(FitMode.FILL));
        assertEqual(a.path !== b.path, true, 'distinct references');
        GLib.unlink(deleted);
        await releasePlaybackAsset(a);
        assertEqual(exists(a.path), false, 'released reference removed');
        assertEqual(exists(b.path), true, 'other reference intact');
        assertEqual(size(await ensureStill(b, b.geometry)), '64x64', 'still from held bytes');
        await releasePlaybackAsset(b);
        await expectCode(ensureStill(b, b.geometry), 'NOT_ACQUIRED');
    });

    test('clear cache keeps active references and published wallpapers', async () => {
        const entry = `${cacheRoot()}/media/active.mp4`;
        GLib.mkdir_with_parents(GLib.path_get_dirname(entry), 0o755);
        Gio.File.new_for_path(source).copy(Gio.File.new_for_path(entry), 0, null, null);
        const active = await acquirePlaybackAsset(media, geometry(FitMode.FIT, 96, 48), {optimizedPath: entry});
        const still = await ensureStill(active, active.geometry);
        const published = await publishWallpaper(still);
        assertEqual(published.startsWith(`${wallpaperDir()}/`), true, 'published outside cache');
        const result = await clearCache();
        assertEqual(exists(still), false, 'completed still removed');
        assertEqual(exists(entry), true, 'linked media entry preserved');
        assertEqual(exists(active.path), true, 'active reference usable');
        assertEqual(exists(published), true, 'published wallpaper preserved');
        assertEqual(result.removedBytes > 0 && result.preservedActiveBytes > 0 &&
            result.preservedWallpaperBytes > 0, true, `byte report ${JSON.stringify(result)}`);
        await releasePlaybackAsset(active);
        await clearCache();
        assertEqual(exists(entry), false, 'released media entry becomes eligible');
        assertEqual(exists(published), true, 'published survives later clears');
    });

    test('publish regenerates a still removed by clear cache, refuses when the asset is gone', async () => {
        const asset = await acquirePlaybackAsset(media, geometry(FitMode.FILL, 48, 48));
        const still = await ensureStill(asset, asset.geometry);
        await clearCache();
        const published = await publishWallpaper(still);
        assertEqual(size(published), '48x48', 'regenerated publication');
        assertEqual(await publishWallpaper(still), published, 'immutable content-addressed publication');
        const published0 = list(wallpaperDir()).length;
        const other = await acquirePlaybackAsset(media, geometry(FitMode.FIT, 44, 44));
        const cancellable = new Gio.Cancellable();
        const cancelled = publishWallpaper(await ensureStill(other, other.geometry), cancellable);
        cancellable.cancel();
        await expectCancelled(cancelled);
        assertEqual(list(wallpaperDir()).length, published0, 'cancelled publish adds nothing');
        await releasePlaybackAsset(other);
        await releasePlaybackAsset(asset);
        await clearCache();
        await expectCode(publishWallpaper(still), 'STILL_MISSING');
        assertEqual(list(`${cacheRoot()}/jobs`).length, 0, 'publish jobs cleaned');
        assertEqual(list(wallpaperDir()).filter(name => name.startsWith('.')).length, 0, 'no temp files');
    });

    test('cancelling one caller keeps the shared producer for the other', async () => {
        const asset = await acquirePlaybackAsset(media, geometry(FitMode.FILL, 40, 40));
        const cancellable = new Gio.Cancellable();
        const cancelled = ensureStill(asset, asset.geometry, cancellable);
        const survivor = ensureStill(asset, asset.geometry);
        await sleep(5);
        cancellable.cancel();
        await expectCancelled(cancelled);
        assertEqual(size(await survivor), '40x40', 'survivor still');
        assertEqual(exists(asset.path), true, 'reference intact');
        await releasePlaybackAsset(asset);
    });

    test('cancelling the only caller removes its job and publishes nothing', async () => {
        const asset = await acquirePlaybackAsset(media, geometry(FitMode.FILL, 36, 36));
        const cancellable = new Gio.Cancellable();
        const pending = ensureStill(asset, asset.geometry, cancellable);
        await sleep(5);
        cancellable.cancel();
        await expectCancelled(pending);
        await sleep(200);
        assertEqual(list(`${cacheRoot()}/jobs`).length, 0, 'job removed');
        assertEqual(exists(`${cacheRoot()}/stills/${cache.stillKey(asset, asset.geometry)}.png`), false,
            'nothing published');
        const precancelled = new Gio.Cancellable();
        precancelled.cancel();
        await expectCancelled(acquirePlaybackAsset(media, geometry(FitMode.FILL), {cancellable: precancelled}));
        await releasePlaybackAsset(asset);
    });

    test('independent producers of one key use distinct jobs and both publish', async () => {
        const other = await import('../lib/stillCache.js?instance=second');
        assertEqual(other.ensureStill !== ensureStill, true, 'separate module instance');
        const a = await acquirePlaybackAsset(media, geometry(FitMode.STRETCH, 50, 30));
        const b = await other.acquirePlaybackAsset(media, geometry(FitMode.STRETCH, 50, 30));
        const cancellable = new Gio.Cancellable();
        const results = Promise.all([ensureStill(a, a.geometry), other.ensureStill(b, b.geometry)]);
        const third = other.ensureStill(b, b.geometry, cancellable);
        cancellable.cancel();
        await expectCancelled(third);
        const [first, second] = await results;
        assertEqual(first, second, 'same key');
        assertEqual(size(first), '50x30', 'valid published still');
        await releasePlaybackAsset(a);
        await other.releasePlaybackAsset(b);
        assertEqual(list(`${cacheRoot()}/jobs`).length, 0, 'jobs cleaned');
    });
} else {
    console.log('skip: ffmpeg/ffprobe missing, still cache tests skipped');
}

await run().finally(() => {
    const removeTree = file => {
        const info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            const enumerator = file.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let child;
            while ((child = enumerator.next_file(null)))
                removeTree(file.get_child(child.get_name()));
            enumerator.close(null);
        }
        file.delete(null);
    };
    if (root.startsWith(GLib.get_tmp_dir()))
        removeTree(Gio.File.new_for_path(root));
});
