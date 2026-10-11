import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import './shellPromisify.js';
import {readLine, spawnLines} from '../lib/async.js';

const loop = GLib.MainLoop.new(null, false);
let failures = 0;

function assert(condition, label) {
    if (!condition) {
        failures++;
        console.error(`FAIL ${label}`);
    }
}

(async () => {
    const lines = [];
    await spawnLines(['printf', '{"a":1}\\nsecond\\n'], {onLine: line => lines.push(line)});
    assert(lines.length === 2 && lines.every(line => typeof line === 'string') && JSON.parse(lines[0]).a === 1,
        `lines stay text when the shell promisified read_line_async first: ${lines}`);

    const stream = new Gio.DataInputStream({base_stream: Gio.MemoryInputStream.new_from_bytes(
        new GLib.Bytes(new TextEncoder().encode('one\n')))});
    assert(await readLine(stream) === 'one', 'readLine decodes UTF-8');
    assert(await readLine(stream) === null, 'readLine returns null at end of stream');
})().catch(error => {
    failures++;
    console.error(error);
}).finally(() => loop.quit());

loop.run();
if (failures)
    throw new Error(`${failures} assertion(s) failed`);
console.log('readLine tests passed');
