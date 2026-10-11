import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {readMonitorConfigs, removeMonitorConfig, writeMonitorConfig} from '../../lib/config.js';
import {cacheRoot} from '../../lib/stillCache.js';

const [schemaDir, mediaDir] = ARGV;
const SCHEMA = 'org.gnome.shell.extensions.gink-video-wallpaper';
const decoder = new TextDecoder();
const report = (event, data = {}) => print(`T24_RESULT ${JSON.stringify({event, ...data})}`);
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

function inode(path) {
    try {
        return Gio.File.new_for_path(path).query_info('unix::inode', Gio.FileQueryInfoFlags.NONE, null)
            .get_attribute_uint64('unix::inode');
    } catch {
        return null;
    }
}

const media = Object.fromEntries(['a', 'b', 'c', 'd'].map(name => [name, `${mediaDir}/${name}.mp4`]));

function sourceName(pid) {
    for (const fd of entries(`/proc/${pid}/fd`)) {
        const node = inode(`/proc/${pid}/fd/${fd}`);
        let target = '';
        try {
            target = GLib.file_read_link(`/proc/${pid}/fd/${fd}`);
        } catch {
            continue;
        }
        if (!target.includes('/refs/'))
            continue;
        const name = Object.keys(media).find(key => inode(media[key]) === node);
        if (name)
            return name;
    }
    return null;
}

function players() {
    const runtime = GLib.get_user_runtime_dir();
    return entries('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
        try {
            const [, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
            const argv = decoder.decode(bytes).split('\0');
            if (!argv.some(arg => arg.startsWith('--input-ipc-server=') && arg.includes(runtime)))
                return [];
            return [{pid, source: sourceName(pid), vo: argv.find(arg => arg.startsWith('--vo='))}];
        } catch {
            return [];
        }
    });
}

function sockets() {
    return entries(`${GLib.get_user_runtime_dir()}/gink-video-wallpaper`);
}

async function settled(expected, timeout = 40000) {
    let stableSince = 0;
    let last = '';
    return waitFor(() => {
        const now = players();
        const key = JSON.stringify(now);
        if (key !== last) {
            last = key;
            stableSince = Date.now();
        }
        return now.length === 1 && now[0].source === expected && Date.now() - stableSince > 1500;
    }, timeout);
}

async function main() {
    const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, Gio.SettingsSchemaSource.get_default(),
        false);
    const settings = new Gio.Settings({settings_schema: source.lookup(SCHEMA, true)});
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const [id] = Object.keys(readMonitorConfigs(settings));
    const sample = {maxPlayers: 0, maxSockets: 0};
    const ticker = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
        sample.maxPlayers = Math.max(sample.maxPlayers, players().length);
        sample.maxSockets = Math.max(sample.maxSockets, sockets().length);
        return GLib.SOURCE_CONTINUE;
    });
    const reset = () => Object.assign(sample, {maxPlayers: 0, maxSockets: 0});
    const select = name => {
        writeMonitorConfig(settings, id, {file: media[name], fitMode: null, optimize: null});
        Gio.Settings.sync();
    };

    const login = await settled('a');
    report('login', {login, players: players(), pictureUri: background.get_string('picture-uri')});

    reset();
    const firstPid = players()[0]?.pid;
    select('b');
    const changed = await settled('b');
    report('change', {changed, ...sample, players: players(), replaced: players()[0]?.pid !== firstPid,
        sockets: sockets(), pictureUri: background.get_string('picture-uri')});

    reset();
    for (let i = 0; i < 12; i++) {
        select(['a', 'c', 'b', 'd'][i % 4]);
        await sleep(40 + (i % 3) * 120);
    }
    select('c');
    const rapid = await settled('c', 60000);
    report('rapid', {rapid, ...sample, players: players(), sockets: sockets()});

    reset();
    const beforeVo = players()[0]?.pid;
    settings.set_string('video-output', 'gpu-next');
    const voChanged = await waitFor(() => players()[0]?.vo === '--vo=gpu-next');
    const replaced = players()[0]?.pid !== beforeVo;
    settings.reset('video-output');
    const voRestored = await waitFor(() => players()[0]?.vo === '--vo=dmabuf-wayland,wlshm') && await settled('c');
    report('videoOutput', {voChanged, voRestored, replaced, ...sample, players: players()});

    reset();
    const beforeFit = players()[0]?.pid;
    settings.set_string('default-fit-mode', 'fit');
    const fitChanged = await waitFor(() => players()[0]?.pid && players()[0].pid !== beforeFit) &&
        await settled('c');
    report('fitMode', {fitChanged, ...sample, players: players()});

    reset();
    removeMonitorConfig(settings, id);
    const stopped = await waitFor(() => players().length === 0);
    await sleep(1500);
    report('removed', {stopped, ...sample, players: players(), sockets: sockets(),
        refs: entries(`${cacheRoot()}/refs`), pictureUri: background.get_string('picture-uri'),
        pictureOptions: background.get_string('picture-options'),
        applied: settings.get_boolean('wallpaper-applied')});

    reset();
    select('d');
    const again = await settled('d');
    report('readded', {again, ...sample, players: players(), pictureUri: background.get_string('picture-uri')});
    GLib.source_remove(ticker);
}

const loop = new GLib.MainLoop(null, false);
main().catch(error => report('error', {message: error.message, stack: error.stack})).finally(() => loop.quit());
loop.run();
