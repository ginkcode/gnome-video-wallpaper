import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {PlayerProcess, preparePlayerSocket} from './lib/playerProcess.js';
import {buildMpvArgv} from './lib/mpvArgs.js';
import {MpvIpc} from './lib/mpvIpc.js';

function report(event, details = {}) {
    console.log(`T07_RESULT ${JSON.stringify({event, ...details})}`);
}

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
    report('pass', {test: message});
}

function delay(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function until(predicate, label, timeoutMs = 10000) {
    const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
    while (!predicate()) {
        if (GLib.get_monotonic_time() >= deadline)
            throw new Error(`timeout: ${label}`);
        await delay(50);
    }
}

const logger = {
    debug: (...args) => report('debug', {message: args.join(' ')}),
    info: (...args) => report('info', {message: args.join(' ')}),
    warn: (...args) => report('warn', {message: args.join(' ')}),
    error: (...args) => report('error', {message: args.join(' ')}),
};

export default class T07Fixture extends Extension {
    enable() {
        this._players = [];
        this._ipcs = [];
        this._windows = [];
        this._signal = global.display.connect('window-created', (_display, window) => {
            this._windows.push(window);
            const owns = this._players.map(p => p.ownsWindow(window));
            report('window', {
                title: window.get_title(),
                pid: window.get_pid(),
                clientType: window.get_client_type(),
                owns,
            });
        });
        this._run().catch(error => {
            report('fail', {message: error.message, stack: error.stack});
            for (const player of this._players)
                player.terminateNow();
            global.context.terminate();
        });
    }

    disable() {
        if (this._signal)
            global.display.disconnect(this._signal);
        this._signal = 0;
        for (const ipc of this._ipcs)
            ipc.close();
        // Lifetime modes deliberately do not mask the spawning API's child fate.
        if (GLib.getenv('T07_MODE') === 'behavior') {
            for (const player of this._players)
                player.terminateNow();
        }
    }

    async _spawn({vo = null} = {}) {
        const socketPath = await preparePlayerSocket({cancellable: new Gio.Cancellable()});
        const argv = buildMpvArgv({mpvPath: '/usr/bin/mpv', socketPath,
            vo: vo ?? GLib.getenv('T07_VO') ?? 'wlshm', hwdec: 'no',
            lowPriority: GLib.getenv('T07_LOW_PRIORITY') !== 'false'});
        const player = new PlayerProcess({argv, socketPath, logger});
        this._players.push(player);
        player.start();
        report('spawn', {pid: Number(player.pid), socketPath, vo: vo ?? 'default'});
        const environ = {};
        try {
            const raw = Gio.File.new_for_path(`/proc/${player.pid}/environ`).load_contents(null)[1];
            const decoder = new TextDecoder();
            for (const entry of decoder.decode(raw).split('\0')) {
                if (!entry)
                    continue;
                const eq = entry.indexOf('=');
                const key = entry.slice(0, eq);
                if (key === 'WAYLAND_SOCKET' || key === 'WAYLAND_DISPLAY' || key === 'XDG_RUNTIME_DIR')
                    environ[key] = entry.slice(eq + 1);
            }
        } catch (error) {
            report('diagnostic-error', {message: error.message});
        }
        report('environ', environ);
        return {player, socketPath};
    }

    async _connect(socketPath) {
        const ipc = new MpvIpc(socketPath, logger);
        this._ipcs.push(ipc);
        await ipc.connect({timeoutMs: 5000, cancellable: new Gio.Cancellable()});
        return ipc;
    }

    async _load({player, ipc}) {
        let observedPause = null;
        const unsubscribe = ipc.observe('pause', value => observedPause = value);
        const identity = 't07-private-generated-test-asset';
        await ipc.command(['loadfile', GLib.getenv('T07_ASSET')], {assetIdentity: identity});
        await ipc.waitForContent({assetIdentity: identity, timeoutMs: 10000});
        report('content-ready', {pid: Number(player.pid)});
        await until(() => this._windows.some(window => window.get_pid() === Number(player.pid) &&
            player.ownsWindow(window)), 'owned paused window');
        assert(await ipc.command(['get_property', 'pause']) === true, 'loaded content remains paused');
        await until(() => observedPause === true, 'pause subscription');
        unsubscribe();
        observedPause = null;
        await delay(150);
        assert(observedPause === null, 'pause observer unsubscribes');
        assert(true, 'paused content produces owned Wayland window');
    }

    async _run() {
        report('api', {newSubprocess: typeof Meta.WaylandClient.new_subprocess,
            ownsWindow: typeof Meta.WaylandClient.prototype.owns_window,
            getSubprocess: typeof Meta.WaylandClient.prototype.get_subprocess,
            getPid: typeof Meta.WaylandClient.prototype.get_pid,
            terminate: typeof global.context.terminate});
        const mode = GLib.getenv('T07_MODE');
        const first = await this._spawn();
        assert(first.player.waylandClient instanceof Meta.WaylandClient, 'trusted Meta.WaylandClient spawn');
        const firstIpc = await this._connect(first.socketPath);
        await delay(400);
        assert(!this._windows.some(window => first.player.ownsWindow(window)), 'idle spawn has no owned window');
        if (mode.endsWith('loaded') || mode === 'behavior')
            await this._load({player: first.player, ipc: firstIpc});
        if (mode !== 'behavior') {
            report('lifetime-ready', {mode, pid: Number(first.player.pid)});
            if (mode.startsWith('normal')) {
                await delay(200);
                global.context.terminate();
            }
            return;
        }

        const second = await this._spawn();
        assert(second.player.waylandClient instanceof Meta.WaylandClient, 'second trusted spawn');
        const secondIpc = await this._connect(second.socketPath);
        await this._load({player: second.player, ipc: secondIpc});
        const foreign = this._windows.find(window => second.player.ownsWindow(window));
        assert(foreign && !first.player.ownsWindow(foreign), 'other trusted player window rejected');

        let exits = 0;
        let exitResult = null;
        const unsubscribeExit = first.player.onExit(result => {
            exits++;
            exitResult = result;
        });
        unsubscribeExit();
        const firstPid = Number(first.player.pid);
        first.player.waylandClient.get_subprocess().force_exit();
        await until(() => !Gio.File.new_for_path(`/proc/${firstPid}`).query_exists(null),
            'forced subprocess death');
        await delay(300);
        assert(exits === 0, 'unsubscribed exit callback is not delivered');
        let lateExits = 0;
        first.player.onExit(result => {
            lateExits++;
            exitResult = result;
        });
        await first.player.stop({graceMs: 50});
        first.player.terminateNow();
        await delay(200);
        assert(lateExits === 1 && exitResult?.signaled, 'late crash subscription delivered once');

        for (let cycle = 0; cycle < 10; cycle++) {
            const item = await this._spawn({vo: 'null'});
            const ipc = await this._connect(item.socketPath);
            await delay(100);
            assert(!this._windows.some(window => item.player.ownsWindow(window)),
                `null VO cycle ${cycle} creates no window`);
            const stops = [item.player.stop({graceMs: 50}), item.player.stop({graceMs: 50})];
            item.player.terminateNow();
            await Promise.all(stops);
            await ipc.close();
            await until(() => !Gio.File.new_for_path(item.socketPath).query_exists(null),
                `cycle ${cycle} socket cleanup`);
        }
        assert(true, 'ten stop and force cycles reap null-VO players');

        const stops = [second.player.stop({graceMs: 100}), second.player.stop({graceMs: 100})];
        second.player.terminateNow();
        await Promise.all(stops);
        await until(() => !Gio.File.new_for_path(first.socketPath).query_exists(null) &&
            !Gio.File.new_for_path(second.socketPath).query_exists(null), 'owned socket cleanup');
        assert(true, 'coalesced stop and force termination reap and remove sockets');
        for (const ipc of this._ipcs)
            await ipc.close();
        report('complete');
        global.context.terminate();
    }
}
