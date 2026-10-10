import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {createLogger} from './log.js';

export const PlayerState = Object.freeze({
    STARTING: 'starting',
    PLAYING: 'playing',
    PAUSED: 'paused',
    FAILED: 'failed',
    STOPPED: 'stopped',
});

const STARTUP = 'startup';
const FADE_MS = 300;
const TIMEOUT_MS = 10000;

// Module scope so a manager created by a rapid re-enable still waits for the
// previous instance's processes to be reaped before spawning.
const outstandingReaps = new Set();

export function trackReap(promise) {
    const tracked = Promise.resolve(promise).catch(() => {}).finally(() => outstandingReaps.delete(tracked));
    outstandingReaps.add(tracked);
    return tracked;
}

export function outstandingReapCount() {
    return outstandingReaps.size;
}

export function fitCommands(fitMode, geometryBaked = false) {
    const mode = geometryBaked ? 'stretch' : fitMode;
    const properties = {
        fill: {keepaspect: true, panscan: 1},
        fit: {keepaspect: true, panscan: 0},
        stretch: {keepaspect: false, panscan: 0},
    }[mode];
    if (!properties)
        throw new Error(`unknown fit mode ${fitMode}`);
    return Object.entries(properties).map(([name, value]) => ['set_property', name, value]);
}

function superseded() {
    return new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Player start superseded');
}

export class PlayerManagerLifecycle {
    constructor({env, logger = createLogger('player-manager'), fadeMs = FADE_MS, timeoutMs = TIMEOUT_MS}) {
        this._env = env;
        this._log = logger;
        this._fadeMs = fadeMs;
        this._timeoutMs = timeoutMs;
        this._generation = 0;
        this._cancellable = null;
        this._players = new Map();
        this._reasons = new Map();
    }

    getState(logicalMonitorKey) {
        return this._players.get(logicalMonitorKey)?.state ?? PlayerState.STOPPED;
    }

    getPlayer(logicalMonitorKey) {
        return this._players.get(logicalMonitorKey) ?? null;
    }

    async start() {
        if (this._cancellable)
            throw new Error('PlayerManager is already started');
        const generation = ++this._generation;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const check = () => {
            if (generation !== this._generation || cancellable.is_cancelled())
                throw superseded();
        };
        let record = null;
        try {
            await Promise.all([...outstandingReaps]);
            check();
            const target = await this._env.resolveTarget({cancellable});
            check();
            if (!target) {
                this._log.info('no wallpaper configured for the primary monitor');
                return;
            }
            record = {logicalMonitorKey: target.logicalMonitorKey,
                selectedPhysicalMonitorId: target.selectedPhysicalMonitorId, asset: target.asset,
                process: null, ipc: null, layer: null, state: PlayerState.STARTING, released: false};
            this._players.set(record.logicalMonitorKey, record);
            this._reasonsFor(record.logicalMonitorKey).add(STARTUP);
            await this._launch(record, target, cancellable, check);
        } catch (error) {
            if (generation !== this._generation || cancellable.is_cancelled())
                return;
            this._log.error(`player start failed: ${error.message}`);
            if (record)
                this._fail(record);
        }
    }

    async _launch(record, target, cancellable, check) {
        const timeoutMs = this._timeoutMs;
        record.layer = this._env.createLayer(target);
        if (target.stillPath) {
            await record.layer.prepareStatic(target.stillPath, {cancellable});
            check();
        }
        const socketPath = await this._env.prepareSocket({cancellable});
        try {
            check();
        } catch (error) {
            this._env.releaseSocket(socketPath);
            throw error;
        }
        record.process = this._env.createProcess({socketPath, target});
        const discovery = record.layer.watchWindow(record.process, {timeoutMs, cancellable});
        discovery.catch(() => {});
        record.process.onExit(result => this._exited(record, result));
        record.process.start();
        record.ipc = this._env.createIpc(socketPath);
        await record.ipc.connect({timeoutMs, cancellable});
        check();
        for (const args of fitCommands(target.asset.geometry.fitMode, target.asset.geometryBaked))
            await record.ipc.command(args, {cancellable});
        check();
        const assetIdentity = target.asset.identity;
        await record.ipc.command(['loadfile', target.asset.path], {cancellable, assetIdentity});
        check();
        const painted = discovery.then(window => {
            check();
            record.layer.attach(window);
            return record.layer.waitForFirstFrame({timeoutMs, cancellable});
        });
        painted.catch(() => {});
        await Promise.all([record.ipc.waitForContent({assetIdentity, timeoutMs, cancellable}), painted]);
        check();
        await record.layer.fadeIn(this._fadeMs, {cancellable});
        check();
        record.state = PlayerState.PAUSED;
        this.setPaused(record.logicalMonitorKey, STARTUP, false);
    }

    stop() {
        this._generation++;
        this._cancellable?.cancel();
        this._cancellable = null;
        for (const record of this._players.values()) {
            this._release(record);
            record.state = PlayerState.STOPPED;
        }
        this._players.clear();
        this._reasons.clear();
    }

    async reconcile() {
        this.stop();
        await this.start();
    }

    setPaused(logicalMonitorKey, reason, paused) {
        if (typeof logicalMonitorKey !== 'string' || !logicalMonitorKey ||
            typeof reason !== 'string' || !reason)
            throw new Error('setPaused requires a logical monitor key and reason');
        const reasons = this._reasonsFor(logicalMonitorKey);
        if (paused)
            reasons.add(reason);
        else
            reasons.delete(reason);
        const record = this._players.get(logicalMonitorKey);
        if (!record || record.released ||
            (record.state !== PlayerState.PLAYING && record.state !== PlayerState.PAUSED))
            return;
        const pause = reasons.size > 0;
        record.state = pause ? PlayerState.PAUSED : PlayerState.PLAYING;
        const generation = this._generation;
        record.ipc.setPause(pause).catch(error => {
            if (generation === this._generation && !record.released)
                this._log.warn(`set pause failed: ${error.message}`);
        });
    }

    _reasonsFor(logicalMonitorKey) {
        let reasons = this._reasons.get(logicalMonitorKey);
        if (!reasons) {
            reasons = new Set();
            this._reasons.set(logicalMonitorKey, reasons);
        }
        return reasons;
    }

    _exited(record, {status, signaled}) {
        if (record.released)
            return;
        this._log.warn(`player exited unexpectedly (status ${status}${signaled ? ', signaled' : ''})`);
        this._fail(record);
    }

    _fail(record) {
        this._release(record);
        record.state = PlayerState.FAILED;
    }

    _release(record) {
        if (record.released)
            return;
        record.released = true;
        record.layer?.destroy();
        const closing = record.ipc ? Promise.resolve(record.ipc.close()) : null;
        if (record.process) {
            record.process.terminateNow();
            trackReap(Promise.all([record.process.stop({graceMs: 0}), closing]));
        }
    }
}
