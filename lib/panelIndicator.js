import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Disposables} from './disposables.js';

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init({settings, openPreferences, next}) {
        super._init(0.0, 'Gink Video Wallpaper');
        this._settings = settings;
        this.add_child(new St.Icon({icon_name: 'video-x-generic-symbolic', style_class: 'system-status-icon'}));
        this._toggle = new PopupMenu.PopupImageMenuItem('', 'media-playback-pause-symbolic');
        this._toggle.connect('activate', () => settings.set_boolean('paused', !settings.get_boolean('paused')));
        this.menu.addMenuItem(this._toggle);
        this.menu.addAction('Next Video', () => next(), 'media-skip-forward-symbolic');
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Preferences', () => openPreferences(), 'preferences-system-symbolic');
        const changed = settings.connect('changed::paused', () => this._sync());
        this.connect('destroy', () => settings.disconnect(changed));
        this._sync();
    }

    _sync() {
        const paused = this._settings.get_boolean('paused');
        this._toggle.label.text = paused ? 'Play' : 'Pause';
        this._toggle.setIcon(paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic');
    }
});

export class PanelIndicator {
    constructor({uuid, settings, openPreferences, next}) {
        this._uuid = uuid;
        this._next = next;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._disposables = null;
        this._indicator = null;
    }

    enable() {
        if (this._disposables)
            throw new Error('PanelIndicator is already enabled');
        this._disposables = new Disposables();
        this._disposables.connect(this._settings, 'changed::show-panel-indicator', () => this._sync());
        this._disposables.add(() => this._remove());
        this._sync();
    }

    disable() {
        this._disposables?.dispose();
        this._disposables = null;
    }

    _sync() {
        if (!this._settings.get_boolean('show-panel-indicator')) {
            this._remove();
            return;
        }
        if (this._indicator)
            return;
        this._indicator = new Indicator({settings: this._settings, openPreferences: this._openPreferences,
            next: this._next});
        Main.panel.addToStatusArea(this._uuid, this._indicator);
    }

    _remove() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
