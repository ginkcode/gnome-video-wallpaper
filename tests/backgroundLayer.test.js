import Gio from 'gi://Gio';

import {
    BackgroundLifecycle, findBackgroundAnchor, placeAboveBackground, windowGeometryCorrection,
} from '../lib/backgroundLifecycle.js';
import {assertDeepEqual, assertEqual, run, test} from './harness.js';

function player(owned) {
    return {ownsWindow: window => owned.has(window)};
}

test('watch installs listener before existing windows are checked', async () => {
    const owned = new Set(['player']);
    const lifecycle = new BackgroundLifecycle();
    let connected = false;
    const promise = lifecycle.watchWindow(player(owned), {
        connectCreated: () => {
            connected = true;
            return () => {};
        },
        existingWindows: () => {
            assertEqual(connected, true);
            return ['player'];
        },
        prepareWindow: (window, resolve) => {
            assertEqual(connected, true);
            resolve(window);
        },
    });
    assertEqual(connected, true);
    assertEqual((await Promise.allSettled([promise]))[0].status, 'rejected');
    lifecycle.destroy();
});

test('preexisting owned windows are rejected rather than reconciled', async () => {
    const owned = new Set(['old']);
    const lifecycle = new BackgroundLifecycle();
    const promise = lifecycle.watchWindow(player(owned), {
        connectCreated: () => () => {},
        existingWindows: () => ['old'],
        prepareWindow: () => {
            throw new Error('must not hide an unverified preexisting window');
        },
    });
    let message = '';
    try {
        await promise;
    } catch (error) {
        message = error.message;
    }
    assertEqual(message.includes('before-first-paint'), true);
    lifecycle.destroy();
});

test('first frame latches for a waiter that arrives later', async () => {
    const lifecycle = new BackgroundLifecycle();
    lifecycle.window = {id: 1};
    lifecycle.latchFirstFrame();
    await lifecycle.waitForFirstFrame({timeoutMs: 20});
    lifecycle.latchFirstFrame();
    assertEqual(lifecycle.firstFrame, true);
    lifecycle.destroy();
    let destroyed = false;
    try {
        await lifecycle.waitForFirstFrame({timeoutMs: 20});
    } catch (error) {
        destroyed = error.message.includes('destroyed');
    }
    assertEqual(destroyed, true);
});

test('cancellation and destroy settle discovery and frame waits', async () => {
    const cancellable = new Gio.Cancellable();
    const lifecycle = new BackgroundLifecycle();
    const discovery = lifecycle.watchWindow(player(new Set()), {
        timeoutMs: 60000,
        cancellable,
        connectCreated: () => () => {},
        existingWindows: () => [],
        prepareWindow: () => {},
    });
    const frame = lifecycle.waitForFirstFrame({timeoutMs: 60000});
    cancellable.cancel();
    lifecycle.destroy();
    const results = await Promise.allSettled([discovery, frame]);
    assertEqual(results.every(result => result.status === 'rejected'), true);
    lifecycle.destroy();
});

test('timeout rejects discovery without calling prepare', async () => {
    const lifecycle = new BackgroundLifecycle();
    let prepared = false;
    const discovery = lifecycle.watchWindow(player(new Set(['later'])), {
        timeoutMs: 10,
        connectCreated: () => () => {},
        existingWindows: () => [],
        prepareWindow: () => {
            prepared = true;
        },
    });
    let timedOut = false;
    try {
        await discovery;
    } catch (error) {
        timedOut = error.message.includes('timed out');
    }
    assertEqual(timedOut, true);
    assertEqual(prepared, false);
    lifecycle.destroy();
});

test('owned created window resolves only after synchronous prepare', async () => {
    const owned = new Set(['new']);
    const lifecycle = new BackgroundLifecycle();
    let callback = null;
    const discovery = lifecycle.watchWindow(player(owned), {
        timeoutMs: 1000,
        connectCreated: created => {
            callback = created;
            return () => {};
        },
        existingWindows: () => [],
        prepareWindow: (window, resolve) => resolve(window),
    });
    callback('other');
    callback('new');
    assertEqual(await discovery, 'new');
    lifecycle.destroy();
});

class FakeActor {
    constructor(name, monitor = null) {
        this.name = name;
        this.monitor = monitor;
        this.parent = null;
        this.children = [];
    }

    get_parent() {
        return this.parent;
    }

    get_children() {
        return [...this.children];
    }

    _detach(child) {
        this.children.splice(this.children.indexOf(child), 1);
    }

    remove_child(child) {
        this._detach(child);
        child.parent = null;
    }

    insert_child_at_index(child, index) {
        this.children.splice(index, 0, child);
        child.parent = this;
    }

    insert_child_above(child, sibling) {
        this.insert_child_at_index(child, this.children.indexOf(sibling) + 1);
    }

