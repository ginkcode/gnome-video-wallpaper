import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {readMonitorConfigs, removeMonitorConfig, writeMonitorConfig} from '../lib/config.js';
import {targetGeometry} from '../lib/geometry.js';
import {ProbeError, probe} from '../lib/mediaProbe.js';
import {getMonitors} from '../lib/monitorIdentity.js';
import {acquirePlaybackAsset, ensureStill, releasePlaybackAsset} from '../lib/stillCache.js';
import {canOptimize, ensureOptimized, optimizedPath, shouldOptimize} from '../lib/transcoder.js';
import {LatestJobs} from './latestJobs.js';
import {applySelection, buildMonitorModel, loadPreview, modelLayout} from './monitorModel.js';

Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish');

const FIT_MODES = [null, 'fill', 'fit', 'stretch'];
const FIT_LABELS = {fill: 'Fill', fit: 'Fit', stretch: 'Stretch'};
const OPTIMIZE_CHOICES = [null, true, false];

function formatScale(scale) {
    return `${Number(scale.toFixed(2))}×`;
}

function fileFilters() {
    const media = new Gtk.FileFilter({name: 'Videos and GIFs'});
    media.add_mime_type('video/*');
    media.add_mime_type('image/gif');
    const all = new Gtk.FileFilter({name: 'All files'});
    all.add_pattern('*');
    const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
    filters.append(media);
    filters.append(all);
    return {filters, media};
}

function iconButton(iconName, tooltip, onClicked) {
    const button = new Gtk.Button({icon_name: iconName, tooltip_text: tooltip, valign: Gtk.Align.CENTER,
        css_classes: ['flat']});
    button.connect('clicked', onClicked);
    return button;
}

class MonitorSection {
    constructor(page, group, member) {
        this._page = page;
        this._id = member.physical.id;
        this._logical = group.logical;
        this._previewKey = undefined;
        this._updating = false;
        const {physical} = member;
        const {logical} = group;
        let description = `${physical.connector} · ${physical.modeWidth}×${physical.modeHeight} · ` +
            `shown as ${logical.width}×${logical.height} at ${formatScale(logical.scale)}`;
        if (group.mirrored) {
            const others = group.members.filter(other => other !== member).map(other => other.physical.connector);
            description += `\nMirrored with ${others.join(', ')}. Mirrored displays share one wallpaper: ` +
                'the first configured display in connector order is used.';
        }
        this.widget = new Adw.PreferencesGroup({title: physical.displayName, description});
        this._status = new Gtk.Label({valign: Gtk.Align.CENTER, css_classes: ['caption-heading']});
        if (group.mirrored)
            this.widget.set_header_suffix(this._status);

        this._fileRow = new Adw.ActionRow({title: 'Video', subtitle_lines: 1, title_lines: 1});
        this._spinner = new Adw.Spinner({visible: false, valign: Gtk.Align.CENTER});
        this._remove = iconButton('user-trash-symbolic', 'Remove wallpaper', () => page.removeConfig(this._id));
        const choose = iconButton('document-open-symbolic', 'Choose video', () => page.choose(this._id, this._logical));
        this._fileRow.add_suffix(this._spinner);
        this._fileRow.add_suffix(choose);
        this._fileRow.add_suffix(this._remove);
        this._fileRow.set_activatable_widget(choose);
        this.widget.add(this._fileRow);

        this._progress = new Gtk.ProgressBar({show_text: true, valign: Gtk.Align.CENTER, hexpand: true});
        this._progressRow = new Adw.ActionRow({title: 'Optimizing', visible: false});
        this._progressRow.add_suffix(this._progress);
        this.widget.add(this._progressRow);

        this._previewStack = new Gtk.Stack({height_request: 150, margin_top: 6, margin_bottom: 6,
            margin_start: 6, margin_end: 6});
        this._picture = new Gtk.Picture({content_fit: Gtk.ContentFit.CONTAIN, can_shrink: true});
        this._placeholder = new Gtk.Image({icon_name: 'video-x-generic-symbolic', pixel_size: 48,
            css_classes: ['dim-label']});
        this._previewStack.add_named(this._placeholder, 'placeholder');
        this._previewStack.add_named(new Adw.Spinner({halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER}),
            'loading');
        this._previewStack.add_named(this._picture, 'picture');
        this.widget.add(new Adw.PreferencesRow({activatable: false, child: this._previewStack}));

        this._fitRow = new Adw.ComboRow({title: 'Fit mode', model: new Gtk.StringList()});
        this._fitRow.connect('notify::selected', () => {
            if (!this._updating)
                page.setFitMode(this._id, FIT_MODES[this._fitRow.selected] ?? null);
        });
        this.widget.add(this._fitRow);

        this._optimizeRow = new Adw.ComboRow({title: 'Optimize video', model: new Gtk.StringList(),
            subtitle: 'Plays a display-sized copy that needs less power. GIFs are always optimized.'});
        this._optimizeRow.connect('notify::selected', () => {
            if (!this._updating)
                page.setOptimize(this._id, OPTIMIZE_CHOICES[this._optimizeRow.selected] ?? null);
        });
        this.widget.add(this._optimizeRow);
        this.update(member);
    }

