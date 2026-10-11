import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {CoverageController} from './coverageController.js';
import {createLogger} from './log.js';
import {SessionPauseController} from './sessionPauseController.js';

Gio._promisify(Gio.DBusProxy, 'new_for_bus', 'new_for_bus_finish');

function createBatteryProxy(cancellable) {
    return Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
        'org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower', cancellable);
}

export class PauseController {
    constructor({playerManager, settings, logger = createLogger('pause')}) {
        this._controllers = [
            new CoverageController({playerManager, settings, logger,
                display: global.display, workspaceManager: global.workspace_manager,
                normalType: Meta.WindowType.NORMAL, maximizeBoth: Meta.MaximizeFlags.BOTH}),
            new SessionPauseController({playerManager, settings, logger,
                overview: Main.overview, createBatteryProxy}),
        ];
    }

    enable() {
        for (const controller of this._controllers)
            controller.enable();
    }

    disable() {
        for (const controller of this._controllers)
            controller.disable();
    }
}
