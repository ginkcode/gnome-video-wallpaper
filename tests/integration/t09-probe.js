import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TARGET = 'gink-video-wallpaper@ginkcode.github.io';
const CYCLES = Number(GLib.getenv('T09_CYCLES') ?? 50);

function report(event, details = {}) {
    console.log(`T09_RESULT ${JSON.stringify({event, ...details})}`);
}

function delay(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function waitFor(predicate, ms) {
    const deadline = GLib.get_monotonic_time() + ms * 1000;
    do {
        const result = predicate();
        if (result)
            return result;
        await delay(20);
    } while (GLib.get_monotonic_time() < deadline);
    return null;
}

function manager() {
    return Main.extensionManager.lookup(TARGET)?.stateObj?._manager ?? null;
}

function player() {
    return manager()?._players.values().next().value ?? null;
}

function boundary(lifecycle) {
    const record = player();
    if (!manager())
        return 'disabled';
    if (!record)
        return lifecycle.outstandingReapCount() ? 'awaiting-reap' : 'resolving-target';
    if (!record.process)
        return 'static-or-socket';
    if (!record.ipc?._connection)
        return 'connect';
    if (!record.layer?._clone)
        return 'load-or-readiness';
    if (record.state === 'starting')
        return 'fade';
    return record.state;
}

async function listSockets() {
    const dir = Gio.File.new_for_path(`${GLib.getenv('XDG_RUNTIME_DIR')}/gink-video-wallpaper`);
    const enumerator = await new Promise((resolve, reject) => dir.enumerate_children_async('standard::name',
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (file, result) => {
            try {
                resolve(file.enumerate_children_finish(result));
            } catch (error) {
                if (error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND))
                    resolve(null);
                else
                    reject(error);
            }
        }));
    if (!enumerator)
        return [];
    const names = [];
    for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null))
        names.push(info.get_name());
    enumerator.close(null);
    return names;
}

export default class T09Probe extends Extension {
    enable() {
        this._run().catch(error => {
            report('fail', {message: error.message, stack: error.stack});
            global.context.terminate();
        });
    }

    disable() {}

    async _capture(name) {
        const shot = new Shell.Screenshot();
        const [content, scale] = await shot.screenshot_stage_to_content();
        const stream = Gio.MemoryOutputStream.new_resizable();
        await Shell.Screenshot.composite_to_stream(content.get_texture(),
            0, 0, -1, -1, scale, null, 0, 0, 1, stream);
        stream.close(null);
        const path = `${GLib.getenv('T09_OUTPUT')}/${name}.png`;
        await new Promise((resolve, reject) => Gio.File.new_for_path(path).replace_contents_bytes_async(
            stream.steal_as_bytes(), null, false, Gio.FileCreateFlags.NONE, null, (file, result) => {
                try {
                    file.replace_contents_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            }));
        report('capture', {name});
    }

    async _property(name) {
        return player().ipc.command(['get_property', name]);
    }

    async _waitPlaying(label) {
        const ready = await waitFor(() => player()?.state === 'playing', 20000);
        if (!ready)
            throw new Error(`${label}: player did not reach playing (state ${player()?.state ?? 'none'})`);
    }

    async _playback(label) {
        const first = await this._property('time-pos');
        await delay(1000);
        const second = await this._property('time-pos');
        const optional = async name => this._property(name).catch(() => null);
        return {label, pause: await this._property('pause'), first, second, advancing: second > first,
            vo: await optional('current-vo'), displayFps: await optional('estimated-display-fps'),
            dropped: await optional('frame-drop-count'), delayed: await optional('vo-delayed-frame-count')};
    }

    async _run() {
        await delay(1800);
        Main.overview.hide();
        await delay(800);
        const lifecycle = await import(Main.extensionManager.lookup(TARGET).dir
            .get_child('lib/playerManagerLifecycle.js').get_uri());
        const group = Main.layoutManager._backgroundGroup;
        const baseline = group.get_n_children();
        report('baseline', {children: baseline});
        await this._capture('before-enable');
        Main.extensionManager.enableExtension(TARGET);
        await this._waitPlaying('initial');
        const record = player();
        const window = record.layer._window;
        await delay(300);
        await this._capture('playing');
        report('playing', {key: record.logicalMonitorKey, physical: record.selectedPhysicalMonitorId,
            identity: record.asset.identity, children: group.get_n_children(),
            focused: global.display.focus_window === window, skipTaskbar: window.skip_taskbar,
            playback: await this._playback('initial')});

        const key = record.logicalMonitorKey;
        const m = manager();
        m.setPaused(key, 't09-a', true);
        m.setPaused(key, 't09-b', true);
        m.setPaused(key, 't09-a', false);
        await delay(300);
        const oneReason = {state: m.getState(key), ...await this._playback('one-reason')};
        m.setPaused(key, 't09-b', false);
        await delay(300);
        const cleared = {state: m.getState(key), ...await this._playback('cleared')};
        report('pause-reasons', {oneReason, cleared});

        const boundaries = {};
        for (let cycle = 0; cycle < CYCLES; cycle++) {
            const at = boundary(lifecycle);
            boundaries[at] = (boundaries[at] ?? 0) + 1;
            Main.extensionManager.disableExtension(TARGET);
            Main.extensionManager.enableExtension(TARGET);
            await delay((cycle * 37) % 1100);
        }
        report('cycles', {cycles: CYCLES, boundaries});
        await this._waitPlaying('after-cycles');
        report('after-cycles', {playback: await this._playback('after-cycles'),
            children: group.get_n_children()});
        Main.extensionManager.disableExtension(TARGET);
        report('disabled', {children: group.get_n_children()});
        const reaped = await waitFor(() => lifecycle.outstandingReapCount() === 0, 5000);
        // Restoring the wallpaper makes the Shell cross-fade its own background actor for about 1 s.
        await waitFor(() => group.get_n_children() === baseline, 3000);
        await delay(300);
        report('audit', {reaped: Boolean(reaped), children: group.get_n_children(), baseline,
            sockets: await listSockets()});
        await this._capture('after-disable');

        Main.extensionManager.enableExtension(TARGET);
        await this._waitPlaying('exit');
        report('ready-for-exit', {mode: GLib.getenv('T09_EXIT'), pid: player().process.pid});
        if (GLib.getenv('T09_EXIT') === 'normal') {
            await delay(300);
            global.context.terminate();
        }
    }
}
