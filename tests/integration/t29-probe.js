import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TARGET = 'gink-video-wallpaper@ginkcode.github.io';

function report(event, details = {}) {
    console.log(`T29_RESULT ${JSON.stringify({event, ...details})}`);
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

function indicator() {
    return Main.panel.statusArea[TARGET] ?? null;
}

function items() {
    return indicator().menu._getMenuItems().filter(item => item.label?.text);
}

export default class T29Probe extends Extension {
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

    async _snapshot(state) {
        if (!await waitFor(() => player()?.state === state, 10000))
            throw new Error(`state stayed ${player()?.state}, expected ${state}`);
        return {state, pause: await player().ipc.command(['get_property', 'pause']), label: items()[0].label.text};
    }

    async _run() {
        const steps = {};
        this._paint();
        await delay(1800);
        Main.overview.hide();
        Main.extensionManager.enableExtension(TARGET);
        await waitFor(() => manager(), 5000);
        const settings = Main.extensionManager.lookup(TARGET).stateObj._settings;
        await this._snapshot('playing');
        steps.shown = indicator() !== null && Main.panel._rightBox.contains(indicator());
        steps.labels = items().map(item => item.label.text);
        steps.status = [];
        for (const show of [true, false]) {
            if (show)
                Main.overview.show();
            else
                Main.overview.hide();
            const {label} = await this._snapshot(show ? 'paused' : 'playing');
            const status = indicator()._status;
            steps.status.push({label, status: status.visible ? status.label.text : null});
        }
        steps.toggle = [];
        for (const state of ['paused', 'playing']) {
            items()[0].activate(null);
            const {pause, label} = await this._snapshot(state);
            steps.toggle.push({label, paused: settings.get_boolean('paused'), state, pause});
        }
        steps.visibility = [];
        for (const shown of [false, true]) {
            settings.set_boolean('show-panel-indicator', shown);
            steps.visibility.push(indicator() !== null);
        }
        items()[0].activate(null);
        await this._snapshot('paused');
        Main.extensionManager.disableExtension(TARGET);
        await waitFor(() => manager() === null, 2000);
        Main.extensionManager.enableExtension(TARGET);
        await waitFor(() => manager(), 5000);
        steps.reenabled = await this._snapshot('paused');
        items()[0].activate(null);
        await this._snapshot('playing');
        Main.extensionManager.disableExtension(TARGET);
        await waitFor(() => manager() === null, 2000);
        steps.afterDisable = indicator() !== null;
        report('steps', steps);
        await delay(1000);
        this._painting = false;
        global.context.terminate();
    }
}
