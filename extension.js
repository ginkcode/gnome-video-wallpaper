import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {getLoginManager} from 'resource:///org/gnome/shell/misc/loginManager.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LiveSettings} from './lib/liveSettings.js';
import {createLogger, setDebugEnabled} from './lib/log.js';
import {MonitorWatcher} from './lib/monitorTopology.js';
import {PauseController} from './lib/pauseController.js';
import {PlayerManager} from './lib/playerManager.js';
import {isLockedSession, watchSleep} from './lib/sessionLifecycle.js';
import {optimizedDir} from './lib/transcoder.js';

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
        const reconcile = () => {
            if (this._manager?.started)
                this._manager.reconcile().catch(error => log.error(`reconcile failed: ${error.message}`));
        };
        this._live = new LiveSettings({settings: this._settings, directories: [optimizedDir()], onChange: reconcile});
        this._live.enable();
        this._monitors = new MonitorWatcher({
            sources: [Main.layoutManager, global.backend.get_monitor_manager()],
            onChange: reconcile,
        });
        this._monitors.enable();
        start();
        const end = GLib.get_monotonic_time();
        log.debug(`enable at ${Math.round(begin / 1000)} ms took ${((end - begin) / 1000).toFixed(2)} ms`);
    }

    disable() {
        this._monitors?.disable();
        this._monitors = null;
        this._unwatchSleep?.();
        this._unwatchSleep = null;
        this._live?.disable();
        this._live = null;
        this._pause?.disable();
        this._pause = null;
        this._manager?.stop({restore: !isLockedSession(Main.sessionMode)});
        this._manager = null;
        this._settings = null;
    }
}
