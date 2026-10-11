import {USER, UserPauseController} from '../lib/userPauseController.js';
import {assertDeepEqual, assertEqual, assertThrows, run, test} from './harness.js';

const quiet = {debug() {}, info() {}, warn() {}, error() {}};

class FakeSettings {
    constructor(paused = false) {
        this.paused = paused;
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

    get_boolean(key) {
        if (key !== 'paused')
            throw new Error(`unexpected key ${key}`);
        return this.paused;
    }

    set(paused) {
        this.paused = paused;
        for (const handler of [...this.handlers.values()]) {
            if (handler.signal === 'changed::paused')
                handler.callback(this, 'paused');
        }
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

function setup(paused = false) {
    const settings = new FakeSettings(paused);
    const manager = new FakeManager();
    const controller = new UserPauseController({playerManager: manager, settings, logger: quiet});
    return {settings, manager, controller};
}

test('the paused setting pauses and resumes every player', () => {
    const {settings, manager, controller} = setup();
    controller.enable();
    assertDeepEqual([manager.of('A'), manager.of('B')], [[], []]);
    settings.set(true);
    assertDeepEqual([manager.of('A'), manager.of('B')], [[USER], [USER]]);
    settings.set(false);
    assertDeepEqual([manager.of('A'), manager.of('B')], [[], []]);
    const calls = manager.calls;
    settings.set(false);
    assertEqual(manager.calls, calls, 'unchanged state sends nothing');
    controller.disable();
});

test('the user reason composes with other reasons', () => {
    const {settings, manager, controller} = setup();
    controller.enable();
    manager.setPaused('A', 'overview', true);
    settings.set(true);
    settings.set(false);
    assertDeepEqual(manager.of('A'), ['overview']);
    controller.disable();
});

test('a saved pause is seeded and reapplied to each new target set', () => {
    const {manager, controller} = setup(true);
    manager.targets = [];
    controller.enable();
    manager.publish([{logicalMonitorKey: 'A'}]);
    assertDeepEqual(manager.of('A'), [USER], 'set before startup can clear its reason');
    manager.reasons.clear();
    manager.publish([{logicalMonitorKey: 'A'}]);
    assertDeepEqual(manager.of('A'), [USER], 'reapplied after a restart cleared reasons');
    controller.disable();
});

test('disable disconnects the setting and the target listener', () => {
    const {settings, manager, controller} = setup();
    controller.enable();
    assertThrows(() => controller.enable(), 'double enable');
    controller.disable();
    assertEqual(settings.handlers.size, 0);
    assertEqual(manager.listeners.size, 0);
    settings.set(true);
    assertDeepEqual(manager.of('A'), []);
});

await run();
