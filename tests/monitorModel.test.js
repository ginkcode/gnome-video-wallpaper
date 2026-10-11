import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {sleep} from '../lib/async.js';
import {findProgram} from '../lib/deps.js';
import {FitMode} from '../lib/geometry.js';
import {probe} from '../lib/mediaProbe.js';
import {parseDisplayConfigState} from '../lib/monitorIdentity.js';
import {LatestJobs} from '../prefs/latestJobs.js';
import {applySelection, buildMonitorModel, describeMonitorId, editPlaylist, loadPreview, modelLayout} from '../prefs/monitorModel.js';
import {assertDeepEqual, assertEqual, run, test} from './harness.js';

const root = GLib.dir_make_tmp('gink-vw-prefs-XXXXXX');
GLib.setenv('XDG_CACHE_HOME', `${root}/cache`, true);
const {acquirePlaybackAsset, cacheRoot, ensureStill, releasePlaybackAsset} = await import('../lib/stillCache.js');
const decoder = new TextDecoder();

function loadFixture(name) {
    const [, bytes] = Gio.File.new_for_path(`tests/fixtures/${name}`).load_contents(null);
    return parseDisplayConfigState(JSON.parse(decoder.decode(bytes)));
}

function cancelled() {
    const cancellable = new Gio.Cancellable();
    cancellable.cancel();
    return cancellable;
}

const LOGICAL = {key: 'X', width: 1707, height: 960, scale: 1.5};
const config = file => ({file, fitMode: null, optimize: null});

test('mirrored displays keep separate ids and share the first configured connector', () => {
    const monitors = loadFixture('display-state-mirrored.json');
    const [a, b] = ['HDMI-1:DEL:Same:A', 'HDMI-2:DEL:Same:B'];
    let model = buildMonitorModel(monitors, {[b]: config('/b.mp4'), [a]: config('/a.mp4')});
    assertEqual(model.groups.length, 1, 'one logical group');
    const [group] = model.groups;
    assertEqual(group.mirrored, true, 'mirrored');
    assertDeepEqual(group.members.map(member => member.physical.id), [a, b], 'sorted members');
    assertEqual(group.effectiveId, a, 'first configured connector wins');
    assertDeepEqual(group.members.map(member => member.effective), [true, false]);
    model = buildMonitorModel(monitors, {[b]: config('/b.mp4')});
    assertEqual(model.groups[0].effectiveId, b, 'only configured member wins');
    assertEqual(buildMonitorModel(monitors, {}).groups[0].effectiveId, null, 'nothing configured');
});

test('configs of absent displays are listed as other monitors', () => {
    const monitors = loadFixture('display-state-mixed.json');
    const gone = 'DP-9:GSM:Wide 34:SN:7';
    const model = buildMonitorModel(monitors, {[gone]: config('/gone.mp4')});
    assertDeepEqual(model.others, [{id: gone, config: config('/gone.mp4'), connector: 'DP-9', title: 'GSM Wide 34',
        serial: 'SN:7'}]);
    assertEqual(model.groups.every(group => group.members.every(member => !member.config)), true);
    assertEqual(model.groups[0].logical.primary, true, 'primary first');
    assertDeepEqual(describeMonitorId('eDP-1:::'), {connector: 'eDP-1', title: 'eDP-1', serial: ''});
});

test('layout changes only with topology, not with configs', () => {
    const monitors = loadFixture('display-state-mixed.json');
    const id = monitors.physicalMonitors[0].id;
    const empty = modelLayout(buildMonitorModel(monitors, {}));
    assertEqual(modelLayout(buildMonitorModel(monitors, {[id]: config('/a.mp4')})), empty, 'config change');
    assertEqual(modelLayout(buildMonitorModel(monitors, {'Gone:1:2:3': config('/a.mp4')})) === empty, false,
        'other monitor added');
});

function selection(overrides = {}) {
    const writes = [];
    const stored = {current: {file: '/old.mp4', fitMode: 'fit', optimize: true}};
    return {
        writes,
        stored,
        options: {
            files: ['/new.mp4'], logical: LOGICAL, defaultFitMode: () => 'fill',
            probe: async path => ({path, width: 10, height: 10}),
            readConfig: () => stored.current,
            writeConfig: value => writes.push(value),
            cancellable: new Gio.Cancellable(),
            ...overrides,
        },
    };
}

test('selection writes the file and keeps the stored fit mode and optimize flag', async () => {
    const {writes, options} = selection();
    const {geometry} = await applySelection(options);
    assertDeepEqual(writes, [{files: ['/new.mp4'], fitMode: 'fit', optimize: true}]);
    assertDeepEqual(geometry, {width: 2561, height: 1440, scale: 1.5, fitMode: 'fit', transformVersion: 1});
    const fresh = selection();
    fresh.stored.current = null;
    await applySelection(fresh.options);
    assertDeepEqual(fresh.writes, [{files: ['/new.mp4'], fitMode: null, optimize: null}], 'new config uses default');
});

test('adding to a playlist probes and prepares only the added files', async () => {
    const probed = [];
    const prepared = [];
    const {writes, options} = selection({
        files: ['/old.mp4', '/b.mp4', '/c.gif'], added: ['/b.mp4', '/c.gif'],
        probe: async path => {
            probed.push(path);
            return {path};
        },
        prepare: async (media, _geometry, config) => prepared.push([media.path, config.file]),
    });
    const {media} = await applySelection(options);
    assertDeepEqual(probed, ['/b.mp4', '/c.gif']);
    assertDeepEqual(prepared, [['/b.mp4', '/b.mp4'], ['/c.gif', '/c.gif']]);
    assertEqual(media.length, 2);
    assertDeepEqual(writes, [{files: ['/old.mp4', '/b.mp4', '/c.gif'], fitMode: 'fit', optimize: true}]);
});

