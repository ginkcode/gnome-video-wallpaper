import {sleep} from '../lib/async.js';
import {COVERED, CoverageController, coveredMonitors} from '../lib/coverageController.js';
import {assertDeepEqual, assertEqual, assertThrows, run, test} from './harness.js';

const NORMAL = 0;
const DIALOG = 3;
const BOTH = 3;
const quiet = {debug() {}, info() {}, warn() {}, error() {}};

class Emitter {
    constructor() {
        this.handlers = new Map();
        this.nextId = 1;
    }

    connect(signal, callback) {
        const id = this.nextId++;
        this.handlers.set(id, {signal, callback});
        return id;
    }

    disconnect(id) {
        if (!this.handlers.delete(id))
            throw new Error(`unknown handler ${id}`);
    }

    emit(signal, ...args) {
        for (const handler of [...this.handlers.values()]) {
            if (handler.signal === signal)
                handler.callback(this, ...args);
        }
    }
}

class FakeWindow extends Emitter {
    constructor({monitor = 0, workspace = 'ws1', type = NORMAL, flags = 0, fullscreen = false, minimized = false} = {}) {
        super();
        Object.assign(this, {monitor, workspace, type, flags, fullscreen, minimized});
    }

    get_window_type() {
        return this.type;
    }

    located_on_workspace(workspace) {
        return this.workspace === 'all' || this.workspace === workspace;
    }

    is_fullscreen() {
        return this.fullscreen;
    }

    get_maximize_flags() {
        return this.flags;
    }

    get_monitor() {
        return this.monitor;
    }

    change(props, signal) {
        Object.assign(this, props);
        this.emit(signal);
    }
}

class FakeDisplay extends Emitter {
    constructor(windows = []) {
        super();
        this.windows = windows;
    }

    list_all_windows() {
        return this.windows;
    }

    add(window) {
        this.windows.push(window);
        this.emit('window-created', window);
    }

    remove(window) {
        this.windows.splice(this.windows.indexOf(window), 1);
        window.emit('unmanaged');
    }
}

class FakeWorkspaces extends Emitter {
    constructor() {
        super();
        this.active = 'ws1';
    }

    get_active_workspace() {
        return this.active;
    }

    switchTo(name) {
        this.active = name;
        this.emit('active-workspace-changed');
    }
}

class FakeSettings extends Emitter {
    constructor() {
        super();
        this.enabled = true;
    }

    get_boolean() {
        return this.enabled;
    }

    set(enabled) {
        this.enabled = enabled;
        this.emit('changed::pause-on-maximized');
    }
}

class FakeManager {
    constructor(targets) {
        this.targets = targets;
        this.listeners = new Set();
        this.calls = [];
        this.own = new Set();
    }

