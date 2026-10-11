import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {HANABI_UUID, hanabiActive, stateFromInfo} from '../lib/compat.js';

const SHELL = 'org.gnome.Shell';
const PATH = '/org/gnome/Shell';
const IFACE = 'org.gnome.Shell.Extensions';
const KEYS = ['enabled-extensions', 'disabled-extensions', 'disable-user-extensions'];
const TITLE = 'Hanabi is enabled and also plays a video wallpaper. Disable Hanabi to avoid conflicts.';

export class HanabiBanner {
    constructor({shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'}), bus = Gio.DBus.session,
        toast = null} = {}) {
        this._settings = shellSettings;
        this._bus = bus;
        this._toast = toast;
        this._banners = [];
        this._state = undefined;
        this._serial = 0;
        this._cancellable = new Gio.Cancellable();
        this.active = false;
        this._settingsIds = KEYS.map(key => shellSettings.connect(`changed::${key}`, () => this.refresh()));
        this._signal = bus.signal_subscribe(null, IFACE, 'ExtensionStateChanged', PATH, HANABI_UUID,
            Gio.DBusSignalFlags.NONE, (_bus, _sender, _path, _iface, _name, parameters) => {
                this._serial++;
                this._state = stateFromInfo(parameters.recursiveUnpack()[1]);
                this._update();
            });
        this.refresh();
    }

    attach(page) {
        const banner = new Adw.Banner({title: TITLE, button_label: 'Disable Hanabi', revealed: this.active});
        banner.connect('button-clicked', () => this._disable());
        page.banner = banner;
        this._banners.push(banner);
        return banner;
    }

    refresh() {
        const serial = ++this._serial;
        this._update();
        this._bus.call(SHELL, PATH, IFACE, 'GetExtensionInfo', new GLib.Variant('(s)', [HANABI_UUID]),
            new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, 5000, this._cancellable, (bus, result) => {
                let state;
                try {
                    state = stateFromInfo(bus.call_finish(result).recursiveUnpack()[0]);
                } catch {
                    state = undefined;
                }
                if (serial !== this._serial || this._cancellable.is_cancelled())
                    return;
                this._state = state;
                this._update();
            });
    }

    close() {
        this._cancellable.cancel();
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        if (this._signal)
            this._bus.signal_unsubscribe(this._signal);
        this._signal = 0;
        this._banners = [];
    }

    _update() {
        this.active = hanabiActive({
            state: this._state,
            enabled: this._settings.get_strv('enabled-extensions'),
            disabled: this._settings.get_strv('disabled-extensions'),
            userExtensionsDisabled: this._settings.get_boolean('disable-user-extensions'),
        });
        for (const banner of this._banners)
            banner.revealed = this.active;
    }

    _disable() {
        this._bus.call(SHELL, PATH, IFACE, 'DisableExtension', new GLib.Variant('(s)', [HANABI_UUID]),
            null, Gio.DBusCallFlags.NONE, 5000, this._cancellable, (bus, result) => {
                try {
                    bus.call_finish(result);
                } catch (error) {
                    if (!this._cancellable.is_cancelled())
                        this._toast?.(`Could not disable Hanabi: ${error.message}`);
                }
            });
    }
}
