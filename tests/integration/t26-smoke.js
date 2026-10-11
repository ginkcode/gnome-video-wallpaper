import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {spawnAsync} from '../../lib/async.js';
import {computeCanvas} from '../../lib/geometry.js';
import {clearCache} from '../../lib/stillCache.js';

import {removeMonitorConfig, writeMonitorConfig} from '../../lib/config.js';

const [schemaDir, mediaDir, outDir] = ARGV;

const SCHEMA = 'org.gnome.shell.extensions.gink-video-wallpaper';
const PROBE = 't25-probe@ginkcode.github.io';
const decoder = new TextDecoder();
const report = (event, data = {}) => print(`T26_RESULT ${JSON.stringify({event, ...data})}`);
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

const COLORS = {a: 'red', b: 'green', c: 'blue', d: 'yellow'};
const media = Object.fromEntries(Object.keys(COLORS).map(name => [name, `${mediaDir}/${name}.mp4`]));

async function waitFor(predicate, timeout) {
    const start = Date.now();
    for (;;) {
        const value = await predicate();
        if (value || Date.now() - start > timeout)
            return value;
        await sleep(100);
    }
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

function sourceName(pid) {
    for (const fd of entries(`/proc/${pid}/fd`)) {
        const node = inode(`/proc/${pid}/fd/${fd}`);
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
            const ipc = argv.find(arg => arg.startsWith('--input-ipc-server=') && arg.includes(runtime));
            if (!ipc || !argv.some(arg => arg.endsWith('mpv')))
                return [];
            return [{pid: Number(pid), source: sourceName(pid), socket: ipc.split('=', 2)[1]}];
        } catch {
            return [];
        }
    }).sort((x, y) => (x.source ?? '').localeCompare(y.source ?? ''));
}

function sockets() {
    return entries(`${GLib.get_user_runtime_dir()}/gink-video-wallpaper`);
}

function dbus(name, path, iface, method, args = null, sig = null) {
    return new Promise((resolve, reject) => Gio.DBus.session.call(name, path, iface, method,
        args ? new GLib.Variant(sig, args) : null, null, Gio.DBusCallFlags.NONE, 20000, null, (bus, res) => {
            try {
                resolve(bus.call_finish(res).deep_unpack());
            } catch (error) {
                reject(error);
            }
        }));
}

const displayConfig = (method, args, sig) => dbus('org.gnome.Mutter.DisplayConfig',
    '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig', method, args, sig);
const probe = (method, args, sig) => dbus('org.ginkcode.T25Probe', '/org/ginkcode/T25Probe',
    'org.ginkcode.T25Probe', method, args, sig);

async function displayState() {
    const [serial, physical, logical] = await displayConfig('GetCurrentState');
    const monitors = physical.map(([[connector, vendor, product, serial_], modes]) => {
        const flag = (entry, name) => entry[6][name]?.deep_unpack() === true;
        const current = modes.find(entry => flag(entry, 'is-current'));
        const mode = current ?? modes.find(entry => flag(entry, 'is-preferred')) ?? modes[0];
        return {connector, id: `${connector}:${vendor}:${product}:${serial_}`, mode: mode[0],
            modeWidth: mode[1], modeHeight: mode[2], enabled: Boolean(current)};
    });
    const logicalMonitors = logical.map(([x, y, scale, transform, primary, specs]) => {
        const connectors = specs.map(spec => spec[0]).sort();
        const monitor = monitors.find(m => m.connector === connectors[0]);
        const rotated = transform % 2 === 1;
        return {connectors, x, y, scale, transform, primary,
            width: Math.round((rotated ? monitor.modeHeight : monitor.modeWidth) / scale),
            height: Math.round((rotated ? monitor.modeWidth : monitor.modeHeight) / scale)};
    });
    return {serial, monitors, logicalMonitors};
}

async function applyLayout(layout) {
    const state = await displayState();
    const modeOf = connector => state.monitors.find(m => m.connector === connector).mode;
    const logical = layout.map(({connectors, x, y, scale = 1, transform = 0, primary = false}) =>
        [x, y, scale, transform, primary, connectors.map(c => [c, modeOf(c), {}])]);
    await displayConfig('ApplyMonitorsConfig', [state.serial, 1, logical, {}], '(uua(iiduba(ssa{sv}))a{sv})');
    await sleep(300);
    return displayState();
}

function classify([r, g, b]) {
    const hi = v => v > 150;
    const lo = v => v < 100;
    if (hi(r) && lo(g) && lo(b))
        return 'red';
    if (lo(r) && hi(g) && lo(b))
        return 'green';
    if (lo(r) && lo(g) && hi(b))
        return 'blue';
    if (hi(r) && hi(g) && lo(b))
        return 'yellow';
    if (hi(r) && lo(g) && hi(b))
        return 'magenta';
    if (r < 30 && g < 30 && b < 30)
        return 'black';
    return `rgb(${r},${g},${b})`;
}


async function settle(expectedSources, timeout = 40000) {
    let stableSince = 0;
    let last = '';
    const want = JSON.stringify([...expectedSources].sort());
    return waitFor(() => {
        const now = players();
        const key = JSON.stringify(now.map(p => [p.pid, p.source]));
        if (key !== last) {
            last = key;
            stableSince = Date.now();
        }
        return JSON.stringify(now.map(p => p.source).sort()) === want && Date.now() - stableSince > 2000;
    }, timeout);
}

