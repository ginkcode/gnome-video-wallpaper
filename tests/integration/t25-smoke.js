import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

import {readMonitorConfigs, removeMonitorConfig, writeMonitorConfig} from '../../lib/config.js';

const [schemaDir, mediaDir, outDir, mode] = ARGV;
const quick = mode === 'quick';
const SCHEMA = 'org.gnome.shell.extensions.gink-video-wallpaper';
const UUID = 'gink-video-wallpaper@ginkcode.github.io';
const PROBE = 't25-probe@ginkcode.github.io';
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const report = (event, data = {}) => print(`T25_RESULT ${JSON.stringify({event, ...data})}`);
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

const COLORS = {a: 'red', b: 'green', c: 'blue', d: 'yellow'};
const layersIntact = step => step.layers.length > 0 && step.layers.every(layer => layer.container?.parent &&
    layer.container.mapped && layer.clone?.inContainer && layer.clone.visible && layer.still?.inContainer);
const samePids = (a, b) => JSON.stringify(a.players) === JSON.stringify(b.players);
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

function mpvQuery(socket, names) {
    const result = {};
    let connection = null;
    try {
        connection = new Gio.SocketClient().connect(Gio.UnixSocketAddress.new(socket), null);
        const output = connection.get_output_stream();
        const input = new Gio.DataInputStream({base_stream: connection.get_input_stream()});
        names.forEach((name, index) => output.write_all(encoder.encode(
            `${JSON.stringify({command: ['get_property', name], request_id: 9000 + index})}\n`), null));
        let pending = names.length;
        while (pending > 0) {
            const [line] = input.read_line_utf8(null);
            if (line === null)
                break;
            const message = JSON.parse(line);
            if (message.request_id >= 9000) {
                result[names[message.request_id - 9000]] = message.data ?? message.error;
                pending--;
            }
        }
    } catch (error) {
        result.error = error.message;
    } finally {
        connection?.close(null);
    }
    return result;
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

async function probeState() {
    const [json] = await probe('State');
    return JSON.parse(json);
}

let captureCount = 0;
async function capture(label) {
    const path = `${outDir}/${String(++captureCount).padStart(2, '0')}-${label}.png`;
    await probe('Capture', [path], '(s)');
    return GdkPixbuf.Pixbuf.new_from_file(path);
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

function sample(pixbuf, stage, rect) {
    const ratio = pixbuf.get_width() / stage[0];
    const pixels = pixbuf.get_pixels();
    const stride = pixbuf.get_rowstride();
    const channels = pixbuf.get_n_channels();
    const inset = 4;
    const top = rect.primary ? 48 : inset;
    const xs = [rect.x + inset, rect.x + rect.width / 2, rect.x + rect.width - inset];
    const ys = [rect.y + top, rect.y + rect.height / 2, rect.y + rect.height - inset];
    return ys.flatMap(y => xs.map(x => {
        const px = Math.min(pixbuf.get_width() - 1, Math.floor(x * ratio));
        const py = Math.min(pixbuf.get_height() - 1, Math.floor(y * ratio));
        const offset = py * stride + px * channels;
        return classify([pixels[offset], pixels[offset + 1], pixels[offset + 2]]);
    }));
}

const sameRect = (a, b) => ['x', 'y', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) <= 1);

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

async function observe(label, expected, settled, timeout = 15000) {
    const display = await displayState();
    let result = null;
    await waitFor(async () => {
        const shell = await probeState();
        const pixbuf = await capture(label);
        const areas = display.logicalMonitors.map(logical => {
            const key = logical.connectors.join('|');
            const colors = sample(pixbuf, shell.stage, logical);
            const want = expected[key];
            const clones = shell.clones.filter(c => c.visible && sameRect(c, logical));
            return {key, rect: {x: logical.x, y: logical.y, width: logical.width, height: logical.height,
                scale: logical.scale, transform: logical.transform}, want, colors,
            filled: colors.every(color => color === want),
            cloneMatches: want === 'magenta' ? clones.length === 0 : clones.length === 1};
        });
        result = {areas, shell, png: [pixbuf.get_width(), pixbuf.get_height()]};
        return areas.every(area => area.filled && area.cloneMatches);
    }, timeout);
    const now = players();
    const raster = now.map(p => ({pid: p.pid, source: p.source,
        window: result.shell.windows.filter(w => w.pid === p.pid).map(({x, y, width, height}) => ({x, y, width, height})),
        ...mpvQuery(p.socket, ['osd-width', 'osd-height', 'display-hidpi-scale', 'osd-dimensions',
            'video-out-params'])}));
    const ok = result.areas.every(area => area.filled && area.cloneMatches);
    const step = {label, ok, settled, players: now.map(({pid, source}) => ({pid, source})), sockets: sockets().length,
        raster, areas: result.areas, clones: result.shell.clones, windows: result.shell.windows,
        monitors: result.shell.monitors, stage: result.shell.stage, png: result.png,
        overview: result.shell.overview, backgroundActors: result.shell.backgroundActors,
        layers: result.shell.layers, display};
    report('step', step);
    return step;
}

function rasterMatches(step) {
    return step.areas.filter(area => area.want !== 'magenta').every(area => {
        const raster = step.raster.find(r => COLORS[r.source] === area.want);
        return raster &&
            Math.abs(raster['osd-width'] - area.rect.width * area.rect.scale) <= 2 &&
            Math.abs(raster['osd-height'] - area.rect.height * area.rect.scale) <= 2;
    });
}

const pidOf = (step, source) => step.players.find(p => p.source === source)?.pid ?? null;
const alive = pid => GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS) &&
    !decoder.decode(GLib.file_get_contents(`/proc/${pid}/stat`)[1]).split(') ')[1]?.startsWith('Z');

