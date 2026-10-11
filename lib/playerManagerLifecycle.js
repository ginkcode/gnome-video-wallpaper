import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {sleep} from './async.js';
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
const GRACE_MS = 1000;
const BACKOFF_MS = [2000, 8000, 30000];
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const HEALTHY_MS = 60000;

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

function now() {
    return Math.round(GLib.get_monotonic_time() / 1000);
}

function superseded() {
    return new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Player start superseded');
}

export class PlayerManagerLifecycle {
    constructor({env, logger = createLogger('player-manager'), fadeMs = FADE_MS, timeoutMs = TIMEOUT_MS,
        graceMs = GRACE_MS, backoffMs = BACKOFF_MS, failureWindowMs = FAILURE_WINDOW_MS, healthyMs = HEALTHY_MS}) {
        this._env = env;
        this._log = logger;
        this._fadeMs = fadeMs;
        this._timeoutMs = timeoutMs;
        this._graceMs = graceMs;
        this._backoffMs = backoffMs;
        this._failureWindowMs = failureWindowMs;
        this._healthyMs = healthyMs;
        this._health = new Map();
        this._live = new Map();
        this._timers = new Set();
        this._generation = 0;
        this._started = false;
        this._request = 0;
        this._queue = Promise.resolve();
        this._cancellable = null;
        this._players = new Map();
        this._pending = new Set();
        this._reasons = new Map();
    }

    getState(logicalMonitorKey) {
        return this._players.get(logicalMonitorKey)?.state ?? PlayerState.STOPPED;
    }

    getPlayer(logicalMonitorKey) {
        return this._players.get(logicalMonitorKey) ?? null;
    }

    async start() {
        if (this._started)
            throw new Error('PlayerManager is already started');
        this._started = true;
        await this._schedule(true);
    }

    async reconcile() {
        if (!this._started) {
            await this.start();
            return;
        }
        await this._schedule(false);
    }

