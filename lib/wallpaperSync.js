import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {wallpaperDir} from './stillCache.js';

const BACKGROUND_SCHEMA = 'org.gnome.desktop.background';
const KEYS = [
    ['picture-uri', 'saved-picture-uri'],
    ['picture-uri-dark', 'saved-picture-uri-dark'],
    ['picture-options', 'saved-picture-options'],
    ['primary-color', 'saved-primary-color'],
    ['color-shading-type', 'saved-color-shading-type'],
];
const URI_KEYS = new Set(['picture-uri', 'picture-uri-dark']);
const PUBLISHED_NAME = /^[0-9a-f]{64}\.png$/;

export function isPublishedUri(uri) {
    if (typeof uri !== 'string' || !uri.startsWith('file:///'))
        return false;
    const path = Gio.File.new_for_uri(uri).get_path();
    if (!path)
        return false;
    const canonical = GLib.canonicalize_filename(path, null);
    return GLib.path_get_dirname(canonical) === GLib.canonicalize_filename(wallpaperDir(), null) &&
        PUBLISHED_NAME.test(GLib.path_get_basename(canonical));
}

export class WallpaperSync {
    constructor(extensionSettings, logger, background = new Gio.Settings({schema_id: BACKGROUND_SCHEMA})) {
        this._settings = extensionSettings;
        this._logger = logger;
        this._background = background;
        this._written = {};
        this._closed = false;
        this._handlerId = background.connect('changed', (_settings, key) => this._onChanged(key));
    }

    get isApplied() {
        return this._settings.get_boolean('wallpaper-applied');
    }

    apply(fileUri, pictureOptions = 'zoom') {
        if (this._closed) {
            this._logger.debug('ignoring wallpaper apply after restore/destroy');
            return false;
        }
        if (!isPublishedUri(fileUri))
            throw new Error(`refusing to apply ${fileUri}: only published wallpapers may be applied`);
        const written = {'picture-options': pictureOptions, 'primary-color': '#000000', 'color-shading-type': 'solid'};
        const applied = this.isApplied;
        const showing = isPublishedUri(this._background.get_string('picture-uri'));
        this._settings.delay();
        for (const [key, saved] of KEYS) {
            const value = this._background.get_string(key);
            const ours = URI_KEYS.has(key) ? isPublishedUri(value)
                : key === 'picture-options' ? showing : value === written[key];
            if (!applied || !ours)
                this._settings.set_string(saved, value);
        }
        this._settings.set_boolean('wallpaper-applied', true);
        this._settings.apply();
        this._written = written;
        this._write({'picture-uri': fileUri, 'picture-uri-dark': fileUri, ...this._written});
        return true;
    }

    restore() {
        this._closed = true;
        if (!this.isApplied)
            return;
        this._write(Object.fromEntries(KEYS.map(([key, saved]) => [key, this._settings.get_string(saved)])));
        this._settings.delay();
        for (const [, saved] of KEYS)
            this._settings.reset(saved);
        this._settings.set_boolean('wallpaper-applied', false);
        this._settings.apply();
    }

    destroy() {
        this._closed = true;
        if (this._handlerId) {
            this._background.disconnect(this._handlerId);
            this._handlerId = 0;
        }
    }

    _write(values) {
        const changes = Object.entries(values).filter(([key, value]) =>
            this._background.get_string(key) !== value);
        if (changes.length === 0)
            return;
        this._background.delay();
        for (const [key, value] of changes) {
            if (value === '')
                this._background.reset(key);
            else
                this._background.set_string(key, value);
        }
        this._background.apply();
    }

    _onChanged(key) {
        const pair = KEYS.find(([name]) => name === key);
        if (!pair || this._closed || !this.isApplied)
            return;
        const value = this._background.get_string(key);
        const ours = URI_KEYS.has(key) ? isPublishedUri(value) : value === this._written[key];
        if (ours || this._settings.get_string(pair[1]) === value)
            return;
        this._settings.set_string(pair[1], value);
        this._logger.info(`external ${key} change saved as the new original`);
    }
}
