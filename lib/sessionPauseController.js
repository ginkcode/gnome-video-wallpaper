import Gio from 'gi://Gio';

import {Disposables} from './disposables.js';
import {createLogger} from './log.js';

export const OVERVIEW = 'overview';
export const BATTERY = 'battery';

export class SessionPauseController {
    constructor({playerManager, settings, overview, createBatteryProxy, logger = createLogger('session-pause')}) {
        this._manager = playerManager;
        this._settings = settings;
        this._overview = overview;
        this._createBatteryProxy = createBatteryProxy;
        this._log = logger;
        this._disposables = null;
        this._battery = null;
        this._applied = new Map();
    }

    enable() {
        if (this._disposables)
            throw new Error('SessionPauseController is already enabled');
        const disposables = new Disposables();
        this._disposables = disposables;
        const sync = () => this._sync();
        disposables.connect(this._settings, 'changed::pause-on-overview', sync);
        disposables.connect(this._settings, 'changed::pause-on-battery', sync);
        disposables.connect(this._overview, 'showing', sync);
        disposables.connect(this._overview, 'hidden', sync);
        disposables.add(this._manager.onTargets(() => {
            this._applied.clear();
            this._sync();
        }));
        disposables.add(() => {
            this._battery = null;
        });
        const cancellable = disposables.cancellable();
        this._createBatteryProxy(cancellable).then(proxy => {
            if (cancellable.is_cancelled())
                return;
            this._battery = proxy;
            disposables.connect(proxy, 'g-properties-changed', sync);
            this._sync();
        }).catch(error => {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._log.warn(`battery state unavailable: ${error.message}`);
        });
        this._sync();
    }

    disable() {
        this._disposables?.dispose();
        this._disposables = null;
        this._applied.clear();
    }

    _onBattery() {
        return this._battery?.get_cached_property('OnBattery')?.unpack() === true;
    }

    _sync() {
        const reasons = {
            [OVERVIEW]: this._settings.get_boolean('pause-on-overview') && this._overview.visible === true,
            [BATTERY]: this._settings.get_boolean('pause-on-battery') && this._onBattery(),
        };
        for (const {logicalMonitorKey: key} of this._manager.targets) {
            for (const [reason, paused] of Object.entries(reasons)) {
                const id = `${key}\n${reason}`;
                if (this._applied.get(id) === paused)
                    continue;
                this._applied.set(id, paused);
                this._log.debug(`${key} ${reason} ${paused ? 'paused' : 'cleared'}`);
                this._manager.setPaused(key, reason, paused);
            }
        }
    }
}