async function main() {
    const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, Gio.SettingsSchemaSource.get_default(), false);
    const settings = new Gio.Settings({settings_schema: source.lookup(SCHEMA, true)});
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
    await waitFor(() => probe('State').then(() => true, () => false), 30000);
    const initial = await displayState();
    const [internal, external] = [...initial.monitors].sort((a, b) => a.connector.localeCompare(b.connector));
    const I = internal.connector;
    const E = external.connector;
    const configure = (monitor, name) => {
        writeMonitorConfig(settings, monitor.id, {file: media[name], fitMode: null, optimize: null});
        Gio.Settings.sync();
    };
    const checks = {};
    let count = 0;
    async function observe(label, expected, sources) {
        const settled = await settle(sources);
        const display = await displayState();
        const logical = display.logicalMonitors.map(m => ({...m, key: m.connectors.join('|')}));
        const scale = Math.max(...logical.map(m => m.scale));
        const canvas = computeCanvas(logical, logical.length > 1 ? scale : 1);
        const options = logical.length > 1 ? 'spanned' : 'zoom';
        let result;
        const ok = await waitFor(async () => {
            const uri = background.get_string('picture-uri');
            const path = Gio.File.new_for_uri(uri).get_path();
            if (!path?.startsWith(`${GLib.getenv('XDG_DATA_HOME')}/gink-video-wallpaper/wallpapers/`) ||
                background.get_string('picture-options') !== options)
                return false;
            const raw = `${outDir}/${++count}.rgb`;
            const decoded = await spawnAsync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', path,
                '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
            if (decoded.status !== 0)
                return false;
            const [, pixels] = GLib.file_get_contents(raw);
            const dims = await spawnAsync(['ffprobe', '-v', 'error', '-show_entries', 'stream=width,height',
                '-of', 'csv=p=0', path]);
            const [width, height] = dims.stdout.trim().split(',').map(Number);
            const samples = canvas.rectangles.map(rect => {
                const xs = [rect.x, Math.floor(rect.x + rect.width / 2), rect.x + rect.width - 1];
                const ys = [rect.y, Math.floor(rect.y + rect.height / 2), rect.y + rect.height - 1];
                const colors = ys.flatMap(y => xs.map(x => {
                    const offset = (y * width + x) * 3;
                    return classify([...pixels.slice(offset, offset + 3)]);
                }));
                return {key: rect.key, colors};
            });
            result = {label, uri, options, width, height, scale, samples, canvas, settled};
            return width === canvas.width && height === canvas.height &&
                samples.every(s => s.colors.every(color => color === expected[s.key]));
        }, 20000);
        checks[label] = Boolean(ok && settled);
        report('step', {...result, ok: checks[label]});
        return result;
    }
    configure(internal, 'a');
    configure(external, 'b');
    const first = await observe('twoStills', {[I]: 'red', [E]: 'green'}, ['a', 'b']);
    await applyLayout([{connectors: [I], x: 0, y: 1080, primary: true}, {connectors: [E], x: 0, y: 0}]);
    const stacked = await observe('arrangement', {[I]: 'red', [E]: 'green'}, ['a', 'b']);
    checks.regenerated = first.uri !== stacked.uri;
    await applyLayout([{connectors: [I], x: 0, y: 0, primary: true},
        {connectors: [E], x: 1920, y: 0, scale: 1.5}]);
    await observe('mixed100150', {[I]: 'red', [E]: 'green'}, ['a', 'b']);
    await applyLayout([{connectors: [I], x: 0, y: 0, transform: 1, primary: true},
        {connectors: [E], x: 1080, y: 0, scale: 1.5}]);
    const rotated = await observe('rotated', {[I]: 'red', [E]: 'green'}, ['a', 'b']);
    await clearCache();
    checks.publishedSurvivesClear = Gio.File.new_for_uri(rotated.uri).query_exists(null) &&
        background.get_string('picture-uri') === rotated.uri;
    removeMonitorConfig(settings, external.id);
    Gio.Settings.sync();
    await observe('originalFallback', {[I]: 'red', [E]: 'magenta'}, ['a']);
    configure(external, 'b');
    await applyLayout([{connectors: [I, E], x: 0, y: 0, primary: true}]);
    const mirror = await observe('mirrorOnce', {[[I, E].sort().join('|')]: 'red'}, ['a']);
    checks.mirrorSingleRectangle = mirror.canvas.rectangles.length === 1;
    await applyLayout([{connectors: [I], x: 0, y: 0, primary: true}]);
    await observe('singleZoom', {[I]: 'red'}, ['a']);
    shellSettings.set_strv('enabled-extensions', [PROBE]);
    Gio.Settings.sync();
    checks.disableCleans = Boolean(await waitFor(() => players().length === 0 && sockets().length === 0, 15000));
    checks.restoreKeepsPublished = Gio.File.new_for_uri(first.uri).query_exists(null) &&
        background.get_string('picture-options') === 'zoom';
    report('checks', {checks});
}

const loop = new GLib.MainLoop(null, false);
main().catch(error => report('error', {message: error.message, stack: error.stack})).finally(() => loop.quit());
loop.run();
