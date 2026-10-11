import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta?version=18';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');
Gio._promisify(Gio.OutputStream.prototype, 'close_async', 'close_finish');

const IFACE = `<node><interface name="org.ginkcode.T25Probe">
<method name="State"><arg type="s" direction="out"/></method>
<method name="Capture"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
<method name="Rebuild"><arg type="i" direction="out"/></method>
<method name="DestroyContainers"><arg type="i" direction="out"/></method>
</interface></node>`;
const APP_ID = 'gink-video-wallpaper';
const TARGET = 'gink-video-wallpaper@ginkcode.github.io';

function records() {
    const players = Main.extensionManager.lookup(TARGET)?.stateObj?._manager?._players;
    return players ? [...players.values()] : [];
}

function rect(actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height)};
}

function clones(actor, found = []) {
    for (const child of actor.get_children()) {
        if (child instanceof Clutter.Clone && child.source instanceof Meta.WindowActor) {
            found.push({...rect(child), pid: child.source.meta_window?.get_pid() ?? null,
                visible: child.is_visible(), mapped: child.is_mapped(), opacity: child.opacity});
        }
        clones(child, found);
    }
    return found;
}

export default class T25Probe extends Extension {
    enable() {
        this._painting = true;
        this._tick();
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, '/org/ginkcode/T25Probe');
        this._owner = Gio.bus_own_name(Gio.BusType.SESSION, 'org.ginkcode.T25Probe', Gio.BusNameOwnerFlags.NONE,
            null, null, null);
    }

    disable() {
        this._painting = false;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        Gio.bus_unown_name(this._owner);
        this._dbus.unexport();
        this._dbus = null;
    }

    // A headless stage only paints for consumers; captures stand in for a display.
    _tick() {
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._timer = 0;
            if (Main.overview.visible)
                Main.overview.hide();
            new Shell.Screenshot().screenshot_stage_to_content().catch(() => {}).finally(() => {
                if (this._painting)
                    this._tick();
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    State() {
        const windows = global.get_window_actors().map(actor => actor.meta_window)
            .filter(window => window.get_gtk_application_id() === APP_ID || window.get_wm_class() === APP_ID)
            .map(window => {
                const frame = window.get_frame_rect();
                return {pid: window.get_pid(), monitor: window.get_monitor(), x: frame.x, y: frame.y,
                    width: frame.width, height: frame.height};
            });
        return JSON.stringify({
            overview: Main.overview.visible,
            monitors: Main.layoutManager.monitors.map(m => ({index: m.index, x: m.x, y: m.y, width: m.width,
                height: m.height, scale: m.geometry_scale})),
            stage: [global.stage.width, global.stage.height],
            backgroundActors: Main.layoutManager._backgroundGroup.get_children()
                .filter(child => child instanceof Meta.BackgroundActor).length,
            clones: clones(Main.layoutManager._backgroundGroup),
            windows,
            layers: records().map(record => {
                const layer = record.layer;
                const container = layer?._container;
                return {key: record.logicalMonitorKey, state: record.state, pid: record.process?.pid ?? null,
                    container: container ? {...rect(container), mapped: container.is_mapped(),
                        parent: container.get_parent() === Main.layoutManager._backgroundGroup} : null,
                    clone: layer?._clone ? {...rect(layer._clone), visible: layer._clone.is_visible(),
                        opacity: layer._clone.opacity, inContainer: layer._clone.get_parent() === container} : null,
                    still: layer?._static ? {visible: layer._static.is_visible(), opacity: layer._static.opacity,
                        inContainer: layer._static.get_parent() === container} : null};
            }),
        });
    }

    Rebuild() {
        Main.layoutManager._updateBackgrounds();
        return Main.layoutManager._bgManagers.length;
    }

    DestroyContainers() {
        let count = 0;
        for (const record of records()) {
            if (record.layer?._container) {
                record.layer._container.destroy();
                count++;
            }
        }
        return count;
    }

    CaptureAsync([path], invocation) {
        const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
        new Shell.Screenshot().screenshot(false, stream)
            .then(() => stream.close_async(GLib.PRIORITY_DEFAULT, null))
            .then(() => invocation.return_value(new GLib.Variant('(s)', [path])))
            .catch(error => invocation.return_error_literal(Gio.DBusError, Gio.DBusError.FAILED, error.message));
    }
}
