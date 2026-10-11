import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {sleep} from '../lib/async.js';
import {LIVE_KEYS, LiveSettings} from '../lib/liveSettings.js';
import {assertDeepEqual, assertEqual, run, test} from './harness.js';

class FakeSettings {
    constructor() {
        this.handlers = new Map();
        this.next = 1;
    }

    connect(signal, callback) {
        const id = this.next++;
        this.handlers.set(id, {signal, callback});
        return id;
    }

    disconnect(id) {
        this.handlers.delete(id);
    }

    emit(signal) {
        for (const handler of [...this.handlers.values()]) {
            if (handler.signal === signal)
                handler.callback();
        }
    }
}

test('live keys are watched and bursts are debounced into one change', async () => {
    const settings = new FakeSettings();
    let changes = 0;
    const live = new LiveSettings({settings, onChange: () => changes++, debounceMs: 30});
    live.enable();
    assertDeepEqual([...settings.handlers.values()].map(handler => handler.signal),
        LIVE_KEYS.map(key => `changed::${key}`));
    for (const key of [...LIVE_KEYS, ...LIVE_KEYS]) {
        settings.emit(`changed::${key}`);
        await sleep(5);
    }
    settings.emit('changed::debug-logging');
    assertEqual(changes, 0, 'nothing before the quiet period');
    await sleep(80);
    assertEqual(changes, 1);
    settings.emit('changed::video-output');
    await sleep(80);
    assertEqual(changes, 2);
    settings.emit('changed::monitor-configs');
    live.disable();
    await sleep(80);
    assertEqual(changes, 2, 'pending change dropped on disable');
    assertEqual(settings.handlers.size, 0, 'handlers disconnected');
});

test('a file appearing in a watched directory requests one change, removal does not', async () => {
    const root = GLib.dir_make_tmp('gink-vw-live-XXXXXX');
    const media = `${root}/media`;
    let changes = 0;
    const live = new LiveSettings({settings: new FakeSettings(), onChange: () => changes++, debounceMs: 30,
        directories: [media]});
    try {
        live.enable();
        await sleep(100);
        assertEqual(GLib.file_test(media, GLib.FileTest.IS_DIR), true, 'directory created');
        GLib.file_set_contents(`${root}/temp.mp4`, 'x');
        Gio.File.new_for_path(`${root}/temp.mp4`).move(Gio.File.new_for_path(`${media}/a.mp4`),
            Gio.FileCopyFlags.NONE, null, null);
        await sleep(150);
        assertEqual(changes, 1, 'moved in');
        Gio.File.new_for_path(`${media}/a.mp4`).delete(null);
        await sleep(150);
        assertEqual(changes, 1, 'deletion ignored');
    } finally {
        live.disable();
        Gio.Subprocess.new(['rm', '-rf', root], Gio.SubprocessFlags.NONE).wait(null);
    }
});

test('disable during directory setup leaves no monitors or callback', async () => {
    const root = GLib.dir_make_tmp('gink-vw-live-stop-XXXXXX');
    let changes = 0;
    const live = new LiveSettings({settings: new FakeSettings(), onChange: () => changes++,
        directories: [`${root}/cache/media`]});
    try {
        live.enable();
        live.disable();
        await sleep(100);
        assertEqual(live._monitors.length, 0);
        assertEqual(changes, 0);
    } finally {
        live.disable();
        Gio.Subprocess.new(['rm', '-rf', root], Gio.SubprocessFlags.NONE).wait(null);
    }
});

await run();
