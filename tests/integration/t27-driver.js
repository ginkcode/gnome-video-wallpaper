import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

const [scenarioJson, asset, outDir, repo] = ARGV;
const scenario = JSON.parse(scenarioJson);
const OURS = 'gink-video-wallpaper@ginkcode.github.io';
const HANABI = 'hanabi-extension@jeffshee.github.io';
const ACTIVE = 1;
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const report = (event, data = {}) => print(`T27_RESULT ${JSON.stringify({event, ...data})}`);
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function waitFor(predicate, timeout) {
    const start = Date.now();
    for (;;) {
        const value = await predicate();
        if (value || Date.now() - start > timeout)
            return value;
        await sleep(150);
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

function cmdline(pid) {
    try {
        return decoder.decode(GLib.file_get_contents(`/proc/${pid}/cmdline`)[1]).split('\0');
    } catch {
        return [];
    }
}

function players() {
    const runtime = GLib.get_user_runtime_dir();
    return entries('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
        const argv = cmdline(pid);
        const ipc = argv.find(arg => arg.startsWith('--input-ipc-server=') && arg.includes(runtime));
        if (!ipc || !argv.some(arg => arg.endsWith('mpv')))
            return [];
        return [{pid: Number(pid), socket: ipc.split('=', 2)[1], argv: argv.filter(arg => arg.startsWith('--'))}];
    });
}

function privateProcess(pid) {
    try {
        const environ = decoder.decode(GLib.file_get_contents(`/proc/${pid}/environ`)[1]).split('\0');
        return environ.includes(`XDG_RUNTIME_DIR=${GLib.get_user_runtime_dir()}`);
    } catch {
        return false;
    }
}

const sockets = () => entries(`${GLib.get_user_runtime_dir()}/gink-video-wallpaper`);

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

const probe = (method, args, sig) => dbus('org.ginkcode.T27Probe', '/org/ginkcode/T27Probe',
    'org.ginkcode.T27Probe', method, args, sig);

async function state() {
    const [json] = await probe('State');
    return JSON.parse(json);
}

async function fakeLog() {
    try {
        const [json] = await dbus('org.ginkcode.T27Fake', '/org/ginkcode/T27Fake', 'org.ginkcode.T27Fake', 'Log');
        return JSON.parse(json);
    } catch (error) {
        return {error: error.message, calls: [], inhibitors: []};
    }
}

async function isInhibited(flags) {
    try {
        return (await dbus('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
            'IsInhibited', [flags], '(u)'))[0];
    } catch (error) {
        return `error: ${error.message}`;
    }
}

async function busNames() {
    const [names] = await dbus('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames');
    return names;
}

let captureCount = 0;
async function capture(label) {
    const path = `${outDir}/${scenario.name}-${String(++captureCount).padStart(2, '0')}-${label}.png`;
    await probe('Capture', [path], '(s)');
    return GdkPixbuf.Pixbuf.new_from_file(path);
}

function hue([r, g, b]) {
    if (r > g + 40 && r > b + 40)
        return 'red';
    if (r < 30 && g < 30 && b < 30)
        return 'black';
    if (r > 150 && b > 150 && g < 100)
        return 'magenta';
    return `rgb(${r},${g},${b})`;
}

function pixelAt(pixbuf, stage, x, y) {
    const ratio = pixbuf.get_width() / stage[0];
    const px = Math.min(pixbuf.get_width() - 1, Math.floor(x * ratio));
    const py = Math.min(pixbuf.get_height() - 1, Math.floor(y * ratio));
    const pixels = pixbuf.get_pixels();
    const offset = py * pixbuf.get_rowstride() + px * pixbuf.get_n_channels();
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
}

async function playback(socket) {
    const first = mpvQuery(socket, ['time-pos', 'pause']);
    await sleep(1200);
    const second = mpvQuery(socket, ['time-pos', 'pause']);
    return {first, second, advancing: typeof first['time-pos'] === 'number' &&
        typeof second['time-pos'] === 'number' && second['time-pos'] !== first['time-pos'] &&
        second.pause === false};
}

async function waitPlaying(timeout = 60000) {
    let last = null;
    const ok = await waitFor(async () => {
        const now = players();
        if (now.length !== 1)
            return false;
        last = await playback(now[0].socket);
        return last.advancing;
    }, timeout);
    return {ok: Boolean(ok), players: players().map(p => p.pid), playback: last};
}

async function waitStopped(timeout = 15000) {
    return Boolean(await waitFor(() => players().length === 0 && sockets().length === 0, timeout));
}

async function observe(label, {shot = true} = {}) {
    const shell = await state();
    const now = players();
    const play = now.length === 1 ? await playback(now[0].socket) : null;
    let pixels = null;
    if (shot) {
        const pixbuf = await capture(label);
        const top = shell.panel.rect.height || 32;
        pixels = {center: pixelAt(pixbuf, shell.stage, shell.stage[0] / 2, shell.stage[1] / 2),
            leftMid: pixelAt(pixbuf, shell.stage, shell.stage[0] * 0.08, shell.stage[1] / 2),
            belowPanel: pixelAt(pixbuf, shell.stage, shell.stage[0] / 2, top + 24),
            panel: pixelAt(pixbuf, shell.stage, shell.stage[0] * 0.3, Math.max(2, Math.floor(top / 2))),
            dockArea: pixelAt(pixbuf, shell.stage, shell.stage[0] / 2, shell.stage[1] - 20)};
        pixels.hues = Object.fromEntries(Object.entries(pixels).map(([key, value]) => [key, hue(value)]));
    }
    const ours = shell.extensions.find(e => e.uuid === OURS);
    const layer = shell.layers[0];
    const step = {
        label, now: shell.now, extensions: shell.extensions, order: shell.order, mode: shell.mode, locked: shell.locked,
        players: now.map(p => p.pid), playback: play, pixels, windows: shell.windows, layers: shell.layers,
        running: shell.running, runningOurs: shell.runningOurs, docks: shell.docks, monitors: shell.monitors,
        panel: shell.panel, focusApp: shell.focusApp, hanabiWatcher: shell.hanabiWatcher,
        argv: now[0]?.argv ?? [],
        checks: {
            oursActive: ours?.state === ACTIVE,
            onePlayer: now.length === 1,
            playing: Boolean(play?.advancing),
            stopScreensaverNo: now.length === 1 && now[0].argv.includes('--stop-screensaver=no'),
            cloneRenders: Boolean(layer?.clone?.visible && layer.clone.mapped) &&
                (!pixels || pixels.hues.leftMid === 'red'),
            notRunningApp: shell.runningOurs.length === 0 && shell.windows.every(w => w.skipTaskbar),
            notInDock: shell.docks.every(d => d.ourIcons.length === 0),
            windowHidden: shell.windows.every(w => w.actorOpacity === 0 && !w.focused),
            noStaleWindows: shell.windows.every(w => w.process !== null),
        },
    };
    report('step', step);
    return step;
}

async function toggle(uuid, enable) {
    const [ok] = await probe('Toggle', [uuid, enable], '(sb)');
    return ok;
}

async function extensionState(uuid) {
    return (await state()).extensions.find(e => e.uuid === uuid) ?? null;
}

async function idleCheck(label, control) {
    const shellPid = Number(entries('/proc').find(pid => cmdline(pid)[0]?.endsWith('gnome-shell') &&
        privateProcess(pid)) ?? 0);
    const before = await fakeLog();
    const ourPids = players().map(p => p.pid);
    const result = {label, shellPid, ourPids, inhibitedBefore: await isInhibited(8), inhibitorsBefore: before.inhibitors,
        mprisNames: (await busNames()).filter(name => name.startsWith('org.mpris.'))};
    if (control) {
        const vo = players()[0]?.argv.find(arg => arg.startsWith('--vo=')) ?? '--vo=gpu';
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_SILENCE |
            Gio.SubprocessFlags.STDERR_SILENCE});
        launcher.setenv('WAYLAND_DISPLAY', 'wayland-0', true);
        const proc = launcher.spawnv(['mpv', '--no-config', '--no-audio', '--stop-screensaver=yes',
            '--force-window=yes', '--loop-file=inf', vo, '--wayland-app-id=t27-control', '--geometry=320x240',
            '--title=t27-control', asset]);
        result.controlInhibited = Boolean(await waitFor(async () => (await isInhibited(8)) === true, 15000));
        result.controlLog = (await fakeLog()).inhibitors;
        proc.force_exit();
        result.controlReleased = Boolean(await waitFor(async () => (await isInhibited(8)) === false, 15000));
        result.afterControl = (await fakeLog()).inhibitors;
    }
    result.calls = (await fakeLog()).calls;
    report('idle', result);
    return result;
}

