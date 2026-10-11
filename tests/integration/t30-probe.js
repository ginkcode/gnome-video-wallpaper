import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TARGET = 'gink-video-wallpaper@ginkcode.github.io';

function report(event, details = {}) {
    console.log(`T30_RESULT ${JSON.stringify({event, ...details})}`);
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

function extension() {
    return Main.extensionManager.lookup(TARGET)?.stateObj ?? null;
}

function manager() {
    return extension()?._manager ?? null;
}

function player() {
    return manager()?._players.values().next().value ?? null;
}

function file() {
    return manager()?.targets[0]?.file ?? null;
}

function menuItem(text) {
    return Main.panel.statusArea[TARGET].menu._getMenuItems().find(item => item.label?.text === text);
}

export default class T30Probe extends Extension {
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

    async _settle(previous, state = 'playing') {
        const pid = player()?.process?.pid;
        const ok = await waitFor(() => file() && file() !== previous && player()?.state === state &&
            player().process?.pid !== pid, 15000);
        if (!ok)
            throw new Error(`no change from ${previous}: file ${file()} state ${player()?.state}`);
    }

    async _change(action) {
        const previous = file();
        action();
        await this._settle(previous);
        this._steps.files.push(file());
        this._steps.states.push(player().state);
        this._steps.pids.push(player().process.pid);
    }

    async _enable() {
        Main.extensionManager.enableExtension(TARGET);
        await waitFor(() => manager(), 5000);
        if (!await waitFor(() => player()?.state === 'playing' || player()?.state === 'paused', 15000))
            throw new Error(`not started: ${player()?.state}`);
    }

    async _run() {
        this._steps = {files: [], states: [], pids: []};
        this._paint();
        await delay(1800);
        Main.overview.hide();
        await this._enable();
        this._steps.files.push(file());
        this._steps.states.push(player().state);
        this._steps.pids.push(player().process.pid);
        for (let index = 0; index < 3; index++)
            await this._change(() => extension()._playlist.advance());
        await this._change(() => menuItem('Next Video').activate(null));
        const settings = extension()._settings;
        this._steps.saved = Object.values(JSON.parse(settings.get_string('playlist-state')))[0] ?? null;
        Main.extensionManager.disableExtension(TARGET);
        await waitFor(() => manager() === null, 2000);
        await this._enable();
        this._steps.reenabled = file();
        menuItem('Pause').activate(null);
        await waitFor(() => player()?.state === 'paused', 3000);
        const previous = file();
        extension()._playlist.advance();
        await this._settle(previous, 'paused');
        this._steps.pausedAdvance = {file: GLib.path_get_basename(file()).replace(/\.mp4$/, ''),
            state: player().state};
        extension()._settings.set_boolean('paused', false);
        Main.extensionManager.disableExtension(TARGET);
        await waitFor(() => manager() === null, 2000);
        report('steps', this._steps);
        await delay(1000);
        this._painting = false;
        global.context.terminate();
    }
}
