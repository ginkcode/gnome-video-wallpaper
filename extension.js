import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {getLoginManager} from 'resource:///org/gnome/shell/misc/loginManager.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {HanabiWatcher} from './lib/compat.js';
import {LiveSettings} from './lib/liveSettings.js';
import {createLogger, setDebugEnabled} from './lib/log.js';
import {MonitorWatcher} from './lib/monitorTopology.js';
import {PanelIndicator} from './lib/panelIndicator.js';
import {PauseController} from './lib/pauseController.js';
import {PlayerManager} from './lib/playerManager.js';
import {Playlist} from './lib/playlist.js';
import {isLockedSession, watchSleep} from './lib/sessionLifecycle.js';
import {optimizedDir} from './lib/transcoder.js';
import {UserPauseController} from './lib/userPauseController.js';
import {WorkspaceAnimationFilter} from './lib/workspaceAnimationFilter.js';

export default class GinkVideoWallpaper extends Extension {
    enable() {
        const begin = GLib.get_monotonic_time();
        this._settings = this.getSettings();
        const syncDebug = () => setDebugEnabled(this._settings.get_boolean('debug-logging'));
        syncDebug();
        this._debugChanged = this._settings.connect('changed::debug-logging', syncDebug);
        const log = createLogger('extension');
        const openPreferences = () => Promise.resolve(this.openPreferences())
            .catch(error => log.error(`preferences failed to open: ${error.message}`));
        this._hanabi = new HanabiWatcher({extensionManager: Main.extensionManager});
        this._hanabi.enable();
        this._playlist = new Playlist({settings: this._settings, onChange: () => reconcile()});
        this._manager = new PlayerManager({settings: this._settings,
            openPreferences,
            fileFor: (id, files) => this._playlist.fileFor(id, files)});
        this._animationFilter = new WorkspaceAnimationFilter({isOwn: window => this._manager?.ownsWindow(window)});
        this._animationFilter.enable();
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
        this._userPause = new UserPauseController({playerManager: this._manager, settings: this._settings});
        this._userPause.enable();
        this._indicator = new PanelIndicator({uuid: this.uuid, settings: this._settings, playerManager: this._manager,
            openPreferences, next: () => this._playlist?.advance()});
        this._indicator.enable();
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
        this._playlist.enable();
        start();
        const end = GLib.get_monotonic_time();
        log.debug(`enable at ${Math.round(begin / 1000)} ms took ${((end - begin) / 1000).toFixed(2)} ms`);
    }

    disable() {
        this._playlist?.disable();
        this._playlist = null;
        this._monitors?.disable();
        this._monitors = null;
        this._unwatchSleep?.();
        this._unwatchSleep = null;
        this._live?.disable();
        this._live = null;
        this._indicator?.disable();
        this._indicator = null;
        this._userPause?.disable();
        this._userPause = null;
        this._pause?.disable();
        this._pause = null;
        this._manager?.stop({restore: !isLockedSession(Main.sessionMode)});
        this._manager = null;
        this._animationFilter?.disable();
        this._animationFilter = null;
        this._hanabi?.disable();
        this._hanabi = null;
        this._settings?.disconnect(this._debugChanged);
        this._debugChanged = 0;
        setDebugEnabled(false);
        this._settings = null;
    }
}
