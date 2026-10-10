import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {createLogger, setDebugEnabled} from './lib/log.js';
import {PlayerManager} from './lib/playerManager.js';

export default class GinkVideoWallpaper extends Extension {
    enable() {
        this._settings = this.getSettings();
        setDebugEnabled(this._settings.get_boolean('debug-logging'));
        const log = createLogger('extension');
        this._manager = new PlayerManager({settings: this._settings});
        this._manager.start().catch(error => log.error(`start failed: ${error.message}`));
    }

    disable() {
        this._manager?.stop();
        this._manager = null;
        this._settings = null;
    }
}
