import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {sleep} from '../lib/async.js';
import {BATTERY, OVERVIEW, SessionPauseController} from '../lib/sessionPauseController.js';
import {assertDeepEqual, assertEqual, assertThrows, run, test} from './harness.js';

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

class FakeOverview extends Emitter {
    constructor() {
        super();
        this.visible = false;
    }

    show() {
        this.visible = true;
        this.emit('showing');
    }

    hide() {
        this.emit('hiding');
        this.visible = false;
        this.emit('hidden');
    }
}

class FakeSettings extends Emitter {
    constructor() {
        super();
        this.values = {'pause-on-overview': true, 'pause-on-battery': true};
    }

    get_boolean(key) {
        return this.values[key];
    }

    set(key, value) {
        this.values[key] = value;
        this.emit(`changed::${key}`);
    }
}

class FakeBattery extends Emitter {
    constructor(onBattery) {
        super();
        this.onBattery = onBattery;
    }

    get_cached_property(name) {
        return name === 'OnBattery' ? new GLib.Variant('b', this.onBattery) : null;
    }

    set(onBattery) {
        this.onBattery = onBattery;
        this.emit('g-properties-changed');
    }
}

class FakeManager {
    constructor(targets = [{logicalMonitorKey: 'A'}, {logicalMonitorKey: 'B'}]) {
        this.targets = targets;
        this.listeners = new Set();
        this.reasons = new Map();
        this.calls = 0;
    }

    onTargets(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    setPaused(key, reason, paused) {
        this.calls++;
        const reasons = this.reasons.get(key) ?? new Set();
        if (paused)
            reasons.add(reason);
        else
            reasons.delete(reason);
        this.reasons.set(key, reasons);
    }

    publish(targets) {
        this.targets = targets;
        for (const listener of this.listeners)
            listener(targets);
    }

    of(key) {
        return [...this.reasons.get(key) ?? []].sort();
    }
}

function setup({battery = new FakeBattery(false), proxy = null} = {}) {
    const overview = new FakeOverview();
    const settings = new FakeSettings();
    const manager = new FakeManager();
    const controller = new SessionPauseController({playerManager: manager, settings, overview, logger: quiet,
        createBatteryProxy: proxy ?? (() => Promise.resolve(battery))});
    return {overview, settings, manager, controller, battery};
}

test('the Overview pauses every player and closing it resumes', async () => {
    const {overview, manager, controller} = setup();
    controller.enable();
    await sleep(1);
    overview.show();
    assertDeepEqual([manager.of('A'), manager.of('B')], [[OVERVIEW], [OVERVIEW]]);
    overview.hide();
    assertDeepEqual([manager.of('A'), manager.of('B')], [[], []]);
    controller.disable();
});

test('battery state pauses and resumes; both settings apply live', async () => {
    const {overview, settings, manager, controller, battery} = setup({battery: new FakeBattery(true)});
    controller.enable();
    await sleep(1);
    assertDeepEqual(manager.of('A'), [BATTERY], 'seeded from the proxy');
    battery.set(false);
    assertDeepEqual(manager.of('A'), [], 'AC plugged');
    battery.set(true);
    overview.show();
    assertDeepEqual(manager.of('A'), [BATTERY, OVERVIEW]);
    settings.set('pause-on-battery', false);
    assertDeepEqual(manager.of('A'), [OVERVIEW], 'battery setting off');
    settings.set('pause-on-overview', false);
    assertDeepEqual(manager.of('A'), [], 'overview setting off');
    settings.set('pause-on-overview', true);
    assertDeepEqual(manager.of('A'), [OVERVIEW], 'overview setting on');
    const calls = manager.calls;
    battery.emit('g-properties-changed');
    assertEqual(manager.calls, calls, 'unchanged state sends nothing');
    controller.disable();
});

test('state is seeded at enable and reapplied to each new target set', async () => {
    const {overview, manager, controller} = setup();
    overview.visible = true;
    manager.targets = [];
    controller.enable();
    await sleep(1);
    manager.publish([{logicalMonitorKey: 'A'}]);
    assertDeepEqual(manager.of('A'), [OVERVIEW], 'set before startup can clear its reason');
    manager.reasons.clear();
    manager.publish([{logicalMonitorKey: 'A'}]);
    assertDeepEqual(manager.of('A'), [OVERVIEW], 'reapplied after a restart cleared reasons');
    controller.disable();
});

test('a battery reply after disable cannot touch a new lifecycle', async () => {
    let resolveProxy;
    const battery = new FakeBattery(true);
    const proxy = cancellable => new Promise((resolve, reject) => {
        resolveProxy = () => resolve(battery);
        cancellable.connect(() => reject(new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED,
            'cancelled')));
    });
    const {manager, controller} = setup({proxy});
    controller.enable();
    assertThrows(() => controller.enable(), 'double enable');
    controller.disable();
    resolveProxy();
    await sleep(1);
    assertDeepEqual(manager.of('A'), [], 'no battery reason');
    assertEqual(battery.handlers.size, 0, 'late proxy not connected');
});

test('disable disconnects every signal and the target listener', async () => {
    const {overview, settings, manager, controller, battery} = setup();
    controller.enable();
    await sleep(1);
    controller.disable();
    const sizes = [overview, settings, battery].map(emitter => emitter.handlers.size);
    assertDeepEqual(sizes, [0, 0, 0]);
    assertEqual(manager.listeners.size, 0);
    overview.show();
    assertDeepEqual(manager.of('A'), []);
});

test('a missing UPower leaves only the Overview reason working', async () => {
    const {overview, manager, controller} = setup({proxy: () => Promise.reject(new Error('no upower'))});
    controller.enable();
    await sleep(1);
    overview.show();
    assertDeepEqual(manager.of('A'), [OVERVIEW]);
    controller.disable();
});

await run();
