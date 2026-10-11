import Adw from 'gi://Adw';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {MonitorsPage} from './prefs/monitorsPage.js';

export default class GinkVideoWallpaperPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new MonitorsPage({
            settings: this.getSettings(),
            toast: message => window.add_toast(new Adw.Toast({title: message, use_markup: false, timeout: 8})),
        });
        window.add(page);
        window.connect('close-request', () => {
            page.close();
            return false;
        });
    }
}
