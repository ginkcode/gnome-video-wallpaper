import Gio from 'gi://Gio';

import {sleep} from '../lib/async.js';
import {parseDisplayConfigState} from '../lib/monitorIdentity.js';
import {MONITOR_SIGNAL, MonitorWatcher, planTargets, selectionKey} from '../lib/monitorTopology.js';
import {assertDeepEqual, assertEqual, run, test} from './harness.js';

const quiet = {debug() {}, info() {}, warn() {}, error() {}};
const EDP = 'eDP-1:LEN:Panel:SN1';
const HDMI = 'HDMI-1:DEL:U2723:SN2';

function loadFixture(name) {
    const [, bytes] = Gio.File.new_for_path(`tests/fixtures/${name}`).load_contents(null);
    return parseDisplayConfigState(JSON.parse(new TextDecoder().decode(bytes)));
}

function config(file, extra = {}) {
    return {file, fitMode: null, optimize: null, ...extra};
}

function options(indices = {'eDP-1': 0, 'HDMI-1': 1, 'HDMI-2': 1}) {
    return {defaultFitMode: 'fill', optimizeVideos: false, vo: 'gpu-next', logger: quiet,
        monitorIndexFor: connector => indices[connector] ?? -1};
}

function moved(topology, key, changes) {
    return {...topology, logicalMonitors: topology.logicalMonitors.map(monitor =>
        monitor.key === key ? {...monitor, ...changes} : monitor)};
}

test('every configured logical monitor becomes a target in sorted key order', () => {
    const plans = planTargets(loadFixture('display-state-mixed.json'),
        {[EDP]: config('/a.mp4'), [HDMI]: config('/b.mp4', {fitMode: 'fit', optimize: true})}, options());
    assertDeepEqual(plans.map(plan => plan.logicalMonitorKey), ['HDMI-1', 'eDP-1']);
    const [external, laptop] = plans;
    assertEqual(external.selectedPhysicalMonitorId, HDMI);
    assertEqual(external.monitorIndex, 1);
    assertEqual(external.optimize, true);
    assertEqual(external.vo, 'gpu-next');
    assertEqual(external.systemWallpaper, false);
    assertDeepEqual(external.placement, {x: 1920, y: 0, width: 960, height: 1707, scale: 1.5, transform: 1});
    assertDeepEqual(external.geometry, {width: 1440, height: 2561, scale: 1.5, fitMode: 'fit', transformVersion: 1});
    assertEqual(laptop.monitorIndex, 0);
    assertDeepEqual(laptop.geometry, {width: 1920, height: 1080, scale: 1, fitMode: 'fill', transformVersion: 1});
});

test('unconfigured or unindexed logical monitors get no target', () => {
    const topology = loadFixture('display-state-mixed.json');
    const configs = {[EDP]: config('/a.mp4'), [HDMI]: config('/b.mp4')};
    assertDeepEqual(planTargets(topology, {[EDP]: config('/a.mp4')}, options())
        .map(plan => plan.logicalMonitorKey), ['eDP-1']);
    assertDeepEqual(planTargets(topology, configs, options({'eDP-1': 0}))
        .map(plan => plan.logicalMonitorKey), ['eDP-1']);
    assertDeepEqual(planTargets(topology, {}, options()), []);
});

test('mirrored connectors share one target from the first configured sorted connector', () => {
    const topology = loadFixture('display-state-mirrored.json');
    const a = 'HDMI-1:DEL:Same:A';
    const b = 'HDMI-2:DEL:Same:B';
    const both = planTargets(topology, {[b]: config('/b.mp4'), [a]: config('/a.mp4')}, options());
    assertEqual(both.length, 1);
    assertEqual(both[0].logicalMonitorKey, 'HDMI-1|HDMI-2');
    assertEqual(both[0].selectedPhysicalMonitorId, a);
    assertEqual(both[0].systemWallpaper, true);
    const onlyB = planTargets(topology, {[b]: config('/b.mp4')}, options());
    assertEqual(onlyB[0].selectedPhysicalMonitorId, b);
    assertEqual(onlyB[0].file, '/b.mp4');
});

