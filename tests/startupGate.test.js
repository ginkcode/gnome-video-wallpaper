import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {sleep} from '../lib/async.js';
import {waitForStartupOn} from '../lib/startupLifecycle.js';
import {assertEqual, run, test} from './harness.js';

class FakeLayout {
    constructor(startingUp, {onConnect = null} = {}) {
        this._startingUp = startingUp;
        this.handlers = new Map();
        this.nextId = 1;
        this.onConnect = onConnect;
    }

    connect(signal, callback) {
        const id = this.nextId++;
        this.handlers.set(id, {signal, callback});
        this.onConnect?.(this, callback);
        return id;
    }

    disconnect(id) {
        if (!this.handlers.delete(id))
            throw new Error(`unknown handler ${id}`);
    }

    complete() {
        this._startingUp = false;
        for (const {signal, callback} of [...this.handlers.values()]) {
            if (signal === 'startup-complete')
                callback();
        }
    }
}

function tracked(promise) {
    const state = {settled: null, error: null};
    promise.then(() => {
        state.settled = 'resolved';
    }, error => {
        state.settled = 'rejected';
        state.error = error;
    });
    return state;
}

function isCancelled(error) {
    return error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
}

test('already complete waits only the delay', async () => {
    const layout = new FakeLayout(false);
    const begin = GLib.get_monotonic_time();
    await waitForStartupOn(layout, {delayMs: 30});
    assertEqual((GLib.get_monotonic_time() - begin) / 1000 >= 29, true, 'delay honoured');
    assertEqual(layout.handlers.size, 0, 'signal disconnected');
});

test('waits for startup-complete, then the delay', async () => {
    const layout = new FakeLayout(true);
    let completions = 0;
    const state = tracked(waitForStartupOn(layout, {delayMs: 20, onComplete: () => completions++}));
    await sleep(30);
    assertEqual(state.settled, null, 'not before completion');
    layout.complete();
    await sleep(5);
    assertEqual(state.settled, null, 'not before delay');
    await sleep(30);
    assertEqual(state.settled, 'resolved', 'released after delay');
    assertEqual(completions, 1, 'completion observed once');
    assertEqual(layout.handlers.size, 0, 'signal disconnected');
});

test('completion racing listener registration is never missed', async () => {
    const silent = new FakeLayout(true, {onConnect: layout => {
        layout._startingUp = false;
    }});
    await waitForStartupOn(silent, {delayMs: 0});
    let completions = 0;
    const emitted = new FakeLayout(true, {onConnect: (layout, callback) => {
        layout._startingUp = false;
        callback();
    }});
    await waitForStartupOn(emitted, {delayMs: 0, onComplete: () => completions++});
    assertEqual(completions, 1, 'signal and flag count once');
    assertEqual(silent.handlers.size + emitted.handlers.size, 0, 'signals disconnected');
});

test('cancellation before completion, during the delay and up front rejects promptly', async () => {
    const layout = new FakeLayout(true);
    const early = new Gio.Cancellable();
    const first = tracked(waitForStartupOn(layout, {delayMs: 0, cancellable: early}));
    early.cancel();
    await sleep(1);
    assertEqual(isCancelled(first.error), true, 'cancelled while starting up');
    assertEqual(layout.handlers.size, 0, 'signal disconnected on cancel');
    layout.complete();

    const late = new Gio.Cancellable();
    const second = tracked(waitForStartupOn(new FakeLayout(false), {delayMs: 50, cancellable: late}));
    await sleep(5);
    late.cancel();
    await sleep(1);
    assertEqual(isCancelled(second.error), true, 'cancelled during delay');
    await sleep(60);
    assertEqual(second.settled, 'rejected', 'delay source removed');

    const before = new Gio.Cancellable();
    before.cancel();
    const third = tracked(waitForStartupOn(new FakeLayout(true), {cancellable: before}));
    await sleep(1);
    assertEqual(isCancelled(third.error), true, 'precancelled');
});

await run();
