import Adw from 'gi://Adw';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DiagnosticsPage} from './prefs/diagnosticsPage.js';
import {GeneralPage} from './prefs/generalPage.js';
import {HanabiBanner} from './prefs/hanabiBanner.js';
import {MonitorsPage} from './prefs/monitorsPage.js';

export default class GinkVideoWallpaperPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const toast = message => window.add_toast(new Adw.Toast({title: message, use_markup: false, timeout: 8}));
        const pages = [
            new MonitorsPage({settings, toast}),
            new GeneralPage({settings}),
            new DiagnosticsPage({toast}),
        ];
        const hanabi = new HanabiBanner({toast});
        for (const page of pages) {
            hanabi.attach(page);
            window.add(page);
        }
        window.connect('close-request', () => {
            hanabi.close();
            for (const page of pages)
                page.close();
            return false;
        });
    }
}
