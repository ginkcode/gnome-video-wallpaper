import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {readMonitorConfigs, writeMonitorConfig} from '../../lib/config.js';
import {MonitorsPage} from '../../prefs/monitorsPage.js';

const [schemaDir, mediaDir, screenshot] = ARGV;
const report = (event, data = {}) => print(`T21_RESULT ${JSON.stringify({event, ...data})}`);
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function waitFor(predicate, timeout = 15000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout)
            return false;
        await sleep(25);
    }
    return true;
}

function directoryEntries(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return 0;
    const enumerator = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let count = 0;
    while (enumerator.next_file(null))
        count++;
    return count;
}

function saveScreenshot(window) {
    const paintable = new Gtk.WidgetPaintable({widget: window});
    const snapshot = Gtk.Snapshot.new();
    paintable.snapshot(snapshot, window.get_width(), window.get_height());
    window.get_renderer().render_texture(snapshot.to_node(), null).save_to_png(screenshot);
}

async function main() {
    Adw.init();
    const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, null, false);
    const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.gink-video-wallpaper', false)});
    const toasts = [];
    const window = new Adw.PreferencesWindow({default_width: 360, default_height: 1100});
    const page = new MonitorsPage({settings, toast: message => toasts.push(message)});
    window.add(page);
    window.present();
    let maxGap = 0;
    let last = GLib.get_monotonic_time();
    const ticker = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
        const now = GLib.get_monotonic_time();
        maxGap = Math.max(maxGap, (now - last) / 1000);
        last = now;
        return GLib.SOURCE_CONTINUE;
    });

    report('rendered', {ok: await waitFor(() => page._sections.size > 0)});
    const [id, section] = [...page._sections.entries()][0];
    const logical = section._logical;
    const configs = () => readMonitorConfigs(settings);
    const stack = () => section._previewStack.visible_child_name;
    report('initial', {id, logical, stack: stack(), fitSensitive: section._fitRow.sensitive,
        fitLabels: [...Array(section._fitRow.model.get_n_items()).keys()].map(i => section._fitRow.model.get_string(i))});

    const sar = `${mediaDir}/sar.mp4`;
    maxGap = 0;
    await page.select(id, logical, [sar]);
    const preview = await waitFor(() => stack() === 'picture');
    report('select', {config: configs()[id], subtitle: section._fileRow.subtitle, preview, stack: stack(),
        toasts: [...toasts]});

    for (const bad of [`${mediaDir}/hdr.mp4`, `${mediaDir}/notes.txt`, `${mediaDir}/missing.mp4`]) {
        const before = JSON.stringify(configs());
        await page.select(id, logical, [bad]);
        report('invalid', {file: bad, unchanged: JSON.stringify(configs()) === before, toast: toasts.at(-1)});
    }

    toasts.length = 0;
    const rapid = [`${mediaDir}/rot.mp4`, `${mediaDir}/plain.mp4`, sar, `${mediaDir}/rot.mp4`].map(file =>
        page.select(id, logical, [file]));
    section._fitRow.selected = 2;
    section._fitRow.selected = 3;
    await Promise.all(rapid);
    const settled = await waitFor(() => stack() === 'picture' && page._jobs.pending === 0);
    report('rapid', {config: configs()[id], settled, toasts: [...toasts], maxGapMs: Math.round(maxGap)});

    await page.select(id, logical, [`${mediaDir}/plain.mp4`, `${mediaDir}/rot.mp4`]);
    const added = configs()[id].files;
    page.raiseFile(id, added.at(-1));
    const raised = configs()[id].files;
    page.removeFile(id, raised[0]);
    await waitFor(() => section._filesKey?.includes(JSON.stringify(configs()[id].files)));
    section._fileRow.expanded = true;
    await sleep(300);
    report('playlist', {added, raised, removed: configs()[id].files, rows: section._fileRows.length,
        subtitle: section._fileRow.subtitle});

    const [, natural] = page.measure(Gtk.Orientation.HORIZONTAL, -1);
    const [minimum] = window.measure(Gtk.Orientation.HORIZONTAL, -1);
    report('narrow', {windowWidth: window.get_width(), minimumWidth: minimum, pageNatural: natural});
    saveScreenshot(window);

    writeMonitorConfig(settings, 'DP-9:GSM:Wide:7', {file: '/gone/away.mp4', fitMode: null, optimize: null});
    await waitFor(() => page._groups.length > page._sections.size);
    const others = page._groups.at(-1);
    report('others', {groups: page._groups.length, title: others.title, sections: page._sections.size, sameSection: page._sections.get(id) === section});
    page.removeConfig('DP-9:GSM:Wide:7');
    await waitFor(() => page._groups.length === page._sections.size);
    const rebuilt = page._sections.get(id);
    page.removeConfig(id);
    const cleared = await waitFor(() => rebuilt._previewStack.visible_child_name === 'placeholder');
    report('removed', {configs: configs(), cleared, fitSensitive: rebuilt._fitRow.sensitive,
        removeSensitive: rebuilt._remove.sensitive});

    writeMonitorConfig(settings, id, {file: `${mediaDir}/plain.mp4`, fitMode: 'stretch', optimize: null});
    await sleep(30);
    page.close();
    window.close();
    await sleep(1500);
    const cache = `${GLib.get_user_cache_dir()}/gink-video-wallpaper`;
    report('closed', {pending: page._jobs.pending, refs: directoryEntries(`${cache}/refs`),
        jobs: directoryEntries(`${cache}/jobs`), stills: directoryEntries(`${cache}/stills`)});
    GLib.source_remove(ticker);
}

const loop = new GLib.MainLoop(null, false);
main().catch(error => report('error', {message: error.message, stack: error.stack})).finally(() => loop.quit());
loop.run();
