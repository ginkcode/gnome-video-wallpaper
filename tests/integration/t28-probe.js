import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TARGET = 'gink-video-wallpaper@ginkcode.github.io';

function report(event, details = {}) {
    console.log(`T28_RESULT ${JSON.stringify({event, ...details})}`);
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
    return Main.extensionManager.lookup(TARGET) ?? null;
}

function player() {
    return extension()?.stateObj?._manager?._players.values().next().value ?? null;
}

export default class T28Probe extends Extension {
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
                await delay(50);
            }
        };
        tick();
    }

    async _run() {
        const steps = {};
        this._paint();
        await delay(1800);
        Main.overview.hide();
        const found = extension();
        steps.installed = found ? {path: found.path, version: found.metadata['version-name'] ?? null} : null;
        Main.extensionManager.enableExtension(TARGET);
        steps.playing = Boolean(await waitFor(() => player()?.state === 'playing', 15000));
        steps.stateEnabled = extension()?.state;
        steps.indicator = Boolean(Main.panel.statusArea[TARGET]);
        Main.extensionManager.disableExtension(TARGET);
        steps.stopped = Boolean(await waitFor(() => !extension()?.stateObj?._manager, 3000));
        steps.indicatorRemoved = !Main.panel.statusArea[TARGET];
        report('steps', steps);
        await delay(1000);
        this._painting = false;
        global.context.terminate();
    }
}
