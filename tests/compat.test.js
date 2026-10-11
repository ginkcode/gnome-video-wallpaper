import {ExtensionStateValue, HANABI_UUID, HanabiWatcher, hanabiActive, stateFromInfo} from '../lib/compat.js';
import {assertDeepEqual, assertEqual, run, test} from './harness.js';

class FakeManager {
    constructor() {
        this.extensions = new Map();
        this.handlers = new Map();
        this.nextId = 1;
    }

    lookup(uuid) {
        return this.extensions.get(uuid);
    }

    connect(signal, callback) {
        const id = this.nextId++;
        this.handlers.set(id, {signal, callback});
        return id;
    }

    disconnect(id) {
        this.handlers.delete(id);
    }

    set(uuid, state) {
        const extension = {uuid, state};
        this.extensions.set(uuid, extension);
        for (const {signal, callback} of [...this.handlers.values()]) {
            if (signal === 'extension-state-changed')
                callback(this, extension);
        }
    }
}

test('shell state decides when known', () => {
    assertEqual(hanabiActive({state: ExtensionStateValue.ACTIVE}), true, 'active');
    assertEqual(hanabiActive({state: 2, enabled: [HANABI_UUID]}), false, 'inactive despite setting');
    assertEqual(hanabiActive({state: 3, enabled: [HANABI_UUID]}), false, 'error state');
    assertEqual(hanabiActive({state: ExtensionStateValue.UNINSTALLED, enabled: [HANABI_UUID]}), false,
        'listed but not installed');
});

test('settings decide without shell state', () => {
    assertEqual(hanabiActive({enabled: [HANABI_UUID]}), true, 'enabled');
    assertEqual(hanabiActive({enabled: ['other@x']}), false, 'absent');
    assertEqual(hanabiActive({enabled: [HANABI_UUID], disabled: [HANABI_UUID]}), false, 'disabled list');
    assertEqual(hanabiActive({enabled: [HANABI_UUID], userExtensionsDisabled: true}), false, 'user disabled');
    assertEqual(hanabiActive(), false, 'defaults');
});

test('extension info maps to a state', () => {
    assertEqual(stateFromInfo({state: 1, enabled: true}), 1, 'numeric state');
    assertEqual(stateFromInfo({}), ExtensionStateValue.UNINSTALLED, 'empty info is uninstalled');
    assertEqual(stateFromInfo(null), ExtensionStateValue.UNINSTALLED, 'missing info');
});

test('watcher reports transitions and disconnects on disable', () => {
    const manager = new FakeManager();
    const seen = [];
    const watcher = new HanabiWatcher({extensionManager: manager, onChange: active => seen.push(active)});
    watcher.enable();
    assertEqual(watcher.active, false, 'not installed');
    manager.set('other@x', ExtensionStateValue.ACTIVE);
    manager.set(HANABI_UUID, 8);
    manager.set(HANABI_UUID, ExtensionStateValue.ACTIVE);
    manager.set(HANABI_UUID, ExtensionStateValue.ACTIVE);
    manager.set(HANABI_UUID, 2);
    assertDeepEqual(seen, [true, false], 'transitions');
    watcher.disable();
    assertEqual(manager.handlers.size, 0, 'handlers released');
    manager.set(HANABI_UUID, ExtensionStateValue.ACTIVE);
    assertDeepEqual(seen, [true, false], 'silent after disable');
});

test('watcher detects Hanabi already active at enable', () => {
    const manager = new FakeManager();
    manager.set(HANABI_UUID, ExtensionStateValue.ACTIVE);
    const watcher = new HanabiWatcher({extensionManager: manager});
    watcher.enable();
    assertEqual(watcher.active, true, 'active');
    watcher.disable();
    assertEqual(watcher.active, false, 'reset');
});

await run();
