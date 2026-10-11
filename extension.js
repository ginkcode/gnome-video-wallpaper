import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {createLogger, setDebugEnabled} from './lib/log.js';
import {PlayerManager} from './lib/playerManager.js';

export default class GinkVideoWallpaper extends Extension {
    enable() {
        const begin = GLib.get_monotonic_time();
        this._settings = this.getSettings();
        setDebugEnabled(this._settings.get_boolean('debug-logging'));
        const log = createLogger('extension');
        this._manager = new PlayerManager({settings: this._settings,
            openPreferences: () => this.openPreferences()});
        this._manager.start().catch(error => log.error(`start failed: ${error.message}`));
        const end = GLib.get_monotonic_time();
        log.debug(`enable at ${Math.round(begin / 1000)} ms took ${((end - begin) / 1000).toFixed(2)} ms`);
    }

    disable() {
        this._manager?.stop();
        this._manager = null;
        this._settings = null;
    }
}
