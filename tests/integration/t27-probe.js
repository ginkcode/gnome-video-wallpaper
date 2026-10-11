import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta?version=18';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');
Gio._promisify(Gio.OutputStream.prototype, 'close_async', 'close_finish');

const IFACE = `<node><interface name="org.ginkcode.T27Probe">
<method name="State"><arg type="s" direction="out"/></method>
<method name="Capture"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
<method name="Toggle"><arg type="s" direction="in"/><arg type="b" direction="in"/><arg type="b" direction="out"/></method>
<method name="Lock"><arg type="b" direction="in"/><arg type="b" direction="out"/></method>
<method name="HideOverview"><arg type="b" direction="out"/></method>
<method name="ResetEvents"><arg type="b" direction="out"/></method>
</interface></node>`;
const APP_ID = 'gink-video-wallpaper';
const TARGET = 'gink-video-wallpaper@ginkcode.github.io';

const isOurs = window => window && (window.get_wm_class() === APP_ID || window.get_gtk_application_id() === APP_ID);

function rect(actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height)};
}

function find(actor, predicate, found = []) {
    if (predicate(actor))
        found.push(actor);
    for (const child of actor.get_children())
        find(child, predicate, found);
    return found;
}

function processState(pid) {
    try {
        const stat = new TextDecoder().decode(GLib.file_get_contents(`/proc/${pid}/stat`)[1]);
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    } catch {
        return null;
    }
}

function docks() {
    return find(global.stage, actor => actor.name === 'dashtodockContainer').map(container => {
        const icons = find(container, actor => actor.app instanceof Shell.App && actor.is_visible?.())
            .map(actor => actor.app);
        return {visible: container.visible, mapped: container.is_mapped(), rect: rect(container),
            dockState: container.dockState ?? container._dockState ?? container.getDockState?.() ?? null, overlap: container._intellihide?.getOverlapStatus?.() ?? null,
            icons: icons.map(app => app.get_id()),
            ourIcons: icons.filter(app => app.get_windows().some(isOurs)).map(app => app.get_id())};
    });
}

