import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WorkspaceGroup} from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

const TARGET = 'gink-video-wallpaper@ginkcode.github.io';
const CLIENT = 'gink-t31-client';

function report(event, details = {}) {
    console.log(`T31_RESULT ${JSON.stringify({event, ...details})}`);
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

function client() {
    return global.display.list_all_windows().find(window => window.get_title() === CLIENT) ?? null;
}

function activeIndex() {
    return global.workspace_manager.get_active_workspace_index();
}

export default class T31Probe extends Extension {
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

    // Window records of every workspace-animation group that clone a player window.
    _ownedRecords() {
        const switchData = Main.wm._workspaceAnimation._switchData;
        if (!switchData)
            return null;
        const groups = [];
        const walk = actor => {
            if (actor._windowRecords)
                groups.push(actor);
            actor.get_children().forEach(walk);
        };
        switchData.monitors.forEach(walk);
        return groups.flatMap(group => group._windowRecords)
            .filter(record => manager().ownsWindow(record.windowActor.meta_window)).length;
    }

    async _switch(index) {
        const visits = [];
        const id = global.workspace_manager.connect('active-workspace-changed', () => visits.push(activeIndex()));
        Main.wm.actionMoveWorkspace(global.workspace_manager.get_workspace_by_index(index));
        await delay(16);
        const ownedClones = this._ownedRecords();
        await delay(2000);
        global.workspace_manager.disconnect(id);
        return {visits, active: activeIndex(), ownedClones, focus: global.display.focus_window?.get_title() ?? null};
    }

    // Mutter may give default focus to the sticky player on an emptier workspace.
    async _steal() {
        const visits = [];
        const id = global.workspace_manager.connect('active-workspace-changed', () => visits.push(activeIndex()));
        const owned = global.display.list_all_windows().find(window => manager().ownsWindow(window));
        owned.focus(global.display.get_current_time_roundtrip());
        await delay(1500);
        global.workspace_manager.disconnect(id);
        return {visits, active: activeIndex(), focus: global.display.focus_window?.get_title() ?? null,
            attention: client().demands_attention};
    }

    async _run() {
        const steps = {};
        const original = WorkspaceGroup.prototype._shouldShowWindow;
        this._paint();
        await delay(1800);
        Main.overview.hide();
        Main.extensionManager.enableExtension(TARGET);
        await waitFor(() => manager(), 5000);
        if (!await waitFor(() => player()?.state === 'playing', 15000))
            throw new Error(`not started: ${player()?.state}`);
        const proc = Gio.Subprocess.new(['mpv', '--no-config', '--force-window=yes', '--idle=yes',
            `--title=${CLIENT}`, '--geometry=400x300'], Gio.SubprocessFlags.NONE);
        try {
            const window = await waitFor(() => client(), 10000);
            if (!window)
                throw new Error('client window did not appear');
            await delay(500);
            window.activate(global.get_current_time());
            await waitFor(() => global.display.focus_window === window, 2000);
            if (global.workspace_manager.n_workspaces < 2)
                global.workspace_manager.append_new_workspace(false, global.get_current_time());
            steps.workspaces = global.workspace_manager.n_workspaces;
            steps.start = {active: activeIndex(), focus: global.display.focus_window?.get_title() ?? null};
            steps.away = await this._switch(1);
            steps.stolen = await this._steal();
            steps.back = await this._switch(0);
        } finally {
            proc.force_exit();
        }
        Main.extensionManager.disableExtension(TARGET);
        await waitFor(() => manager() === null, 2000);
        steps.restored = WorkspaceGroup.prototype._shouldShowWindow === original;
        report('steps', steps);
        await delay(1000);
        this._painting = false;
        global.context.terminate();
    }
}
