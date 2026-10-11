import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TARGET = 'gink-video-wallpaper@ginkcode.github.io';

function report(event, details = {}) {
    console.log(`T16_RESULT ${JSON.stringify({event, ...details})}`);
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

function notifications() {
    return Main.messageTray.getSources()
        .filter(source => source.title === 'Gink Video Wallpaper')
        .flatMap(source => source.notifications.map(n => ({title: n.title, body: n.body,
            actions: n.actions.map(action => action.label)})));
}

export default class T16Probe extends Extension {
    enable() {
        this._run().catch(error => {
            report('fail', {message: error.message, stack: error.stack});
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

    async _run() {
        this._paint();
        await delay(1800);
        Main.overview.hide();
        await delay(800);
        Main.extensionManager.enableExtension(TARGET);
        const pids = [];
        const kills = [];
        for (let i = 0; i < 3; i++) {
            if (!await waitFor(() => player()?.state === 'playing', 45000))
                throw new Error(`attempt ${i} never played (state ${player()?.state ?? 'none'})`);
            const pid = player().process.pid;
            pids.push(pid);
            kills.push(GLib.get_monotonic_time() / 1000);
            Gio.Subprocess.new(['kill', '-9', String(pid)], Gio.SubprocessFlags.NONE);
            if (!await waitFor(() => player()?.state === 'failed', 5000))
                throw new Error(`attempt ${i} did not fail after kill`);
        }
        const respawns = [];
        await delay(40000);
        const record = player();
        report('supervised', {pids, kills, respawns, state: record?.state, retained: Boolean(record?.process &&
            record.process.pid === pids[2]), still: record?.layer?._static?.opacity === 255 &&
            !record.layer._lifecycle.destroyed, notifications: notifications()});
        Main.extensionManager.disableExtension(TARGET);
        await waitFor(() => manager() === null, 2000);
        await delay(1000);
        report('disabled', {notifications: notifications()});
        this._painting = false;
        global.context.terminate();
    }
}
