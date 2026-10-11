import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {sleep, spawnAsync, waitUntil} from '../lib/async.js';

let failures = 0;

function assert(condition, label) {
    if (!condition) {
        failures++;
        console.error(`FAIL ${label}`);
    }
}

function isCancelled(error) {
    return error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED);
}

const loop = GLib.MainLoop.new(null, false);

(async () => {
    const ok = await spawnAsync(['true']);
    assert(ok.status === 0, `true status ${ok.status}`);

    const bad = await spawnAsync(['false']);
    assert(bad.status === 1, `false status ${bad.status}`);

    const cancellable = new Gio.Cancellable();
    const child = spawnAsync(['sleep', '30'], {cancellable});
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });
    try {
        await child;
        assert(false, 'cancelled child should reject');
    } catch (error) {
        assert(isCancelled(error), `child cancellation error ${error}`);
    }

    const sleepCancel = new Gio.Cancellable();
    const sleeper = sleep(5000, sleepCancel);
    sleepCancel.cancel();
    try {
        await sleeper;
        assert(false, 'cancelled sleep should reject');
    } catch (error) {
        assert(isCancelled(error), `sleep cancellation error ${error}`);
    }

    const started = Date.now();
    await sleep(20);
    assert(Date.now() - started >= 15, 'sleep waited');

    const handlers = new Map();
    const emitter = {
        ready: false,
        connect: (signal, callback) => {
            handlers.set(handlers.size + 1, callback);
            return handlers.size;
        },
        disconnect: id => handlers.delete(id),
        emit: () => [...handlers.values()].forEach(callback => callback()),
    };
    await waitUntil(emitter, 'hidden', () => true);
    assert(handlers.size === 0, 'ready state resolves without connecting');
    let resolved = false;
    const waiting = waitUntil(emitter, 'hidden', () => emitter.ready).then(() => {
        resolved = true;
    });
    emitter.emit();
    await sleep(1);
    assert(!resolved, 'signal without readiness keeps waiting');
    emitter.ready = true;
    emitter.emit();
    await waiting;
    assert(resolved && handlers.size === 0, 'resolved and disconnected');
    emitter.ready = false;
    const waitCancel = new Gio.Cancellable();
    const cancelledWait = waitUntil(emitter, 'hidden', () => emitter.ready, waitCancel);
    waitCancel.cancel();
    try {
        await cancelledWait;
        assert(false, 'cancelled wait should reject');
    } catch (error) {
        assert(isCancelled(error) && handlers.size === 0, `wait cancellation ${error}`);
    }
})().then(() => loop.quit()).catch(error => {
    failures++;
    console.error(error);
    loop.quit();
});

loop.run();

if (failures > 0)
    throw new Error(`${failures} assertion(s) failed`);
console.log('async tests passed');
