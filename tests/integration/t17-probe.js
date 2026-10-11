import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TARGET = 'gink-video-wallpaper@ginkcode.github.io';

function report(event, details = {}) {
    console.log(`T17_RESULT ${JSON.stringify({event, ...details})}`);
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

function background() {
    const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    return ['picture-uri', 'picture-uri-dark', 'picture-options'].map(key => settings.get_string(key));
}

function alive(pid) {
    return GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);
}

export default class T17Probe extends Extension {
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

    async _play(label) {
        if (!await waitFor(() => player()?.state === 'playing', 45000))
            throw new Error(`${label}: never played (state ${player()?.state ?? 'none'})`);
        return player().process.pid;
    }

    async _run() {
        this._paint();
        await delay(1800);
        Main.overview.hide();
        await delay(800);
        const original = background();
        Main.extensionManager.enableExtension(TARGET);
        const firstPid = await this._play('enable');
        const applied = background();
        Main.screenShield.lock(false);
        const lockedOff = Boolean(await waitFor(() => manager() === null, 5000));
        await delay(1500);
        report('locked', {original, applied, lockedOff, isLocked: Main.sessionMode.isLocked,
            mode: Main.sessionMode.currentMode, firstAlive: alive(firstPid), whileLocked: background()});
        Main.screenShield.deactivate(false);
        const unlockedAt = GLib.get_monotonic_time() / 1000;
        const secondPid = await this._play('unlock');
        report('unlocked', {secondPid, firstPid, resumeMs: GLib.get_monotonic_time() / 1000 - unlockedAt,
            mode: Main.sessionMode.currentMode, wallpaper: background()});
        Main.extensionManager.disableExtension(TARGET);
        await waitFor(() => manager() === null, 2000);
        await delay(1500);
        report('disabled', {restored: background(), secondAlive: alive(secondPid)});
        this._painting = false;
        global.context.terminate();
    }
}
