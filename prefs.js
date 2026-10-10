import Adw from 'gi://Adw';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class GinkVideoWallpaperPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.add(new Adw.PreferencesPage());
    }
}
