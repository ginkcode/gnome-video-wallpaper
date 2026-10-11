import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TARGET = 'gink-video-wallpaper@ginkcode.github.io';

function report(event, details = {}) {
    console.log(`T20_RESULT ${JSON.stringify({event, ...details})}`);
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

export default class T20Probe extends Extension {
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

    async _expect(label, state, action) {
        const begin = GLib.get_monotonic_time();
        action();
        if (!await waitFor(() => player()?.state === state, 3000))
            throw new Error(`${label}: state stayed ${player()?.state}`);
        const ms = Math.round((GLib.get_monotonic_time() - begin) / 1000);
        this._steps.push({label, state, ms, pause: await player().ipc.command(['get_property', 'pause'])});
    }

    async _run() {
        this._steps = [];
        this._paint();
        await delay(1800);
        const overviewAtStart = Main.overview.visible;
        Main.extensionManager.enableExtension(TARGET);
        await delay(13000);
        const during = {state: player()?.state ?? 'none', pid: player()?.process?.pid ?? null,
            reasons: [...manager()?._reasons.values().next().value ?? []]};
        const hiddenAt = GLib.get_monotonic_time();
        Main.overview.hide();
        if (!await waitFor(() => player()?.state === 'playing', 10000))
            throw new Error(`not playing after the Overview closed (${player()?.state})`);
        report('startup', {overviewAtStart, during, playingMs: Math.round((GLib.get_monotonic_time() - hiddenAt) / 1000),
            samePid: player().process.pid === during.pid});
        await delay(500);
        await this._expect('overview-show', 'paused', () => Main.overview.show());
        await this._expect('overview-hide', 'playing', () => Main.overview.hide());
        const settings = Main.extensionManager.lookup(TARGET).stateObj.getSettings();
        settings.set_boolean('pause-on-overview', false);
        Main.overview.show();
        await delay(1500);
        const settingOff = player().state;
        await this._expect('setting-on-while-shown', 'paused', () => settings.set_boolean('pause-on-overview', true));
        await this._expect('hide-again', 'playing', () => Main.overview.hide());
        report('steps', {steps: this._steps, settingOff});
        Main.extensionManager.disableExtension(TARGET);
        await waitFor(() => manager() === null, 2000);
        await delay(1000);
        this._painting = false;
        global.context.terminate();
    }
}
