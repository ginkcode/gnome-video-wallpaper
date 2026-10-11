import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {getLoginManager} from 'resource:///org/gnome/shell/misc/loginManager.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {createLogger, setDebugEnabled} from './lib/log.js';
import {PauseController} from './lib/pauseController.js';
import {PlayerManager} from './lib/playerManager.js';
import {isLockedSession, watchSleep} from './lib/sessionLifecycle.js';

export default class GinkVideoWallpaper extends Extension {
    enable() {
        const begin = GLib.get_monotonic_time();
        this._settings = this.getSettings();
        setDebugEnabled(this._settings.get_boolean('debug-logging'));
        const log = createLogger('extension');
        this._manager = new PlayerManager({settings: this._settings,
            openPreferences: () => this.openPreferences()});
        const start = () => this._manager.start().catch(error => log.error(`start failed: ${error.message}`));
        this._unwatchSleep = watchSleep(getLoginManager(), {
            onSleep: () => {
                log.debug('preparing for sleep; stopping players');
                this._manager.stop();
            },
            onResume: () => {
                log.debug('resumed; restarting players');
                start();
            },
        });
        this._pause = new PauseController({playerManager: this._manager, settings: this._settings});
        this._pause.enable();
        start();
        const end = GLib.get_monotonic_time();
        log.debug(`enable at ${Math.round(begin / 1000)} ms took ${((end - begin) / 1000).toFixed(2)} ms`);
    }

    disable() {
        this._unwatchSleep?.();
        this._unwatchSleep = null;
        this._pause?.disable();
        this._pause = null;
        this._manager?.stop({restore: !isLockedSession(Main.sessionMode)});
        this._manager = null;
        this._settings = null;
    }
}
