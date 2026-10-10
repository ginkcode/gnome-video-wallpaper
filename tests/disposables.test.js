import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {Disposables} from '../lib/disposables.js';

let failures = 0;

function assert(condition, label) {
    if (!condition) {
        failures++;
        console.error(`FAIL ${label}`);
    }
}

const Emitter = GObject.registerClass({
    Signals: {'pinged': {}},
}, class Emitter extends GObject.Object {});

const emitter = new Emitter();
const disposables = new Disposables();
const order = [];

disposables.add(() => order.push('first'));
disposables.add(() => order.push('second'));
disposables.add(() => {
    order.push('throws');
    throw new Error('cleanup boom');
});

let signalCount = 0;
disposables.connect(emitter, 'pinged', () => {
    signalCount++;
});
emitter.emit('pinged');
assert(signalCount === 1, 'signal connected');

let ticks = 0;
disposables.timeout(10, () => {
    ticks++;
    return GLib.SOURCE_REMOVE;
});

const cancellable = disposables.cancellable();
assert(!cancellable.is_cancelled(), 'cancellable starts open');

const loop = GLib.MainLoop.new(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
    assert(ticks === 1, 'timeout ran once');
    disposables.dispose();
    assert(order.join(',') === 'throws,second,first', 'cleanup runs reverse, including failures');
    assert(cancellable.is_cancelled(), 'cancellable cancelled');
    emitter.emit('pinged');
    assert(signalCount === 1, 'signal disconnected');
    disposables.dispose();
    assert(order.length === 3, 'second dispose is a no-op');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();

if (failures > 0)
    throw new Error(`${failures} assertion(s) failed`);
console.log('disposables tests passed');
