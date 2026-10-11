import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class T24Stage extends Extension {
    enable() {
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            Main.overview.hide();
            if (!this._capturing) {
                this._capturing = true;
                new Shell.Screenshot().screenshot_stage_to_content().catch(() => {}).finally(() => {
                    this._capturing = false;
                });
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }
}
