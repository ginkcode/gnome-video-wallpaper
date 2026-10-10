import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class GinkVideoWallpaper extends Extension {
    enable() {
        console.log('[gink-vw] enabled');
    }

    disable() {
        console.log('[gink-vw] disabled');
    }
}