export default class T27Probe extends Extension {
    enable() {
        this._events = [];
        this._painting = true;
        this._tick();
        const appSystem = Shell.AppSystem.get_default();
        this._appId = appSystem.connect('app-state-changed', (_s, app) => {
            if (app.get_windows().some(isOurs))
                this._event('app-state', {app: app.get_id(), state: app.state});
        });
        this._focusId = global.display.connect('notify::focus-window', () => {
            const w = global.display.focus_window;
            this._event('focus', {pid: w?.get_pid() ?? null, id: w?.get_id() ?? null, ours: isOurs(w), wmClass: w?.get_wm_class() ?? null});
        });
        this._createdId = global.display.connect('window-created', (_d, window) => {
            for (const signal of ['unmanaging', 'unmanaged']) {
                window.connect(signal, () => {
                    if (isOurs(window))
                        this._event(signal, {pid: window.get_pid(), id: window.get_id(), focused: window.has_focus()});
                });
            }
            if (!isOurs(window))
                return;
            const app = Shell.WindowTracker.get_default().get_window_app(window);
            this._event('window-created', {pid: window.get_pid(), skipTaskbar: window.skip_taskbar,
                app: app?.get_id() ?? null, appState: app?.state ?? null});
            window.connect('notify::skip-taskbar', () => this._event('skip-taskbar', {pid: window.get_pid(),
                skipTaskbar: window.skip_taskbar}));
        });
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, '/org/ginkcode/T27Probe');
        this._owner = Gio.bus_own_name(Gio.BusType.SESSION, 'org.ginkcode.T27Probe', Gio.BusNameOwnerFlags.NONE,
            null, null, null);
    }

    disable() {
        this._painting = false;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        Shell.AppSystem.get_default().disconnect(this._appId);
        global.display.disconnect(this._createdId);
        global.display.disconnect(this._focusId);
        Gio.bus_unown_name(this._owner);
        this._dbus.unexport();
        this._dbus = null;
    }

    _event(kind, data) {
        this._events.push({kind, t: Math.round(GLib.get_monotonic_time() / 1000), ...data});
    }

    // A headless stage only paints for consumers; captures stand in for a display.
    _tick() {
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._timer = 0;
            try {
                for (const dock of docks()) {
                    if (dock.ourIcons.length > 0)
                        this._event('dock-icon', {icons: dock.ourIcons});
                }
            } catch (error) {
                this._event('dock-scan-error', {message: error.message});
            }
            new Shell.Screenshot().screenshot_stage_to_content().catch(() => {}).finally(() => {
                if (this._painting)
                    this._tick();
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    State() {
        const tracker = Shell.WindowTracker.get_default();
        const ours = Main.extensionManager.lookup(TARGET);
        const windows = global.get_window_actors().map(actor => [actor, actor.meta_window]).filter(([, w]) => isOurs(w))
            .map(([actor, window]) => {
                const app = tracker.get_window_app(window);
                return {pid: window.get_pid(), id: window.get_id(), process: processState(window.get_pid()), skipTaskbar: window.skip_taskbar, monitor: window.get_monitor(),
                    frame: (({x, y, width, height}) => ({x, y, width, height}))(window.get_frame_rect()),
                    fullscreen: window.fullscreen, maximized: window.maximized_horizontally || window.maximized_vertically,
                    minimized: window.minimized, showing: window.showing_on_its_workspace(),
                    focused: window.has_focus(), type: window.get_window_type(), frameType: window.get_frame_type(),
                    app: app?.get_id() ?? null, appState: app?.state ?? null,
                    destroying: Main.wm._destroying?.has(actor) ?? null, transitions: ['opacity', 'scale-x'].filter(t => actor.get_transition(t)),
                    actorOpacity: actor.opacity, actorVisible: actor.visible,
                    children: actor.get_children().map(child => ({name: child.name ?? null,
                        type: child.constructor.name, opacity: child.opacity, visible: child.visible})),
                    effects: actor.get_effects().map(effect => effect.constructor.name)};
            });
        const players = ours?.stateObj?._manager?._players;
        const layers = players ? [...players.values()].map(record => {
            const clone = record.layer?._clone;
            return {key: record.logicalMonitorKey, state: record.state, pid: record.process?.pid ?? null,
                clone: clone ? {...rect(clone), visible: clone.is_visible(), mapped: clone.is_mapped(),
                    opacity: clone.opacity, effects: clone.get_effects().map(e => e.constructor.name)} : null};
        }) : [];
        const running = Shell.AppSystem.get_default().get_running();
        return JSON.stringify({
            now: Math.round(GLib.get_monotonic_time() / 1000),
            overview: Main.overview.visible,
            locked: Main.sessionMode.isLocked,
            mode: Main.sessionMode.currentMode,
            stage: [global.stage.width, global.stage.height],
            monitors: Main.layoutManager.monitors.map(m => ({index: m.index, x: m.x, y: m.y, width: m.width,
                height: m.height, inFullscreen: m.inFullscreen,
                displayFullscreen: global.display.get_monitor_in_fullscreen(m.index)})),
            panel: {visible: Main.panel.visible, mapped: Main.panel.is_mapped(), rect: rect(Main.panel)},
            extensions: Main.extensionManager.getUuids().map(uuid => {
                const extension = Main.extensionManager.lookup(uuid);
                return {uuid, state: extension.state, enabled: Main.extensionManager._enabledExtensions
                    .includes(uuid), error: extension.error ? String(extension.error) : null};
            }),
            order: Main.extensionManager._extensionOrder,
            hanabiWatcher: ours?.stateObj?._hanabi?.active ?? null,
            windows,
            layers,
            running: running.map(app => app.get_id()),
            runningOurs: running.filter(app => app.get_windows().some(isOurs)).map(app => app.get_id()),
            focusApp: tracker.focus_app?.get_id() ?? null,
            docks: docks(),
            backgroundClones: find(Main.layoutManager._backgroundGroup, actor => actor instanceof Clutter.Clone &&
                actor.source instanceof Meta.WindowActor && isOurs(actor.source.meta_window)).length,
            events: this._events,
        });
    }

    Toggle(uuid, enable) {
        return enable ? Main.extensionManager.enableExtension(uuid) : Main.extensionManager.disableExtension(uuid);
    }

    Lock(lock) {
        if (lock)
            Main.screenShield.lock(false);
        else
            Main.screenShield.deactivate(false);
        return true;
    }

    HideOverview() {
        Main.overview.hide();
        return Main.overview.visible;
    }

    ResetEvents() {
        this._events = [];
        return true;
    }

    CaptureAsync([path], invocation) {
        const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
        new Shell.Screenshot().screenshot(false, stream)
            .then(() => stream.close_async(GLib.PRIORITY_DEFAULT, null))
            .then(() => invocation.return_value(new GLib.Variant('(s)', [path])))
            .catch(error => invocation.return_error_literal(Gio.DBusError, Gio.DBusError.FAILED, error.message));
    }
}