    update(member) {
        const {config} = member;
        const defaultFit = this._page.defaultFitMode();
        this._updating = true;
        this._fitRow.model.splice(0, this._fitRow.model.get_n_items(),
            [`Default (${FIT_LABELS[defaultFit] ?? defaultFit})`, ...FIT_MODES.slice(1).map(mode => FIT_LABELS[mode])]);
        this._fitRow.selected = Math.max(0, FIT_MODES.indexOf(config?.fitMode ?? null));
        const defaultOptimize = this._page.optimizeVideos() ? 'On' : 'Off';
        this._optimizeRow.model.splice(0, this._optimizeRow.model.get_n_items(),
            [`Default (${defaultOptimize})`, 'On', 'Off']);
        this._optimizeRow.selected = Math.max(0, OPTIMIZE_CHOICES.indexOf(config?.optimize ?? null));
        this._updating = false;
        this._fitRow.sensitive = Boolean(config);
        this._optimizeRow.sensitive = Boolean(config);
        this._remove.sensitive = Boolean(config);
        this._fileRow.subtitle = config ? GLib.markup_escape_text(GLib.path_get_basename(config.file), -1) : 'None';
        this._fileRow.tooltip_text = config?.file ?? '';
        this._status.label = member.effective ? 'In use' : config ? 'Not used' : '';
        const request = config ? {file: config.file, optimize: this._page.optimizeEnabled(config),
            geometry: targetGeometry(this._logical, config.fitMode ?? defaultFit)} : null;
        if (request)
            this._page.refreshOptimized(this._id, request);
        this._showPreview(request);
    }

    setBusy(busy) {
        this._spinner.visible = busy;
    }

    setProgress(fraction) {
        this._progressRow.visible = fraction !== null;
        if (fraction !== null) {
            this._progress.fraction = fraction;
            this._progress.text = `${Math.round(fraction * 100)}%`;
        }
    }

    refreshPreview() {
        this._showPreview(this._request);
    }

    _showPreview(request) {
        this._request = request;
        const key = request
            ? JSON.stringify([request.file, request.geometry, request.optimize, this._page.optimizedGeneration(this._id)])
            : null;
        if (key === this._previewKey)
            return;
        this._previewKey = key;
        if (!request) {
            this._page.cancelPreview(this._id);
            this._previewStack.visible_child_name = 'placeholder';
            return;
        }
        this._previewStack.visible_child_name = 'loading';
        this._page.preview(this._id, key, request).then(result => {
            if (this._previewKey !== key || result.cancelled)
                return;
            this._placeholder.tooltip_text = result.error?.message ?? '';
            if (result.value) {
                this._picture.set_filename(result.value);
                this._previewStack.visible_child_name = 'picture';
            } else {
                this._previewStack.visible_child_name = 'placeholder';
            }
        });
    }
}

