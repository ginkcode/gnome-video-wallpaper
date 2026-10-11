import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {readMonitorConfigs} from '../../lib/config.js';
import {cacheRoot} from '../../lib/stillCache.js';
import {MonitorsPage} from '../../prefs/monitorsPage.js';

const [schemaDir, mediaDir, uuid] = ARGV;
const SCHEMA = 'org.gnome.shell.extensions.gink-video-wallpaper';
const decoder = new TextDecoder();
const report = (event, data = {}) => print(`T23_RESULT ${JSON.stringify({event, ...data})}`);
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function waitFor(predicate, timeout = 30000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout)
            return false;
        await sleep(25);
    }
    return true;
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

function playerSources() {
    const runtime = GLib.get_user_runtime_dir();
    return entries('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
        try {
            const [, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
            const argv = decoder.decode(bytes).split('\0');
            if (!argv.some(arg => arg.startsWith('--input-ipc-server=') && arg.includes(runtime)))
                return [];
            const open = entries(`/proc/${pid}/fd`).map(fd => {
                try {
                    return GLib.file_read_link(`/proc/${pid}/fd/${fd}`);
                } catch {
                    return '';
                }
            });
            return [{pid, source: open.find(path => path.includes('/refs/'))?.split('/').at(-1) ?? null,
                loop: argv.includes('--loop-file=inf')}];
        } catch {
            return [];
        }
    });
}

function extensions(action) {
    GLib.spawn_sync(null, ['gnome-extensions', action, uuid], null, GLib.SpawnFlags.SEARCH_PATH, null);
}

async function main() {
    Adw.init();
    const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, Gio.SettingsSchemaSource.get_default(),
        false);
    const settings = new Gio.Settings({settings_schema: source.lookup(SCHEMA, true)});
    const media = () => entries(`${cacheRoot()}/media`);
    const jobs = () => entries(`${cacheRoot()}/jobs`);

    await waitFor(() => playerSources()[0]?.source, 40000);
    report('login', {players: playerSources(), media: media()});

    settings.set_string('monitor-configs', '{}');
    const toasts = [];
    const window = new Adw.PreferencesWindow();
    const page = new MonitorsPage({settings, toast: message => toasts.push(message)});
    window.add(page);
    window.present();
    await waitFor(() => page._sections.size > 0);
    const [id, section] = [...page._sections.entries()][0];
    const logical = section._logical;
    const configs = () => readMonitorConfigs(settings);

    const seen = {progress: 0, configDuringProgress: false};
    const ticker = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
        const current = page._sections.get(id);
        if (current?._progressRow.visible) {
            seen.progress = Math.max(seen.progress, current._progress.fraction);
            seen.configDuringProgress ||= configs()[id]?.file === `${mediaDir}/timing.gif`;
        }
        return GLib.SOURCE_CONTINUE;
    });
    await page.select(id, logical, `${mediaDir}/timing.gif`);
    report('gif', {config: configs()[id], ...seen, media: media(), toasts: [...toasts],
        progressHidden: !section._progressRow.visible});

    const before = playerSources().map(player => player.pid);
    extensions('disable');
    await waitFor(() => playerSources().length === 0);
    extensions('enable');
    await waitFor(() => playerSources()[0]?.source && !before.includes(playerSources()[0].pid), 40000);
    report('relogin', {players: playerSources()});

    await page.select(id, logical, `${mediaDir}/plain.mp4`);
    await waitFor(() => page._jobs.pending === 0);
    const plainMedia = media();
    const beforeGeneration = page.optimizedGeneration(id);
    const current = page._sections.get(id);
    current._optimizeRow.selected = 1;
    const optimized = await waitFor(() => media().length > plainMedia.length && page._jobs.pending === 0);
    await waitFor(() => current._previewStack.visible_child_name === 'picture');
    const liveOptimized = await waitFor(() => playerSources()[0]?.source === 'optimized', 40000);
    report('optimizeOn', {config: configs()[id], optimized, media: media(),
        generation: page.optimizedGeneration(id) - beforeGeneration, liveOptimized,
        preview: current._previewStack.visible_child_name, toasts: [...toasts]});

    const count = media().length;
    const pending = page.select(id, logical, `${mediaDir}/long.mp4`);
    const started = await waitFor(() => page._sections.get(id)?._progressRow.visible);
    page.removeConfig(id);
    await pending;
    await waitFor(() => page._jobs.pending === 0 && jobs().length === 0, 5000);
    await sleep(500);
    report('cancelled', {started, configs: configs(), jobs: jobs(), mediaCount: media().length, before: count,
        progressHidden: !page._sections.get(id)?._progressRow.visible});

    GLib.source_remove(ticker);
    page.close();
    window.close();
    await sleep(500);
    report('closed', {jobs: jobs(), pending: page._jobs.pending});
}

const loop = new GLib.MainLoop(null, false);
main().catch(error => report('error', {message: error.message, stack: error.stack})).finally(() => loop.quit());
loop.run();