async function quickRaster({run, checks, I, E, sideBySide}) {
    const layouts = {
        mirrored: [[{connectors: [I, E], x: 0, y: 0, primary: true}], {[[I, E].sort().join('|')]: 'red'}, ['a']],
        mixedScale: [[{connectors: [I], x: 0, y: 0, scale: 2, primary: true},
            {connectors: [E], x: 960, y: 0, scale: 1.5}], {[I]: 'red', [E]: 'green'}, ['a', 'b']],
        rotated: [[{connectors: [I], x: 0, y: 0, transform: 1, primary: true},
            {connectors: [E], x: 1080, y: 0, scale: 2}], {[I]: 'red', [E]: 'green'}, ['a', 'b']],
        externalDisabled: [[{connectors: [I], x: 0, y: 0, primary: true}], {[I]: 'red'}, ['a']],
        restored: [sideBySide, {[I]: 'red', [E]: 'green'}, ['a', 'b']],
    };
    for (const [label, [layout, expected, sources]] of Object.entries(layouts)) {
        await applyLayout(layout);
        const step = await run(label, sources, expected);
        checks[`${label}Raster`] = step.settled && step.ok && rasterMatches(step);
    }
    report('checks', {checks, quick: true});
}

async function main() {
    const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, Gio.SettingsSchemaSource.get_default(),
        false);
    const settings = new Gio.Settings({settings_schema: source.lookup(SCHEMA, true)});
    const shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
    await waitFor(() => probe('State').then(() => true, () => false), 30000);
    const initial = await displayState();
    report('display', initial);
    const [internal, external] = [...initial.monitors].sort((x, y) => x.connector.localeCompare(y.connector));
    const ids = {[internal.connector]: internal.id, [external.connector]: external.id};
    const I = internal.connector;
    const E = external.connector;
    const config = (connector, name) => {
        writeMonitorConfig(settings, ids[connector], {file: media[name], fitMode: null, optimize: null});
        Gio.Settings.sync();
    };
    const unconfig = connector => {
        removeMonitorConfig(settings, ids[connector]);
        Gio.Settings.sync();
    };
    const sideBySide = [{connectors: [I], x: 0, y: 0, primary: true}, {connectors: [E], x: 1920, y: 0}];
    const checks = {};
    const steps = {};
    const run = async (label, sources, expected) => {
        const settledOk = await settle(sources);
        steps[label] = await observe(label, expected, settledOk);
        return steps[label];
    };

    config(I, 'a');
    config(E, 'b');
    report('configs', {configs: readMonitorConfigs(settings)});
    let s = await run('twoPlayers', ['a', 'b'], {[I]: 'red', [E]: 'green'});
    checks.twoPlayers = s.settled && s.ok && s.sockets === 2;
    const internalPid = pidOf(s, 'a');
    const externalPid = pidOf(s, 'b');

    if (quick)
        return quickRaster({run, sideBySide, checks, I, E});

    unconfig(E);
    s = await run('externalUnconfigured', ['a'], {[I]: 'red', [E]: 'magenta'});
    checks.removeExternalKeepsInternal = s.settled && s.ok && pidOf(s, 'a') === internalPid &&
        !alive(externalPid) && s.sockets === 1;

    config(E, 'b');
    s = await run('externalReconfigured', ['a', 'b'], {[I]: 'red', [E]: 'green'});
    checks.readdExternal = s.settled && s.ok && pidOf(s, 'a') === internalPid && s.sockets === 2;

    await applyLayout([{connectors: [I, E], x: 0, y: 0, primary: true}]);
    const mirrorKey = [I, E].sort().join('|');
    s = await run('mirrored', ['a'], {[mirrorKey]: 'red'});
    const mirroredPid = pidOf(s, 'a');
    checks.mirrorSharesSortedSelector = s.settled && s.ok && s.players.length === 1 && s.sockets === 1 &&
        s.areas.length === 1 && rasterMatches(s);

    unconfig(I);
    s = await run('mirroredFallback', ['b'], {[mirrorKey]: 'green'});
    checks.mirrorFallsBackToNextConnector = s.settled && s.ok && s.players.length === 1 && !alive(mirroredPid);
    config(I, 'a');
    s = await run('mirroredRestored', ['a'], {[mirrorKey]: 'red'});
    checks.mirrorRestoresFirstConnector = s.settled && s.ok && s.players.length === 1;

    await applyLayout(sideBySide);
    s = await run('unmirrored', ['a', 'b'], {[I]: 'red', [E]: 'green'});
    checks.unmirrorIndependent = s.settled && s.ok && s.sockets === 2;

    await applyLayout([{connectors: [I], x: 0, y: 0, scale: 2, primary: true},
        {connectors: [E], x: 960, y: 0, scale: 1.5}]);
    s = await run('mixedScale', ['a', 'b'], {[I]: 'red', [E]: 'green'});
    checks.mixedScaleFills = s.settled && s.ok;
    checks.mixedScaleRaster = rasterMatches(s);

    await applyLayout([{connectors: [I], x: 0, y: 0, transform: 1, primary: true},
        {connectors: [E], x: 1080, y: 0, scale: 2}]);
    s = await run('rotated', ['a', 'b'], {[I]: 'red', [E]: 'green'});
    checks.rotationFills = s.settled && s.ok;
    checks.rotationRaster = rasterMatches(s);

    await applyLayout([{connectors: [I], x: 0, y: 1080, primary: true}, {connectors: [E], x: 0, y: 0}]);
    s = await run('stacked', ['a', 'b'], {[I]: 'red', [E]: 'green'});
    checks.positionFills = s.settled && s.ok && rasterMatches(s);

    await applyLayout(sideBySide);
    s = await run('restored', ['a', 'b'], {[I]: 'red', [E]: 'green'});
    checks.restoredLayout = s.settled && s.ok;
    const restoredInternal = pidOf(s, 'a');
    const restoredExternal = pidOf(s, 'b');

    const managers = await probe('Rebuild');
    await sleep(1500);
    s = await run('backgroundsRebuilt', ['a', 'b'], {[I]: 'red', [E]: 'green'});
    checks.rebuildPreservesLayers = s.settled && s.ok && samePids(s, steps.restored) && layersIntact(s) &&
        managers[0] === 2;
    const [destroyed] = await probe('DestroyContainers');
    await sleep(1500);
    s = await run('containersRescued', ['a', 'b'], {[I]: 'red', [E]: 'green'});
    checks.containerLossRescued = s.settled && s.ok && samePids(s, steps.restored) && layersIntact(s) &&
        destroyed === 2;

    await applyLayout([{connectors: [I], x: 0, y: 0, primary: true}]);
    s = await run('externalDisabled', ['a'], {[I]: 'red'});
    checks.unplugReapsExternalOnly = s.settled && s.ok && pidOf(s, 'a') === restoredInternal &&
        !alive(restoredExternal) && s.sockets === 1 && rasterMatches(s);

    await applyLayout(sideBySide);
    s = await run('externalReenabled', ['a', 'b'], {[I]: 'red', [E]: 'green'});
    checks.replugStartsExternal = s.settled && s.ok && s.sockets === 2 && rasterMatches(s);
    checks.replugKeepsInternal = pidOf(s, 'a') === restoredInternal;

    const finalPids = players().map(p => p.pid);
    shellSettings.set_strv('enabled-extensions', [PROBE]);
    Gio.Settings.sync();
    const stopped = await waitFor(() => players().length === 0 && sockets().length === 0, 15000);
    await probe('Rebuild');
    await sleep(2500);
    const after = await probeState();
    checks.noActorsAfterDisable = after.clones.length === 0 && after.layers.length === 0;
    report('afterDisable', {clones: after.clones, layers: after.layers, backgroundActors: after.backgroundActors});
    checks.disableCleans = stopped && finalPids.every(pid => !alive(pid)) && sockets().length === 0;
    report('disabled', {stopped, finalPids, players: players(), sockets: sockets(), uuid: UUID});
    report('checks', {checks});
}

const loop = new GLib.MainLoop(null, false);
main().catch(error => report('error', {message: error.message, stack: error.stack})).finally(() => loop.quit());
loop.run();