test('playlist edits add without duplicates, remove and move up', () => {
    const files = ['/a', '/b', '/c'];
    assertDeepEqual(editPlaylist(files, {add: ['/b', '/d']}), ['/a', '/b', '/c', '/d']);
    assertDeepEqual(editPlaylist(files, {remove: '/b'}), ['/a', '/c']);
    assertDeepEqual(editPlaylist(files, {raise: '/c'}), ['/a', '/c', '/b']);
    assertDeepEqual(editPlaylist(files, {raise: '/a'}), files, 'first stays first');
    assertDeepEqual(files, ['/a', '/b', '/c'], 'input untouched');
});

test('probe failure, bad geometry or cancellation never writes', async () => {
    const failures = [
        selection({probe: async () => {
            throw new Error('bad file');
        }}),
        selection({logical: {...LOGICAL, width: 0}}),
        selection({cancellable: cancelled()}),
    ];
    for (const [index, {writes, options}] of failures.entries()) {
        let error = null;
        await applySelection(options).catch(caught => {
            error = caught;
        });
        assertEqual(error !== null, true, `case ${index} rejects`);
        assertDeepEqual(writes, [], `case ${index} unchanged`);
    }
});

test('latest job wins and close cancels everything', async () => {
    const jobs = new LatestJobs();
    const wait = cancellable => sleep(30, cancellable).then(() => 'late');
    const first = jobs.run('a', wait);
    const second = jobs.run('a', async () => 'second');
    const other = jobs.run('b', wait);
    assertDeepEqual(await first, {cancelled: true}, 'superseded');
    assertDeepEqual(await second, {value: 'second'});
    const failing = await jobs.run('c', async () => {
        throw new Error('boom');
    });
    assertEqual(failing.error.message, 'boom', 'error surfaced');
    const ignoring = jobs.run('d', async () => {
        await sleep(10);
        return 'stale';
    });
    jobs.cancel('d');
    assertDeepEqual(await ignoring, {cancelled: true}, 'result after cancel is dropped');
    jobs.close();
    assertDeepEqual(await other, {cancelled: true}, 'closed');
    assertDeepEqual(await jobs.run('e', async () => 'never'), {cancelled: true}, 'run after close');
    assertEqual(jobs.pending, 0, 'no slots');
});

function children(name) {
    const directory = Gio.File.new_for_path(`${cacheRoot()}/${name}`);
    if (!directory.query_exists(null))
        return 0;
    const enumerator = directory.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let count = 0;
    while (enumerator.next_file(null))
        count++;
    return count;
}

function pngSize(path) {
    const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return `${view.getUint32(16)}x${view.getUint32(20)}`;
}

function ffmpeg(name, args) {
    const path = `${root}/${name}`;
    const [, , stderr, status] = GLib.spawn_sync(null, ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-y', ...args, path], null, GLib.SpawnFlags.SEARCH_PATH, null);
    if (status !== 0)
        throw new Error(decoder.decode(stderr));
    return path;
}

function encode(name, args) {
    return ffmpeg(name, ['-f', 'lavfi', '-i', 'testsrc2=size=96x48:rate=10:duration=1', ...args,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']);
}

const previewDeps = {probe, acquire: acquirePlaybackAsset, ensureStill, release: releasePlaybackAsset};

if (findProgram('ffmpeg') && findProgram('ffprobe')) {
    test('anamorphic and rotated SDR files save and preview at the target raster; HDR is refused', async () => {
        const logical = {key: 'P', width: 64, height: 48, scale: 1};
        const files = [[encode('sar.mp4', ['-vf', 'setsar=4/3']), '128x48'],
            [ffmpeg('rot.mp4', ['-display_rotation', '90', '-i', encode('base.mp4', []), '-c', 'copy']), '48x96']];
        for (const [file, size] of files) {
            const {writes, options} = selection({files: [file], logical, probe});
            const {media: [media], geometry} = await applySelection(options);
            assertEqual(`${media.width}x${media.height}`, size, `${file} display size`);
            assertDeepEqual(writes[0].files, [file], `${file} saved`);
            const still = await loadPreview({file, geometry, ...previewDeps, cancellable: new Gio.Cancellable()});
            assertEqual(pngSize(still), '64x48', `${file} preview size`);
        }
        const hdr = encode('hdr.mp4', ['-vf',
            'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc']);
        const {writes, options} = selection({files: [hdr], logical, probe});
        const error = await applySelection(options).catch(caught => caught);
        assertEqual(error.code, 'UNSUPPORTED_HDR', 'HDR rejected');
        assertEqual(/SDR/.test(error.message), true, 'actionable message');
        assertDeepEqual(writes, [], 'HDR leaves config untouched');
        assertEqual(children('refs'), 0, 'assets released');
    });

    test('rapid preview reselection and close leave no temporary files', async () => {
        const jobs = new LatestJobs();
        const file = encode('fast.mp4', []);
        const preview = fitMode => jobs.run('preview', cancellable => loadPreview({file, ...previewDeps, cancellable,
            geometry: {width: 80 + fitMode.length, height: 40, scale: 1, fitMode, transformVersion: 1}}));
        const results = [preview(FitMode.FILL), preview(FitMode.FIT), preview(FitMode.STRETCH)];
        const closing = preview(FitMode.FILL);
        await sleep(5);
        jobs.close();
        const settled = await Promise.all([...results, closing]);
        assertEqual(settled.every(result => result.cancelled), true, 'all superseded or closed');
        assertEqual(children('refs') + children('jobs'), 0, 'no refs or job directories left');
    });
}

try {
    await run();
} finally {
    Gio.Subprocess.new(['rm', '-rf', root], Gio.SubprocessFlags.NONE).wait(null);
}
