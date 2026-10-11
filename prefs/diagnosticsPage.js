import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {describeDependencies} from '../lib/deps.js';
import {cacheSize, clearCache} from '../lib/stillCache.js';
import {LatestJobs} from './latestJobs.js';
import {clearReport, installCommands} from './diagnostics.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

const DEPENDENCIES = [
    ['mpv', 'mpv', 'Plays the video wallpaper'],
    ['ffmpeg', 'ffmpeg', 'Creates still images and optimized videos'],
    ['ffprobe', 'ffprobe', 'Checks videos before they are used'],
    ['vaapi', 'VA-API', 'Hardware video decoding; optional, lowers CPU use'],
];

async function readOsRelease(cancellable) {
    for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
        try {
            const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
            return new TextDecoder().decode(bytes);
        } catch (error) {
            if (cancellable.is_cancelled())
                throw error;
        }
    }
    return '';
}

export const DiagnosticsPage = GObject.registerClass(
class DiagnosticsPage extends Adw.PreferencesPage {
    _init({toast}) {
        super._init({title: 'Diagnostics', icon_name: 'dialog-information-symbolic'});
        this._toast = toast;
        this._jobs = new LatestJobs();

        const dependencies = new Adw.PreferencesGroup({title: 'Dependencies'});
        const refresh = new Gtk.Button({icon_name: 'view-refresh-symbolic', tooltip_text: 'Check again',
            valign: Gtk.Align.CENTER, css_classes: ['flat']});
        refresh.connect('clicked', () => this.refreshDependencies());
        dependencies.set_header_suffix(refresh);
        this._dependencyRows = new Map();
        for (const [key, title, purpose] of DEPENDENCIES) {
            const icon = new Gtk.Image({icon_name: 'content-loading-symbolic'});
            const row = new Adw.ActionRow({title, subtitle: purpose, css_classes: ['property']});
            row.add_prefix(icon);
            const version = new Gtk.Label({css_classes: ['dim-label'], valign: Gtk.Align.CENTER, selectable: true});
            row.add_suffix(version);
            this._dependencyRows.set(key, {row, icon, version, purpose});
            dependencies.add(row);
        }
        this._hint = new Adw.ActionRow({title: 'Install missing programs', visible: false, subtitle_selectable: true});
        dependencies.add(this._hint);
        this.add(dependencies);

        const cache = new Adw.PreferencesGroup({title: 'Cache',
            description: 'Still images and prepared videos. They are recreated when needed.'});
        this._sizeRow = new Adw.ActionRow({title: 'Cache size', subtitle: 'Calculating…'});
        this._clearButton = new Gtk.Button({label: 'Clear Cache', valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action']});
        this._clearButton.connect('clicked', () => this._confirmClear());
        this._sizeRow.add_suffix(this._clearButton);
        cache.add(this._sizeRow);
        this.add(cache);

        this.refreshDependencies();
        this.refreshSize();
    }

    close() {
        this._jobs.close();
    }

    async refreshDependencies() {
        for (const {icon, version} of this._dependencyRows.values()) {
            icon.set({icon_name: 'content-loading-symbolic', css_classes: []});
            version.label = '';
        }
        const result = await this._jobs.run('dependencies', async cancellable => {
            const [found, osRelease] = await Promise.all([describeDependencies(cancellable),
                readOsRelease(cancellable)]);
            return {found, osRelease};
        });
        if (result.cancelled)
            return;
        if (result.error) {
            this._toast(`Could not check dependencies: ${result.error.message}`);
            return;
        }
        const {found, osRelease} = result.value;
        for (const [key, {row, icon, version, purpose}] of this._dependencyRows) {
            const status = found[key];
            icon.set({icon_name: status.found ? 'object-select-symbolic' : 'window-close-symbolic',
                css_classes: [status.found ? 'success' : key === 'vaapi' ? 'warning' : 'error'],
                tooltip_text: status.found ? 'Available' : 'Missing'});
            version.label = status.found ? status.version ?? '' : 'Not found';
            row.subtitle = purpose;
        }
        const missing = Object.keys(found).filter(key => key !== 'vaapi' && !found[key].found);
        const commands = installCommands(osRelease, missing);
        this._hint.visible = commands.length > 0;
        this._hint.subtitle = GLib.markup_escape_text(commands.join('\n'), -1);
    }

    async refreshSize() {
        const result = await this._jobs.run('size', () => cacheSize());
        if (result.cancelled)
            return;
        this._sizeRow.subtitle = result.error ? result.error.message : GLib.format_size(result.value);
    }

    _confirmClear() {
        const dialog = new Adw.AlertDialog({heading: 'Clear Cache?',
            body: 'Still images and prepared videos will be deleted and recreated when needed. ' +
                'Files used by wallpapers that are playing now and the applied wallpaper images are kept.',
            default_response: 'cancel', close_response: 'cancel'});
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('clear', 'Clear');
        dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_dialog, response) => {
            if (response === 'clear')
                this.clear();
        });
        dialog.present(this);
    }

    async clear() {
        this._clearButton.sensitive = false;
        const result = await this._jobs.run('clear', cancellable => clearCache(cancellable));
        if (result.cancelled)
            return null;
        this._clearButton.sensitive = true;
        if (result.error)
            this._toast(`Could not clear the cache: ${result.error.message}`);
        else
            this._toast(clearReport(result.value, GLib.format_size));
        await this.refreshSize();
        return result.value ?? null;
    }
});
