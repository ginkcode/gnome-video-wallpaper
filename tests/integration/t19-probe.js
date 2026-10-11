import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TARGET = 'gink-video-wallpaper@ginkcode.github.io';

function report(event, details = {}) {
    console.log(`T19_RESULT ${JSON.stringify({event, ...details})}`);
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

function cpuTicks(pid) {
    const [, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
    const fields = new TextDecoder().decode(bytes).split(') ')[1].split(' ');
    return Number(fields[11]) + Number(fields[12]);
}

export default class T19Probe extends Extension {
    enable() {
        this._run().catch(error => {
            report('fail', {message: error.message, stack: error.stack});
            this._foreign?.force_exit();
            global.context.terminate();
        });
    }

    disable() {}

    // A headless stage only paints for consumers; captures stand in for a display.
    _paint() {
        this._painting = true;
        const tick = async () => {
            while (this._painting) {
                await new Shell.Screenshot().screenshot_stage_to_content().catch(() => {});
                await delay(100);
            }
        };
        tick();
    }

    async _expect(label, state, action) {
        const begin = GLib.get_monotonic_time();
        action();
        if (!await waitFor(() => player()?.state === state, 3000))
            throw new Error(`${label}: state stayed ${player()?.state}`);
        const ms = (GLib.get_monotonic_time() - begin) / 1000;
        const pause = await player().ipc.command(['get_property', 'pause']);
        this._steps.push({label, state, ms: Math.round(ms), pause});
    }

    async _run() {
        this._steps = [];
        this._paint();
        await delay(1800);
        Main.overview.hide();
        await delay(800);
        Main.extensionManager.enableExtension(TARGET);
        if (!await waitFor(() => player()?.state === 'playing', 45000))
            throw new Error('never played');
        const pid = player().process.pid;
        this._foreign = Gio.Subprocess.new(['mpv', '--no-config', '--idle=yes', '--force-window=yes',
            '--vo=wlshm', '--title=t19-foreign'], Gio.SubprocessFlags.NONE);
        const foreignPid = Number(this._foreign.get_identifier());
        const window = await waitFor(() => global.display.list_all_windows()
            .find(w => w.get_pid() === foreignPid && w.get_window_type() === Meta.WindowType.NORMAL), 15000);
        if (!window)
            throw new Error('foreign window never mapped');
        await delay(500);
        if (player().state !== 'playing')
            throw new Error(`unmaximized foreign window paused playback (${player().state})`);
        await this._expect('maximize', 'paused', () => window.maximize());
        const before = cpuTicks(pid);
        await delay(3000);
        const pausedTicks = cpuTicks(pid) - before;
        await this._expect('unmaximize', 'playing', () => window.unmaximize());
        const playingBefore = cpuTicks(pid);
        await delay(3000);
        const playingTicks = cpuTicks(pid) - playingBefore;
        await this._expect('maximize-again', 'paused', () => window.maximize());
        await this._expect('minimize', 'playing', () => window.minimize());
        await this._expect('unminimize', 'paused', () => window.unminimize());
        const workspaces = global.workspace_manager;
        if (workspaces.n_workspaces < 2)
            workspaces.append_new_workspace(false, global.get_current_time());
        await this._expect('other-workspace', 'playing',
            () => workspaces.get_workspace_by_index(1).activate(global.get_current_time()));
        await this._expect('back-workspace', 'paused',
            () => workspaces.get_workspace_by_index(0).activate(global.get_current_time()));
        const settings = Main.extensionManager.lookup(TARGET).stateObj.getSettings();
        await this._expect('setting-off', 'playing', () => settings.set_boolean('pause-on-maximized', false));
        await this._expect('setting-on', 'paused', () => settings.set_boolean('pause-on-maximized', true));
        await this._expect('unmaximize-for-fullscreen', 'playing', () => window.unmaximize());
        await this._expect('fullscreen', 'paused', () => window.make_fullscreen());
        await this._expect('unfullscreen', 'playing', () => window.unmake_fullscreen());
        await this._expect('maximize-before-close', 'paused', () => window.maximize());
        await this._expect('close', 'playing', () => this._foreign.force_exit());
        report('steps', {steps: this._steps, pausedTicks, playingTicks});
        Main.extensionManager.disableExtension(TARGET);
        await waitFor(() => manager() === null, 2000);
        await delay(1000);
        this._painting = false;
        global.context.terminate();
    }
}
