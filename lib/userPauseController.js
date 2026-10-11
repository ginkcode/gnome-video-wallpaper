import {Disposables} from './disposables.js';
import {createLogger} from './log.js';

export const USER = 'user';

export class UserPauseController {
    constructor({playerManager, settings, logger = createLogger('user-pause')}) {
        this._manager = playerManager;
        this._settings = settings;
        this._log = logger;
        this._disposables = null;
        this._applied = new Map();
    }

    enable() {
        if (this._disposables)
            throw new Error('UserPauseController is already enabled');
        const disposables = new Disposables();
        this._disposables = disposables;
        disposables.connect(this._settings, 'changed::paused', () => this._sync());
        disposables.add(this._manager.onTargets(() => {
            this._applied.clear();
            this._sync();
        }));
        this._sync();
    }

    disable() {
        this._disposables?.dispose();
        this._disposables = null;
        this._applied.clear();
    }

    _sync() {
        const paused = this._settings.get_boolean('paused');
        for (const {logicalMonitorKey: key} of this._manager.targets) {
            if (this._applied.get(key) === paused)
                continue;
            this._applied.set(key, paused);
            this._log.debug(`${key} ${USER} ${paused ? 'paused' : 'cleared'}`);
            this._manager.setPaused(key, USER, paused);
        }
    }
}