export const MonitorsPage = GObject.registerClass(
class MonitorsPage extends Adw.PreferencesPage {
    _init({settings, toast}) {
        super._init({title: 'Wallpapers', icon_name: 'video-display-symbolic'});
        this._settings = settings;
        this._toast = toast;
        this._jobs = new LatestJobs();
        this._stills = new Map();
        this._optimizeKeys = new Map();
        this._generations = new Map();
        this._groups = [];
        this._sections = new Map();
        this._monitors = null;
        this._layout = null;
        this._idle = 0;
        this._cancellable = new Gio.Cancellable();
        this._settingsIds = ['changed::monitor-configs', 'changed::default-fit-mode', 'changed::optimize-videos'].map(signal =>
            settings.connect(signal, () => this._queueRender()));
        this._monitorsSignal = Gio.DBus.session.signal_subscribe('org.gnome.Mutter.DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', 'MonitorsChanged', '/org/gnome/Mutter/DisplayConfig', null,
            Gio.DBusSignalFlags.NONE, () => this._reload());
        this._reload();
    }

    close() {
        this._jobs.close();
        this._cancellable.cancel();
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        if (this._monitorsSignal)
            Gio.DBus.session.signal_unsubscribe(this._monitorsSignal);
        this._monitorsSignal = 0;
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
    }

    defaultFitMode() {
        return this._settings.get_string('default-fit-mode');
    }

    optimizeVideos() {
        return this._settings.get_boolean('optimize-videos');
    }

    optimizeEnabled(config) {
        return config.optimize ?? this.optimizeVideos();
    }

    optimizedGeneration(id) {
        return this._generations.get(id) ?? 0;
    }

    _optimizedFor(optimize) {
        return (media, geometry) => shouldOptimize(media, {optimize}, false) && canOptimize(geometry)
            ? optimizedPath(media, geometry)
            : null;
    }

    async _optimize(id, media, geometry, optimize, cancellable) {
        if (!this._optimizedFor(optimize)(media, geometry))
            return false;
        let produced = false;
        try {
            await ensureOptimized(media, geometry, {cancellable, onProgress: fraction => {
                produced = true;
                this._sections.get(id)?.setProgress(fraction);
            }});
        } finally {
            this._sections.get(id)?.setProgress(null);
        }
        return produced;
    }

    refreshOptimized(id, {file, geometry, optimize}) {
        const key = JSON.stringify([file, geometry, optimize]);
        if (this._optimizeKeys.get(id) === key)
            return;
        this._optimizeKeys.set(id, key);
        this._runOptimize(id, file, geometry, optimize);
    }

    async _runOptimize(id, file, geometry, optimize) {
        const result = await this._jobs.run(`optimize:${id}`, async cancellable =>
            this._optimize(id, await probe(file, cancellable), geometry, optimize, cancellable));
        if (result.cancelled)
            return;
        if (result.error && !(result.error instanceof ProbeError)) {
            this._toast(`Could not optimize ${GLib.path_get_basename(file)}: ${result.error.message} ` +
                'The original video is played instead.');
        } else if (result.value) {
            this._generations.set(id, this.optimizedGeneration(id) + 1);
            this._sections.get(id)?.refreshPreview();
        }
    }

    async choose(id, logical) {
        const {filters, media} = fileFilters();
        const dialog = new Gtk.FileDialog({title: 'Choose a video or GIF', modal: true, filters,
            default_filter: media});
        const current = readMonitorConfigs(this._settings)[id];
        if (current)
            dialog.initial_file = Gio.File.new_for_path(current.file);
        let file;
        try {
            file = await dialog.open(this.get_root(), this._cancellable);
        } catch (error) {
            if (!error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) &&
                !error.matches?.(Gtk.DialogError, Gtk.DialogError.CANCELLED))
                this._toast(error.message);
            return;
        }
        const path = file?.get_path();
        if (path)
            await this.select(id, logical, path);
        else
            this._toast('Choose a local file.');
    }

    async select(id, logical, path) {
        this._sections.get(id)?.setBusy(true);
        const result = await this._jobs.run(`select:${id}`, cancellable => applySelection({
            file: path, logical, cancellable, probe,
            defaultFitMode: () => this.defaultFitMode(),
            readConfig: () => readMonitorConfigs(this._settings)[id] ?? null,
            writeConfig: config => writeMonitorConfig(this._settings, id, config),
            prepare: (media, geometry, config, cancellable) =>
                this._optimize(id, media, geometry, this.optimizeEnabled(config), cancellable),
        }));
        if (result.cancelled)
            return;
        this._sections.get(id)?.setBusy(false);
        if (result.error)
            this._toast(result.error.message);
    }

    setFitMode(id, fitMode) {
        const current = readMonitorConfigs(this._settings)[id];
        if (current && current.fitMode !== fitMode)
            writeMonitorConfig(this._settings, id, {...current, fitMode});
    }

    setOptimize(id, optimize) {
        const current = readMonitorConfigs(this._settings)[id];
        if (current && current.optimize !== optimize)
            writeMonitorConfig(this._settings, id, {...current, optimize});
    }

    removeConfig(id) {
        this._jobs.cancel(`select:${id}`);
        this._jobs.cancel(`optimize:${id}`);
        this._optimizeKeys.delete(id);
        this._sections.get(id)?.setProgress(null);
        this._sections.get(id)?.setBusy(false);
        removeMonitorConfig(this._settings, id);
    }

    cancelPreview(id) {
        this._jobs.cancel(`preview:${id}`);
    }

    async preview(id, key, {file, geometry, optimize}) {
        const cached = this._stills.get(key);
        if (cached && GLib.file_test(cached, GLib.FileTest.IS_REGULAR))
            return {value: cached};
        const result = await this._jobs.run(`preview:${id}`, cancellable => loadPreview({file, geometry,
            cancellable, probe, acquire: acquirePlaybackAsset, ensureStill, release: releasePlaybackAsset,
            optimizedPathFor: this._optimizedFor(optimize)}));
        if (result.value)
            this._stills.set(key, result.value);
        return result;
    }

    async _reload() {
        try {
            this._monitors = await getMonitors(this._cancellable);
            this._error = null;
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._monitors = {physicalMonitors: [], logicalMonitors: []};
            this._error = error.message;
        }
        this._layout = null;
        this._render();
    }

    _queueRender() {
        if (this._idle)
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idle = 0;
            this._render();
            return GLib.SOURCE_REMOVE;
        });
    }

    _render() {
        if (!this._monitors)
            return;
        const model = buildMonitorModel(this._monitors, readMonitorConfigs(this._settings));
        const layout = modelLayout(model);
        if (layout === this._layout) {
            for (const group of model.groups) {
                for (const member of group.members)
                    this._sections.get(member.physical.id)?.update(member);
            }
            return;
        }
        this._layout = layout;
        for (const widget of this._groups)
            this.remove(widget);
        this._groups = [];
        const previous = [...this._sections.keys()];
        this._sections.clear();
        for (const group of model.groups) {
            for (const member of group.members) {
                const section = new MonitorSection(this, group, member);
                this._sections.set(member.physical.id, section);
                this._addGroup(section.widget);
            }
        }
        for (const id of previous.filter(id => !this._sections.has(id))) {
            this.cancelPreview(id);
            this._jobs.cancel(`optimize:${id}`);
            this._optimizeKeys.delete(id);
        }
        if (this._error || model.groups.length === 0) {
            const group = new Adw.PreferencesGroup();
            group.add(new Adw.ActionRow({title: 'No displays found', subtitle: this._error ?? '',
                css_classes: ['property']}));
            this._addGroup(group);
        }
        if (model.others.length > 0)
            this._addGroup(this._othersGroup(model.others));
    }

    _addGroup(widget) {
        this.add(widget);
        this._groups.push(widget);
    }

    _othersGroup(others) {
        const group = new Adw.PreferencesGroup({title: 'Other monitors',
            description: 'Saved wallpapers for displays that are not connected.'});
        const expander = new Adw.ExpanderRow({title: `Disconnected displays (${others.length})`, expanded: false});
        for (const other of others) {
            const row = new Adw.ActionRow({title: GLib.markup_escape_text(other.title, -1),
                subtitle: GLib.markup_escape_text(`${other.connector} · ${GLib.path_get_basename(other.config.file)}`,
                    -1)});
            row.add_suffix(iconButton('user-trash-symbolic', 'Remove wallpaper', () => this.removeConfig(other.id)));
            expander.add_row(row);
        }
        group.add(expander);
        return group;
    }
});
