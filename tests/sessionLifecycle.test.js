import {watchSleep} from '../lib/sessionLifecycle.js';
import {assertDeepEqual, assertEqual, run, test} from './harness.js';

class FakeLoginManager {
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

    emit(aboutToSuspend) {
        for (const {signal, callback} of [...this.handlers.values()]) {
            if (signal === 'prepare-for-sleep')
                callback(this, aboutToSuspend);
        }
    }
}

test('sleep stops and resume restarts once per pair; unwatch disconnects', () => {
    const login = new FakeLoginManager();
    const events = [];
    const unwatch = watchSleep(login, {onSleep: () => events.push('sleep'), onResume: () => events.push('resume')});
    login.emit(false);
    for (let i = 0; i < 5; i++) {
        login.emit(true);
        login.emit(true);
        login.emit(false);
    }
    assertDeepEqual(events, Array.from({length: 5}, () => ['sleep', 'resume']).flat());
    unwatch();
    assertEqual(login.handlers.size, 0, 'disconnected');
    login.emit(true);
    assertEqual(events.length, 10, 'no events after unwatch');
});

await run();
