import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {sleep} from '../lib/async.js';
import {checkDependencies, findProgram} from '../lib/deps.js';
import {ProbeError, clearProbeCache, parseProbe, probe} from '../lib/mediaProbe.js';
import {assertEqual, run, test} from './harness.js';

const root = GLib.dir_make_tmp('gink-vw-probe-XXXXXX');
const ffmpeg = findProgram('ffmpeg');
const ffprobe = findProgram('ffprobe');
const identity = {path: '/x', size: 1, mtime: 2};

function sample(name, args, input = 'testsrc2=size=96x48:rate=10:duration=1') {
    const path = `${root}/${name}`;
    const [, , stderr, status] = GLib.spawn_sync(null, [ffmpeg, '-hide_banner', '-loglevel', 'error',
        '-nostdin', '-y', '-f', 'lavfi', '-i', input, ...args, path], null,
    GLib.SpawnFlags.DEFAULT, null);
    if (status !== 0)
        throw new Error(`ffmpeg failed for ${name}: ${new TextDecoder().decode(stderr)}`);
    return path;
}

function remux(name, source, args) {
    const path = `${root}/${name}`;
    const [, , stderr, status] = GLib.spawn_sync(null, [ffmpeg, '-hide_banner', '-loglevel', 'error',
        '-nostdin', '-y', ...args, '-i', source, '-c', 'copy', path], null, GLib.SpawnFlags.DEFAULT, null);
    if (status !== 0)
        throw new Error(`ffmpeg remux failed for ${name}: ${new TextDecoder().decode(stderr)}`);
    return path;
}

function write(name, text) {
    const path = `${root}/${name}`;
    GLib.file_set_contents(path, text);
    return path;
}

async function expectCode(promise, code) {
    try {
        await promise;
    } catch (error) {
        if (!(error instanceof ProbeError))
            throw new Error(`expected ProbeError ${code}, got ${error}`);
        assertEqual(error.code, code, 'error code');
        return error;
    }
    throw new Error(`expected ProbeError ${code}`);
}

// A delayed ffprobe keeps the probe in flight, so cancellation never races a fast machine.
async function withSlowFfprobe(callback) {
    const bin = `${root}/slow-bin`;
    GLib.mkdir_with_parents(bin, 0o755);
    GLib.file_set_contents(`${bin}/ffprobe`, `#!/bin/sh\nsleep 0.3\nexec '${ffprobe}' "$@"\n`);
    GLib.chmod(`${bin}/ffprobe`, 0o755);
    const path = GLib.getenv('PATH');
    GLib.setenv('PATH', `${bin}:${path}`, true);
    try {
        return await callback();
    } finally {
        GLib.setenv('PATH', path, true);
    }
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

const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];

function tags(primaries, transfer, space) {
    return `setparams=color_primaries=${primaries}:color_trc=${transfer}:colorspace=${space}`;
}

test('parseProbe normalizes SAR, rotation and color tags', () => {
    const result = parseProbe(JSON.stringify({
        format: {format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '8.000'},
        streams: [{codec_type: 'video', codec_name: 'h264', width: 1440, height: 1080,
            sample_aspect_ratio: '4:3', avg_frame_rate: '30000/1001', color_range: 'tv',
            color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'unknown',
            side_data_list: [{side_data_type: 'Display Matrix', rotation: -90}]}],
    }), identity);
    assertEqual(result.width, 1080, 'display width');
    assertEqual(result.height, 1920, 'display height');
    assertEqual(result.codedWidth, 1440, 'coded width');
    assertEqual(result.rotation, 90, 'clockwise rotation');
    assertEqual(result.sampleAspectRatio, '4:3', 'sar');
    assertEqual(result.colorSpace, null, 'unknown tag');
    assertEqual(result.colorRange, 'tv', 'range');
    assertEqual(result.durationSec, 8, 'duration');
    assertEqual(result.frameRate.toFixed(3), '29.970', 'frame rate');
    assertEqual(result.isGif, false, 'gif');
    assertEqual(result.isHdr, false, 'hdr');
});

test('parseProbe rejects HDR, odd rotation, bad geometry and missing video', async () => {
    const video = {codec_type: 'video', codec_name: 'hevc', width: 64, height: 48};
    const parse = streams => Promise.resolve().then(() =>
        parseProbe(JSON.stringify({format: {}, streams}), identity));
    const hdr = await expectCode(parse([{...video, color_transfer: 'arib-std-b67'}]), 'UNSUPPORTED_HDR');
    assertEqual(/SDR/.test(hdr.message) && /tone mapping/.test(hdr.message), true, 'actionable HDR message');
    await expectCode(parse([{...video, side_data_list: [
        {side_data_type: 'Mastering display metadata'}]}]), 'UNSUPPORTED_HDR');
    await expectCode(parse([{...video, side_data_list: [{rotation: 45}]}]), 'INVALID_GEOMETRY');
    await expectCode(parse([{...video, width: 0}]), 'INVALID_GEOMETRY');
    await expectCode(parse([{...video, width: 20000}]), 'INVALID_GEOMETRY');
    await expectCode(parse([{...video, disposition: {attached_pic: 1}}]), 'NO_VIDEO_STREAM');
    await expectCode(parse([]), 'NO_VIDEO_STREAM');
    await expectCode(Promise.resolve().then(() => parseProbe('not json', identity)), 'FFPROBE_FAILED');
});

test('missing, non-regular and pre-cancelled inputs', async () => {
    await expectCode(probe(`${root}/missing.mp4`), 'NOT_FOUND');
    await expectCode(probe(root), 'NOT_REGULAR');
    const cancellable = new Gio.Cancellable();
    cancellable.cancel();
    await expectCancelled(probe(write('pre.txt', 'x'), cancellable));
});