    add_child(child) {
        this.insert_child_at_index(child, this.children.length);
    }

    set_child_above_sibling(child, sibling) {
        this._detach(child);
        this.insert_child_above(child, sibling);
    }

    set_child_below_sibling(child, sibling) {
        this._detach(child);
        this.insert_child_at_index(child, sibling ? this.children.indexOf(sibling) : 0);
    }
}

const isBackground = actor => actor.monitor !== null;
const names = group => group.get_children().map(child => child.name);

function rebindLayer(group, layer, monitorIndex) {
    placeAboveBackground(group, layer, findBackgroundAnchor(group.get_children(), monitorIndex, isBackground));
}

test('anchor is the topmost background of the layer monitor, not a child index', () => {
    const group = new FakeActor('group');
    const bg1 = new FakeActor('bg1', 1);
    const bg0 = new FakeActor('bg0', 0);
    const fading0 = new FakeActor('fading0', 0);
    for (const actor of [bg1, bg0, fading0, new FakeActor('other')])
        group.add_child(actor);
    assertEqual(findBackgroundAnchor(group.get_children(), 0, isBackground), fading0);
    assertEqual(findBackgroundAnchor(group.get_children(), 1, isBackground), bg1);
    assertEqual(findBackgroundAnchor(group.get_children(), 2, isBackground), null);
});

test('shell background rebuild keeps the layer above the new monitor actor', () => {
    const group = new FakeActor('group');
    const oldBg = new FakeActor('old0', 0);
    group.add_child(oldBg);
    const layer = new FakeActor('layer');
    const still = new FakeActor('still');
    const clone = new FakeActor('clone');
    layer.add_child(still);
    layer.add_child(clone);
    rebindLayer(group, layer, 0);
    assertDeepEqual(names(group), ['old0', 'layer']);
    group.remove_child(oldBg);
    const newBg = new FakeActor('new0', 0);
    group.add_child(newBg);
    rebindLayer(group, layer, 0);
    assertDeepEqual(names(group), ['new0', 'layer']);
    group.set_child_below_sibling(newBg, null);
    rebindLayer(group, layer, 0);
    assertDeepEqual(names(group), ['new0', 'layer']);
    assertDeepEqual(names(layer), ['still', 'clone']);
});

test('detached layer is reinserted above its anchor and raise preserves other layers', () => {
    const group = new FakeActor('group');
    const bg0 = new FakeActor('bg0', 0);
    const bg1 = new FakeActor('bg1', 1);
    group.add_child(bg0);
    group.add_child(bg1);
    const layer0 = new FakeActor('layer0');
    const layer1 = new FakeActor('layer1');
    rebindLayer(group, layer0, 0);
    rebindLayer(group, layer1, 1);
    assertDeepEqual(names(group), ['bg0', 'layer0', 'bg1', 'layer1']);
    group.remove_child(layer0);
    rebindLayer(group, layer0, 0);
    assertDeepEqual(names(group), ['bg0', 'layer0', 'bg1', 'layer1']);
    rebindLayer(group, layer1, 1);
    assertDeepEqual(names(group), ['bg0', 'layer0', 'bg1', 'layer1']);
});

test('layer without a monitor background goes to the bottom only when detached', () => {
    const group = new FakeActor('group');
    group.add_child(new FakeActor('bg1', 1));
    const layer = new FakeActor('layer');
    rebindLayer(group, layer, 0);
    assertDeepEqual(names(group), ['layer', 'bg1']);
    group.set_child_above_sibling(layer, group.get_children()[1]);
    rebindLayer(group, layer, 0);
    assertDeepEqual(names(group), ['bg1', 'layer']);
});

test('player window geometry corrections target the logical monitor rect', () => {
    const monitor = {x: 1920, y: 0, width: 1280, height: 720};
    assertEqual(windowGeometryCorrection({...monitor}, monitor), null);
    assertDeepEqual(windowGeometryCorrection({x: 1920, y: 32, width: 1280, height: 688}, monitor),
        {moveResize: [1920, 0, 1280, 720]});
    assertDeepEqual(windowGeometryCorrection({x: 640, y: 180, width: 1280, height: 720}, monitor),
        {move: [1920, 0]});
    assertDeepEqual(windowGeometryCorrection({x: 1920, y: 0, width: 640, height: 480}, monitor),
        {moveResize: [1920, 0, 1280, 720]});
    const portrait = {x: 0, y: 0, width: 1080, height: 1920};
    assertDeepEqual(windowGeometryCorrection({x: 0, y: 0, width: 1080, height: 810}, portrait),
        {moveResize: [0, 0, 1080, 1920]});
    assertDeepEqual(windowGeometryCorrection({...portrait}, portrait, {maximized: true}),
        {unmaximize: true, moveResize: [0, 0, 1080, 1920]});
});

await run();
