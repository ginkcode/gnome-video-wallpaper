import Gio from 'gi://Gio';

import {BackgroundLifecycle} from '../lib/backgroundLifecycle.js';
import {assertEqual, run, test} from './harness.js';

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

await run();