    stop({restore = false} = {}) {
        this._generation++;
        this._started = false;
        this._queue = Promise.resolve();
        this._cancellable?.cancel();
        this._cancellable = null;
        for (const record of [...this._players.values(), ...this._pending]) {
            this._release(record);
            record.layer?.destroy();
            record.process?.terminateNow();
            record.state = PlayerState.STOPPED;
        }
        this._players.clear();
        this._pending.clear();
        this._reasons.clear();
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        this._health.clear();
        this._env.onStop?.({restore});
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

    _schedule(gated) {
        const generation = this._generation;
        const request = ++this._request;
        const run = this._queue.then(() => {
            if (generation === this._generation && (gated || request === this._request))
                return this._run(generation, gated);
            return undefined;
        });
        this._queue = run;
        return run;
    }

    async _run(generation, gated) {
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const check = () => {
            if (generation !== this._generation || cancellable.is_cancelled())
                throw superseded();
        };
        try {
            if (gated) {
                await this._env.waitForStartup?.({cancellable});
                check();
                this._log.debug(`startup gate released at ${now()} ms`);
            }
            await Promise.all([...outstandingReaps]);
            check();
            const targets = await this._env.resolveTargets({cancellable});
            check();
            const keys = new Set(targets.map(target => target.logicalMonitorKey));
            for (const [key, old] of this._players) {
                if (!keys.has(key)) {
                    this._release(old);
                    this._players.delete(key);
                }
            }
            if (targets.length === 0)
                this._log.info('no wallpaper configured');
            let started = 0;
            for (const target of targets) {
                const previous = this._players.get(target.logicalMonitorKey) ?? null;
                if (previous && !previous.released && previous.selectionKey === target.selectionKey)
                    continue;
                const health = this._healthFor(target.logicalMonitorKey);
                if (health.blocked !== null) {
                    if (health.blocked === target.selectionKey)
                        continue;
                    this._health.delete(target.logicalMonitorKey);
                }
                if (started++ > 0) {
                    await sleep(this._env.staggerMs?.() ?? 0, cancellable);
                    check();
                }
                await this._startTarget(target, previous, cancellable, check);
            }
        } catch (error) {
            if (generation === this._generation && !cancellable.is_cancelled())
                this._log.error(`player start failed: ${error.message}`);
        } finally {
            if (this._cancellable === cancellable)
                this._cancellable = null;
        }
    }

    async _startTarget(target, previous, cancellable, check) {
        const record = {logicalMonitorKey: target.logicalMonitorKey, selectionKey: target.selectionKey,
            selectedPhysicalMonitorId: target.selectedPhysicalMonitorId, asset: null, publishedPath: null,
            process: null, ipc: null, layer: null, staticShown: false, reaped: null,
            state: PlayerState.STARTING, released: false};
        this._pending.add(record);
        try {
            await this._prepare(record, target, cancellable, check);
            await this._handOff(record, previous, target, cancellable, check);
            await this._launch(record, cancellable, check);
        } catch (error) {
            const pending = this._pending.delete(record);
            if (cancellable.is_cancelled() || record.released) {
                if (pending)
                    this._release(record);
                check();
                return;
            }
            this._log.error(`player start failed for ${record.logicalMonitorKey}: ${error.message}`);
            this._fail(record);
            this._supervise(record, error, this._env.classify?.(error) === 'permanent');
        }
    }

    async _prepare(record, target, cancellable, check) {
        const media = await this._env.probe(target.file, cancellable);
        check();
        const asset = await this._env.acquireAsset(media, target.geometry,
            {optimizedPath: target.optimizedPath ?? null, cancellable});
        if (record.released) {
            this._releaseAsset(asset);
            check();
        }
        record.asset = asset;
        check();
        const still = await this._env.ensureStill(asset, target.geometry, cancellable);
        check();
        record.publishedPath = await this._env.publishWallpaper(still, cancellable);
        check();
        if (target.systemWallpaper) {
            try {
                this._env.applyWallpaper(record.publishedPath);
            } catch (error) {
                this._log.warn(`system wallpaper not applied: ${error.message}`);
            }
        }
    }

    async _handOff(record, previous, target, cancellable, check) {
        if (previous && !previous.released && previous.layer) {
            await previous.layer.prepareStatic(record.publishedPath, {cancellable});
            check();
            previous.layer.showStatic();
            previous.staticShown = true;
            await this._release(previous, {graceMs: this._graceMs, keepLayer: true});
            check();
        }
        record.layer = this._env.createLayer(target);
        await record.layer.prepareStatic(record.publishedPath, {cancellable});
        check();
        record.staticShown = true;
        if (previous) {
            previous.layer?.destroy();
            previous.state = PlayerState.STOPPED;
        }
        this._pending.delete(record);
        this._players.set(record.logicalMonitorKey, record);
        this._reasonsFor(record.logicalMonitorKey).add(STARTUP);
    }

    async _launch(record, cancellable, check) {
        const timeoutMs = this._timeoutMs;
        const socketPath = await this._env.prepareSocket({cancellable});
        try {
            check();
        } catch (error) {
            this._env.releaseSocket(socketPath);
            throw error;
        }
        const live = this._live.get(record.logicalMonitorKey);
        if (live) {
            this._env.releaseSocket(socketPath);
            throw new Error(`refusing a second live player for ${record.logicalMonitorKey}`);
        }
        record.process = this._env.createProcess({socketPath});
        this._live.set(record.logicalMonitorKey, record.process);
        const discovery = record.layer.watchWindow(record.process, {timeoutMs, cancellable});
        discovery.catch(() => {});
        record.process.onExit(result => this._exited(record, result));
        record.process.start();
        this._log.debug(`player spawned for ${record.logicalMonitorKey} at ${now()} ms`);
        record.ipc = this._env.createIpc(socketPath);
        await record.ipc.connect({timeoutMs, cancellable});
        check();
        for (const args of fitCommands(record.asset.geometry.fitMode, record.asset.geometryBaked))
            await record.ipc.command(args, {cancellable});
        check();
        const assetIdentity = record.asset.identity;
        await record.ipc.command(['loadfile', record.asset.path], {cancellable, assetIdentity});
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
        this._log.debug(`fade-in done for ${record.logicalMonitorKey} at ${now()} ms`);
        const health = this._healthFor(record.logicalMonitorKey);
        this._clearTimer(health, 'healthyTimer');
        health.healthyTimer = this._timeout(this._healthyMs, () => {
            health.healthyTimer = 0;
            if (!record.released)
                health.failures = [];
        });
        record.state = PlayerState.PAUSED;
        this.setPaused(record.logicalMonitorKey, STARTUP, false);
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
        this._supervise(record, new Error(`The video player stopped unexpectedly (status ${status})`), false);
    }

    _healthFor(logicalMonitorKey) {
        let health = this._health.get(logicalMonitorKey);
        if (!health) {
            health = {failures: [], blocked: null, notified: false, retryTimer: 0, healthyTimer: 0};
            this._health.set(logicalMonitorKey, health);
        }
        return health;
    }

    _supervise(record, error, permanent) {
        const key = record.logicalMonitorKey;
        const health = this._healthFor(key);
        this._clearTimer(health, 'healthyTimer');
        this._clearTimer(health, 'retryTimer');
        if (health.blocked !== null)
            return;
        const time = now();
        health.failures = health.failures.filter(at => time - at < this._failureWindowMs);
        health.failures.push(time);
        const maxRetries = this._env.maxRetries?.() ?? BACKOFF_MS.length;
        if (permanent || health.failures.length >= maxRetries) {
            health.blocked = record.selectionKey;
            this._log.warn(`giving up on ${key} after ${health.failures.length} failure(s); keeping the still`);
            if (!health.notified) {
                health.notified = true;
                this._env.notify?.(key, error.message);
            }
            return;
        }
        const delay = this._backoffMs[Math.min(health.failures.length, this._backoffMs.length) - 1];
        this._log.info(`retrying ${key} in ${delay} ms`);
        health.retryTimer = this._timeout(delay, () => {
            health.retryTimer = 0;
            this._schedule(false).catch(retryError => this._log.error(`retry failed: ${retryError.message}`));
        });
    }

    _timeout(ms, callback) {
        const generation = this._generation;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            if (generation === this._generation)
                callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    _clearTimer(health, name) {
        if (health[name]) {
            GLib.source_remove(health[name]);
            this._timers.delete(health[name]);
            health[name] = 0;
        }
    }

    // The still stays on screen; supervision and retries belong to T16.
    _fail(record) {
        const keepStill = record.staticShown && record.layer;
        if (keepStill) {
            try {
                record.layer.showStatic();
            } catch (error) {
                this._log.warn(`still not shown after failure: ${error.message}`);
            }
        }
        this._release(record, {keepLayer: keepStill});
        record.state = PlayerState.FAILED;
    }

    _release(record, {graceMs = 0, keepLayer = false} = {}) {
        if (record.released)
            return record.reaped;
        record.released = true;
        if (!keepLayer)
            record.layer?.destroy();
        const closing = record.ipc ? Promise.resolve(record.ipc.close()) : null;
        let reap = Promise.resolve();
        if (record.process) {
            if (graceMs === 0)
                record.process.terminateNow();
            reap = Promise.all([record.process.stop({graceMs}), closing]);
        }
        const process = record.process;
        record.reaped = trackReap(reap.catch(() => {}).then(() => {
            if (process && this._live.get(record.logicalMonitorKey) === process)
                this._live.delete(record.logicalMonitorKey);
            const asset = record.asset;
            record.asset = null;
            this._releaseAsset(asset);
        }));
        return record.reaped;
    }

    _releaseAsset(asset) {
        if (!asset)
            return;
        Promise.resolve(this._env.releaseAsset(asset)).catch(error =>
            this._log.warn(`asset release failed: ${error.message}`));
    }
}