test('missing ffprobe maps to FFPROBE_MISSING', async () => {
    const path = GLib.getenv('PATH');
    GLib.setenv('PATH', `${root}/empty-path`, true);
    try {
        await expectCode(probe(write('nopath.txt', 'x')), 'FFPROBE_MISSING');
    } finally {
        GLib.setenv('PATH', path, true);
    }
});

test('dependency check reports booleans', async () => {
    const deps = await checkDependencies();
    assertEqual(deps.ffprobe, Boolean(ffprobe), 'ffprobe');
    for (const name of ['mpv', 'ffmpeg', 'vaapi'])
        assertEqual(typeof deps[name], 'boolean', name);
});

if (ffmpeg && ffprobe) {
    test('real samples expose correct metadata', async () => {
        const cases = [
            ['h264.mp4', x264, {codec: 'h264', width: 96, height: 48, isGif: false}],
            ['h264.mkv', x264, {codec: 'h264', width: 96, height: 48}],
            ['h264.mov', x264, {codec: 'h264', width: 96, height: 48}],
            ['vp9.webm', ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8'],
                {codec: 'vp9', width: 96, height: 48}],
            ['anim.gif', ['-c:v', 'gif'], {codec: 'gif', width: 96, height: 48, isGif: true}],
            ['sar.mp4', ['-vf', 'setsar=4/3', ...x264],
                {width: 128, height: 48, codedWidth: 96, sampleAspectRatio: '4:3'}],
            ['sdr.mp4', ['-vf', tags('bt709', 'bt709', 'bt709'), ...x264, '-color_range', 'tv'],
            {colorPrimaries: 'bt709', colorTransfer: 'bt709', colorSpace: 'bt709', colorRange: 'tv'}],
        ];
        for (const [name, args, expected] of cases) {
            const result = await probe(sample(name, args));
            for (const [key, value] of Object.entries(expected))
                assertEqual(result[key], value, `${name} ${key}`);
            assertEqual(result.hasVideo, true, `${name} hasVideo`);
            assertEqual(result.rotation, 0, `${name} rotation`);
            assertEqual(result.frameRate, 10, `${name} frameRate`);
            assertEqual(Math.abs(result.durationSec - 1) < 0.2, true, `${name} duration`);
            assertEqual(result.size > 0 && result.mtime > 0, true, `${name} identity`);
        }
    });

    test('90° and 270° rotation swap display dimensions', async () => {
        const base = sample('unrotated.mp4', x264);
        for (const [ccw, clockwise] of [[90, 270], [-90, 90]]) {
            const result = await probe(remux(`rot${clockwise}.mp4`, base, ['-display_rotation', String(ccw)]));
            assertEqual(result.rotation, clockwise, `rotation ${ccw}`);
            assertEqual(`${result.width}x${result.height}`, '48x96', `display size ${ccw}`);
            assertEqual(`${result.codedWidth}x${result.codedHeight}`, '96x48', `coded size ${ccw}`);
        }
    });

    test('HDR, text and audio-only files are rejected', async () => {
        const hdr = await expectCode(probe(sample('hdr.mp4',
            ['-vf', tags('bt2020', 'smpte2084', 'bt2020nc'), ...x264])), 'UNSUPPORTED_HDR');
        assertEqual(/SDR/.test(hdr.message), true, 'HDR suggests SDR source');
        await expectCode(probe(write('notes.txt', 'not a video\n')), 'FFPROBE_FAILED');
        await expectCode(probe(sample('tone.wav', [], 'sine=duration=0.2')), 'NO_VIDEO_STREAM');
    });

    test('cancelling one caller keeps shared work for another', async () => {
        clearProbeCache();
        const path = sample('shared.mp4', x264);
        await withSlowFfprobe(async () => {
            const cancellable = new Gio.Cancellable();
            const cancelled = probe(path, cancellable);
            const survivor = probe(path);
            await sleep(20);
            cancellable.cancel();
            await expectCancelled(cancelled);
            assertEqual((await survivor).width, 96, 'survivor result');
        });
    });

    test('cancelling the only caller settles promptly and allows a fresh probe', async () => {
        clearProbeCache();
        const path = sample('alone.mp4', x264);
        await withSlowFfprobe(async () => {
            const cancellable = new Gio.Cancellable();
            const pending = probe(path, cancellable);
            await sleep(20);
            const started = GLib.get_monotonic_time();
            cancellable.cancel();
            await expectCancelled(pending);
            assertEqual(GLib.get_monotonic_time() - started < 100000, true, 'prompt cancellation');
        });
        assertEqual((await probe(path)).width, 96, 'fresh probe');
    });

    test('probing keeps the main loop responsive and caches by identity', async () => {
        clearProbeCache();
        const path = sample('loop.mp4', x264);
        let ticks = 0;
        const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
            ticks++;
            return GLib.SOURCE_CONTINUE;
        });
        try {
            const first = await probe(path);
            assertEqual(ticks > 0, true, 'main loop ticked during probe');
            first.width = 1;
            assertEqual((await probe(path)).width, 96, 'cached copy is isolated');
        } finally {
            GLib.source_remove(source);
        }
        sample('loop.mp4', [...x264, '-vf', 'scale=64:48,setsar=1']);
        assertEqual((await probe(path)).width, 64, 'changed file is re-probed');
    });
} else {
    console.log('skip: ffmpeg/ffprobe missing, real-sample probe tests skipped');
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