    onTargets(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    ownsWindow(window) {
        return this.own.has(window);
    }

    setPaused(key, reason, paused) {
        this.calls.push(`${key}:${reason}:${paused}`);
    }

    publish(targets) {
        this.targets = targets;
        for (const listener of this.listeners)
            listener(targets);
    }
}

const TARGETS = [{logicalMonitorKey: 'A', monitorIndex: 0}, {logicalMonitorKey: 'B', monitorIndex: 1}];

function setup(windows = [], targets = TARGETS) {
    const display = new FakeDisplay(windows);
    const workspaces = new FakeWorkspaces();
    const settings = new FakeSettings();
    const manager = new FakeManager(targets);
    const controller = new CoverageController({playerManager: manager, settings, display,
        workspaceManager: workspaces, normalType: NORMAL, maximizeBoth: BOTH, debounceMs: 20, logger: quiet});
    return {display, workspaces, settings, manager, controller};
}

function handlerCount(...emitters) {
    return emitters.reduce((sum, emitter) => sum + emitter.handlers.size, 0);
}

test('only visible normal windows maximized both ways or fullscreen cover their monitor', () => {
    const options = {workspace: 'ws1', isOwn: window => window.own === true, normalType: NORMAL, maximizeBoth: BOTH};
    const windows = [
        new FakeWindow({monitor: 0, flags: 1}),
        new FakeWindow({monitor: 1, flags: BOTH, minimized: true}),
        new FakeWindow({monitor: 2, flags: BOTH, workspace: 'ws2'}),
        new FakeWindow({monitor: 3, fullscreen: true, type: DIALOG}),
        Object.assign(new FakeWindow({monitor: 4, flags: BOTH}), {own: true}),
    ];
    assertDeepEqual([...coveredMonitors(windows, options)], [], 'nothing covers');
    windows.push(new FakeWindow({monitor: 5, flags: BOTH}), new FakeWindow({monitor: 6, fullscreen: true}),
        new FakeWindow({monitor: 7, flags: BOTH, workspace: 'all'}));
    assertDeepEqual([...coveredMonitors(windows, options)], [5, 6, 7], 'covering windows');
});

test('maximize pauses only its monitor within the debounce; unmaximize resumes', async () => {
    const window = new FakeWindow({monitor: 1});
    const {manager, controller} = setup([window]);
    controller.enable();
    assertDeepEqual(manager.calls, [`A:${COVERED}:false`, `B:${COVERED}:false`], 'initial state');
    manager.calls.length = 0;
    window.change({flags: BOTH}, 'notify::maximized-vertically');
    window.emit('position-changed');
    assertDeepEqual(manager.calls, [], 'debounced');
    await sleep(60);
    assertDeepEqual(manager.calls, [`B:${COVERED}:true`], 'only B covered, once');
    window.change({flags: 0}, 'notify::maximized-horizontally');
    await sleep(60);
    assertDeepEqual(manager.calls, [`B:${COVERED}:true`, `B:${COVERED}:false`]);
    controller.disable();
});

test('minimize, workspace switch, close and the setting all resume; own windows are ignored', async () => {
    const window = new FakeWindow({flags: BOTH});
    const {display, workspaces, settings, manager, controller} = setup([window]);
    controller.enable();
    const state = () => manager.calls.filter(call => call.startsWith('A:')).at(-1);
    assertEqual(state(), `A:${COVERED}:true`);
    window.change({minimized: true}, 'notify::minimized');
    await sleep(60);
    assertEqual(state(), `A:${COVERED}:false`, 'minimized');
    window.change({minimized: false}, 'notify::minimized');
    await sleep(60);
    workspaces.switchTo('ws2');
    await sleep(60);
    assertEqual(state(), `A:${COVERED}:false`, 'other workspace');
    workspaces.switchTo('ws1');
    await sleep(60);
    settings.set(false);
    await sleep(60);
    assertEqual(state(), `A:${COVERED}:false`, 'setting off');
    settings.set(true);
    await sleep(60);
    assertEqual(state(), `A:${COVERED}:true`, 'setting on');
    display.remove(window);
    await sleep(60);
    assertEqual(state(), `A:${COVERED}:false`, 'closed');
    assertEqual(window.handlers.size, 0, 'closed window disconnected');
    const own = new FakeWindow({fullscreen: true});
    manager.own.add(own);
    display.add(own);
    await sleep(60);
    assertEqual(state(), `A:${COVERED}:false`, 'own player window ignored');
    const browser = new FakeWindow({});
    display.add(browser);
    browser.change({fullscreen: true}, 'notify::fullscreen');
    display.emit('in-fullscreen-changed');
    await sleep(60);
    assertEqual(state(), `A:${COVERED}:true`, 'fullscreen browser');
    controller.disable();
});

test('new targets reapply coverage, so a restarted lifecycle starts covered', () => {
    const {manager, controller} = setup([new FakeWindow({flags: BOTH})], []);
    controller.enable();
    assertDeepEqual(manager.calls, []);
    manager.publish([TARGETS[0]]);
    manager.publish([TARGETS[0]]);
    assertDeepEqual(manager.calls, [`A:${COVERED}:true`, `A:${COVERED}:true`], 'reapplied after each resolve');
    controller.disable();
});

test('disable disconnects everything and cancels a pending recompute', async () => {
    const window = new FakeWindow({});
    const {display, workspaces, settings, manager, controller} = setup([window]);
    controller.enable();
    assertThrows(() => controller.enable(), 'double enable');
    manager.calls.length = 0;
    window.change({flags: BOTH}, 'notify::maximized-vertically');
    controller.disable();
    await sleep(60);
    assertDeepEqual(manager.calls, [], 'no stale recompute');
    assertEqual(handlerCount(display, workspaces, settings, window), 0, 'all handlers disconnected');
    assertEqual(manager.listeners.size, 0, 'target listener removed');
    controller.enable();
    assertEqual(manager.calls.at(-2), `A:${COVERED}:true`, 're-enable recomputes');
    controller.disable();
});

await run();
