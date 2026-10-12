import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {cacheRoot, wallpaperDir} from '../../lib/stillCache.js';
import {DiagnosticsPage} from '../../prefs/diagnosticsPage.js';
import {GeneralPage} from '../../prefs/generalPage.js';

const [schemaDir, limitedPath] = ARGV;
const SCHEMA = 'org.gnome.shell.extensions.gink-video-wallpaper';
const decoder = new TextDecoder();
const report = (event, data = {}) => print(`T22_RESULT ${JSON.stringify({event, ...data})}`);
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function waitFor(predicate, timeout = 20000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout)
            return false;
        await sleep(50);
    }
    return true;
}

function gsettings(...args) {
    const [, stdout, stderr, status] = GLib.spawn_sync(null, ['gsettings', '--schemadir', schemaDir, ...args],
        null, GLib.SpawnFlags.SEARCH_PATH, null);
    if (status !== 0)
        throw new Error(decoder.decode(stderr));
    return decoder.decode(stdout).trim();
}

function entries(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return [];
    const names = [];
    const enumerator = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info; (info = enumerator.next_file(null));)
        names.push(info.get_name());
    return names.sort();
}

function players() {
    const runtime = GLib.get_user_runtime_dir();
    return entries('/proc').filter(name => /^\d+$/.test(name)).filter(pid => {
        try {
            const [, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
            const argv = decoder.decode(bytes).split('\0');
            return argv.some(arg => arg.startsWith('--input-ipc-server=') && arg.includes(runtime));
        } catch {
            return false;
        }
    });
}

function rows(page) {
    return Object.fromEntries([...page._dependencyRows].map(([key, {icon, version}]) =>
        [key, {icon: icon.icon_name, version: version.label}]));
}

async function generalRoundTrip(settings) {
    const page = new GeneralPage({settings});
    const results = {};
    const find = (type, title) => {
        const found = [];
        const walk = widget => {
            for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
                if (child instanceof type && child.title === title)
                    found.push(child);
                walk(child);
            }
        };
        walk(page);
        return found[0];
    };
    const steps = [
        [Adw.SpinRow, 'Startup delay', 'value', 2.5, 'startup-delay-ms', 'uint32 2500'],
        [Adw.SpinRow, 'Delay between displays', 'value', 0.2, 'stagger-ms', 'uint32 200'],
        [Adw.SwitchRow, 'When a window covers the display', 'active', false, 'pause-on-maximized', 'false'],
        [Adw.SwitchRow, 'In the Overview', 'active', false, 'pause-on-overview', 'false'],
        [Adw.SwitchRow, 'On battery power', 'active', false, 'pause-on-battery', 'false'],
        [Adw.SwitchRow, 'While the screen is shared', 'active', false, 'pause-on-remote', 'false'],
        [Adw.ComboRow, 'Default fit mode', 'selected', 2, 'default-fit-mode', "'stretch'"],
        [Adw.SwitchRow, 'Optimize videos', 'active', true, 'optimize-videos', 'true'],
        [Adw.ComboRow, 'Video output', 'selected', 1, 'video-output', "'gpu-next'"],
        [Adw.SpinRow, 'Restart attempts', 'value', 7, 'max-retries', 'uint32 7'],
        [Adw.SwitchRow, 'Debug logging', 'active', true, 'debug-logging', 'true'],
    ];
    for (const [type, title, property, value, key, expected] of steps) {
        const widget = find(type, title);
        widget[property] = value;
        await sleep(200);
        const got = gsettings('get', SCHEMA, key);
        gsettings('reset', SCHEMA, key);
        const reset = await waitFor(() => widget[property] !== value, 3000);
        results[key] = {ok: got === expected, got, followsExternalReset: reset};
    }
    page.close();
    return results;
}

async function main() {
    Adw.init();
    const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, Gio.SettingsSchemaSource.get_default(),
        false);
    const settings = new Gio.Settings({settings_schema: source.lookup(SCHEMA, true)});
    report('general', {keys: await generalRoundTrip(settings)});

    const toasts = [];
    const toast = message => toasts.push(message);
    const page = new DiagnosticsPage({toast});
    const window = new Adw.PreferencesWindow();
    window.add(page);
    window.present();
    await waitFor(() => !page._jobs.pending);
    report('diagnostics', {rows: rows(page), hintVisible: page._hint.visible, size: page._sizeRow.subtitle});

    const savedPath = GLib.getenv('PATH');
    GLib.setenv('PATH', limitedPath, true);
    const limited = new DiagnosticsPage({toast});
    await waitFor(() => !limited._jobs.pending);
    GLib.setenv('PATH', savedPath, true);
    report('withoutMpv', {rows: rows(limited), hintVisible: limited._hint.visible, hint: limited._hint.subtitle});
    limited.close();

    const playing = await waitFor(() => players().length > 0, 40000);
    await sleep(2000);
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const pictureUri = background.get_string('picture-uri');
    const picture = Gio.File.new_for_uri(pictureUri).get_path();
    const before = {players: players(), refs: entries(`${cacheRoot()}/refs`), stills: entries(`${cacheRoot()}/stills`),
        wallpapers: entries(wallpaperDir()), size: page._sizeRow.subtitle};
    await page.refreshSize();
    before.size = page._sizeRow.subtitle;
    const cleared = await page.clear();
    await sleep(1500);
    const after = {players: players(), refs: entries(`${cacheRoot()}/refs`), stills: entries(`${cacheRoot()}/stills`),
        wallpapers: entries(wallpaperDir()), size: page._sizeRow.subtitle,
        pictureExists: GLib.file_test(picture, GLib.FileTest.IS_REGULAR), pictureUri: background.get_string('picture-uri')};
    report('clear', {playing, pictureUri, before, after, cleared, toast: toasts.at(-1),
        buttonSensitive: page._clearButton.sensitive});
    page.close();
    window.close();
}

const loop = new GLib.MainLoop(null, false);
main().catch(error => report('error', {message: error.message, stack: error.stack})).finally(() => loop.quit());
loop.run();
