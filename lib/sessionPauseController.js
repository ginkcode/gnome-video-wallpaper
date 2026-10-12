import Gio from 'gi://Gio';

import {Disposables} from './disposables.js';
import {createLogger} from './log.js';

export const OVERVIEW = 'overview';
export const BATTERY = 'battery';
export const REMOTE = 'remote';

export class SessionPauseController {
    constructor({playerManager, settings, overview, createBatteryProxy, remoteAccess = null,
        isRemoteSession = () => Promise.resolve(false), logger = createLogger('session-pause')}) {
        this._manager = playerManager;
        this._settings = settings;
        this._overview = overview;
        this._createBatteryProxy = createBatteryProxy;
        this._remoteAccess = remoteAccess;
        this._isRemoteSession = isRemoteSession;
        this._log = logger;
        this._disposables = null;
        this._battery = null;
        this._remoteSession = false;
        this._handles = new Map();
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
        disposables.connect(this._settings, 'changed::pause-on-remote', sync);
        disposables.connect(this._overview, 'showing', sync);
        disposables.connect(this._overview, 'hidden', sync);
        disposables.add(this._manager.onTargets(() => {
            this._applied.clear();
            this._sync();
        }));
        disposables.add(() => {
            this._battery = null;
            this._remoteSession = false;
            for (const [handle, id] of this._handles)
                handle.disconnect(id);
            this._handles.clear();
        });
        if (this._remoteAccess)
            disposables.connect(this._remoteAccess, 'new-handle', (_controller, handle) => this._track(handle));
        const cancellable = disposables.cancellable();
        this._isRemoteSession().then(remote => {
            if (cancellable.is_cancelled())
                return;
            this._remoteSession = remote === true;
            this._sync();
        }).catch(error => this._log.warn(`remote session state unavailable: ${error.message}`));
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

    // Recordings made with the Shell's own recorder keep the video moving.
    _track(handle) {
        if (handle.is_recording || this._handles.has(handle))
            return;
        const id = handle.connect('stopped', () => {
            handle.disconnect(id);
            this._handles.delete(handle);
            this._sync();
        });
        this._handles.set(handle, id);
        this._sync();
    }

    _sync() {
        const reasons = {
            [OVERVIEW]: this._settings.get_boolean('pause-on-overview') && this._overview.visible === true,
            [BATTERY]: this._settings.get_boolean('pause-on-battery') && this._onBattery(),
            [REMOTE]: this._settings.get_boolean('pause-on-remote') && (this._remoteSession || this._handles.size > 0),
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