test('selection key changes with position, index, scale and rotation but raster follows logical size', () => {
    const topology = loadFixture('display-state-mixed.json');
    const configs = {[HDMI]: config('/b.mp4')};
    const keyOf = (state, indices) => selectionKey(planTargets(state, configs, options(indices))[0], ['asset']);
    const base = keyOf(topology);
    assertEqual(keyOf(topology), base, 'stable for an unchanged topology');
    const shifted = moved(topology, 'HDMI-1', {x: -960});
    assertEqual(planTargets(shifted, configs, options())[0].geometry.width, 1440, 'raster unaffected by position');
    assertEqual(keyOf(shifted) !== base, true, 'position change replaces');
    assertEqual(keyOf(topology, {'HDMI-1': 0}) !== base, true, 'layout index change replaces');
    assertEqual(keyOf(moved(topology, 'HDMI-1', {scale: 2, width: 720, height: 1280})) !== base, true, 'scale');
    assertEqual(keyOf(moved(topology, 'HDMI-1', {transform: 3})) !== base, true, 'rotation');
    const plan = planTargets(topology, configs, options())[0];
    assertEqual(selectionKey(plan, ['other']) !== selectionKey(plan, ['asset']), true, 'asset change replaces');
    assertEqual(selectionKey({...plan, vo: 'auto'}, ['asset']) !== selectionKey(plan, ['asset']), true, 'vo');
    assertEqual(selectionKey({...plan, systemWallpaper: true}, ['asset']), selectionKey(plan, ['asset']),
        'becoming the only monitor does not restart its player');
});

class FakeSource {
    constructor() {
        this.handlers = new Map();
        this.next = 1;
    }

    connect(signal, callback) {
        const id = this.next++;
        this.handlers.set(id, {signal, callback});
        return id;
    }

    disconnect(id) {
        this.handlers.delete(id);
    }

    emit(signal) {
        for (const handler of [...this.handlers.values()]) {
            if (handler.signal === signal)
                handler.callback();
        }
    }
}

test('monitor changes from layout and backend coalesce into one debounced reconcile', async () => {
    const layout = new FakeSource();
    const backend = new FakeSource();
    let changes = 0;
    const watcher = new MonitorWatcher({sources: [layout, backend, null], onChange: () => changes++,
        debounceMs: 40, logger: quiet});
    watcher.enable();
    watcher.enable();
    assertEqual(layout.handlers.size + backend.handlers.size, 2, 'one handler per source');
    for (let i = 0; i < 4; i++) {
        layout.emit(MONITOR_SIGNAL);
        backend.emit(MONITOR_SIGNAL);
        await sleep(10);
    }
    layout.emit('other-signal');
    assertEqual(changes, 0, 'nothing before the quiet period');
    await sleep(100);
    assertEqual(changes, 1);
    backend.emit(MONITOR_SIGNAL);
    await sleep(100);
    assertEqual(changes, 2);
});

test('disable drops pending changes and disconnects; re-enable works', async () => {
    const layout = new FakeSource();
    let changes = 0;
    const watcher = new MonitorWatcher({sources: [layout], onChange: () => changes++, debounceMs: 30, logger: quiet});
    watcher.enable();
    const stale = [...layout.handlers.values()][0].callback;
    layout.emit(MONITOR_SIGNAL);
    watcher.disable();
    assertEqual(layout.handlers.size, 0, 'disconnected');
    await sleep(80);
    assertEqual(changes, 0, 'pending change dropped');
    watcher.enable();
    stale();
    await sleep(80);
    assertEqual(changes, 0, 'stale generation callback ignored');
    layout.emit(MONITOR_SIGNAL);
    await sleep(80);
    assertEqual(changes, 1);
    watcher.disable();
    watcher.disable();
});

test('a throwing change handler does not break later changes', async () => {
    const layout = new FakeSource();
    let calls = 0;
    const watcher = new MonitorWatcher({sources: [layout], debounceMs: 10, logger: quiet, onChange: () => {
        calls++;
        throw new Error('boom');
    }});
    watcher.enable();
    layout.emit(MONITOR_SIGNAL);
    await sleep(50);
    layout.emit(MONITOR_SIGNAL);
    await sleep(50);
    assertEqual(calls, 2);
    watcher.disable();
});

await run();