async function runPrefsHelper() {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE |
        Gio.SubprocessFlags.STDERR_MERGE});
    launcher.setenv('WAYLAND_DISPLAY', 'wayland-0', true);
    launcher.setenv('GDK_BACKEND', 'wayland', true);
    const proc = launcher.spawnv(['gjs', '-m', `${repo}/tests/integration/t27-prefs.js`]);
    const [, stdout] = await new Promise((resolve, reject) => proc.communicate_utf8_async(null, null, (p, res) => {
        try {
            resolve(p.communicate_utf8_finish(res));
        } catch (error) {
            reject(error);
        }
    }));
    const events = {};
    for (const line of stdout.split('\n')) {
        const index = line.indexOf('T27_PREFS ');
        if (index >= 0) {
            const event = JSON.parse(line.slice(index + 'T27_PREFS '.length));
            events[event.event] = event;
        }
    }
    report('prefs', {events, output: stdout.split('\n').filter(l => !l.includes('T27_PREFS')).slice(-20)});
    return events;
}

async function main() {
    await waitFor(() => probe('State').then(() => true, () => false), 60000);
    await waitFor(async () => !(await state()).overview || (await probe('HideOverview')) && false, 20000);
    if (scenario.hanabi) {
        await waitFor(async () => (await extensionState(HANABI))?.state === ACTIVE, 30000);
        await sleep(5000);
        const prefs = await runPrefsHelper();
        await sleep(2000);
        const shell = await state();
        const now = players();
        report('hanabi', {prefs, watcher: shell.hanabiWatcher, hanabiState: (await extensionState(HANABI))?.state,
            layers: shell.layers, players: now.map(p => p.pid),
            playback: now.length === 1 ? await playback(now[0].socket) : null});
        await toggle(HANABI, false);
        await sleep(1500);
        report('hanabiOff', {watcher: (await state()).hanabiWatcher});
    }
    const settled = await waitPlaying(90000);
    report('start', {settled, scenario});
    await sleep(2000);
    await observe('initial');
    await idleCheck('initial', scenario.idleControl);

    if (scenario.caffeineUser) {
        const source = Gio.SettingsSchemaSource.new_from_directory(
            `${GLib.get_user_data_dir()}/gnome-shell/extensions/caffeine@patapon.info/schemas`,
            Gio.SettingsSchemaSource.get_default(), false);
        const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.caffeine', false)});
        settings.set_boolean('cli-toggle', true);
        Gio.Settings.sync();
        await sleep(2500);
        const on = await observe('caffeineOn', {shot: false});
        const log = await fakeLog();
        settings.set_boolean('cli-toggle', false);
        Gio.Settings.sync();
        await sleep(2500);
        report('caffeine', {inhibitorsWhileOn: log.inhibitors, playingWhileOn: on.checks.playing,
            after: (await fakeLog()).inhibitors});
    }

    if (scenario.lock) {
        await probe('Lock', [true], '(b)');
        const stopped = await waitStopped(15000);
        await sleep(1500);
        const locked = await state();
        report('locked', {stopped, locked: locked.locked, mode: locked.mode, extensions: locked.extensions});
        await probe('Lock', [false], '(b)');
        const resumed = await waitPlaying(60000);
        report('unlocked', {resumed});
        await observe('afterUnlock');
    }

    for (let i = 0; i < (scenario.cycleOurs ?? 0); i++) {
        await toggle(OURS, false);
        const stopped = await waitStopped();
        await sleep(1500);
        const docksWithoutOurs = (await state()).docks;
        await toggle(OURS, true);
        const resumed = await waitPlaying();
        await sleep(1500);
        report('cycle', {index: i, stopped, resumed, docksWithoutOurs, docksWithOurs: (await state()).docks});
    }
    if (scenario.cycleOurs)
        await observe('afterCycles');

    for (const uuid of scenario.toggleOthers ?? []) {
        const before = players().map(p => p.pid);
        await toggle(uuid, false);
        await sleep(1500);
        await toggle(uuid, true);
        await waitFor(async () => (await extensionState(uuid))?.state === ACTIVE, 10000);
        const resumed = await waitPlaying();
        await sleep(1000);
        const step = await observe(`after-${uuid.split('@')[0]}`);
        report('toggleOther', {uuid, before, resumed, oursRestarted: JSON.stringify(before) !== JSON.stringify(step.players),
            otherState: await extensionState(uuid), order: step.order});
    }

    const finalState = await state();
    await toggle(OURS, false);
    const stopped = await waitStopped();
    await sleep(1500);
    const after = await state();
    report('final', {stopped, players: players(), sockets: sockets(), backgroundClones: after.backgroundClones,
        hanabiWatcher: after.hanabiWatcher, events: finalState.events});
}

const loop = new GLib.MainLoop(null, false);
main().catch(error => report('error', {message: error.message, stack: error.stack})).finally(() => loop.quit());
loop.run();
