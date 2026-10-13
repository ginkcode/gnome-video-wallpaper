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
const PICTURE_OPTIONS = {fill: 'zoom', fit: 'scaled', stretch: 'stretched'};

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
        this._retiring = new Set();
        this._reasons = new Map();
        this._wallpaperKey = null;
        this._decoderChecked = false;
        this._targets = [];
        this._targetListeners = new Set();
        this._pauseListeners = new Set();
    }

    get started() {
        return this._started;
    }

    get targets() {
        return this._targets;
    }

    onTargets(callback) {
        this._targetListeners.add(callback);
        return () => this._targetListeners.delete(callback);
    }

    pauseReasons() {
        const reasons = new Set();
        for (const {logicalMonitorKey: key} of this._targets) {
            for (const reason of this._reasons.get(key) ?? [])
                reasons.add(reason);
        }
        return reasons;
    }

    onPauseChanged(callback) {
        this._pauseListeners.add(callback);
        return () => this._pauseListeners.delete(callback);
    }

    ownsWindow(window) {
        return [...this._live.values()].some(process => process.ownsWindow?.(window));
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
        for (const record of this._retiring) {
            record.layer?.destroy();
            record.process?.terminateNow();
            record.state = PlayerState.STOPPED;
        }
        this._players.clear();
        this._pending.clear();
        this._retiring.clear();
        this._reasons.clear();
        this._wallpaperKey = null;
        this._targets = [];
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        this._health.clear();
        this._env.onStop?.({restore});
        this._notify(this._pauseListeners, 'pause');
    }

    setPaused(logicalMonitorKey, reason, paused) {
        if (typeof logicalMonitorKey !== 'string' || !logicalMonitorKey ||
            typeof reason !== 'string' || !reason)
            throw new Error('setPaused requires a logical monitor key and reason');
        const reasons = this._reasonsFor(logicalMonitorKey);
        if (reasons.has(reason) !== paused) {
            if (paused)
                reasons.add(reason);
            else
                reasons.delete(reason);
            this._notify(this._pauseListeners, 'pause');
        }
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
        const preparation = new Set();
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
            this._publishTargets(targets);
            const keys = new Set(targets.map(target => target.logicalMonitorKey));
            const removed = [...this._players.values()].filter(old => !keys.has(old.logicalMonitorKey));
            const prepared = new Map();
            for (const target of targets) {
                const previous = this._players.get(target.logicalMonitorKey) ?? null;
                if (previous && !previous.released && previous.selectionKey === target.selectionKey)
                    continue;
                const health = this._healthFor(target.logicalMonitorKey);
                if (health.blocked === target.selectionKey)
                    continue;
                if (health.blocked !== null)
                    this._health.delete(target.logicalMonitorKey);
                const record = this._record(target);
                preparation.add(record);
                this._pending.add(record);
                try {
                    await this._prepare(record, target, cancellable, check);
                    prepared.set(target.logicalMonitorKey, record);
                } catch (error) {
                    this._pending.delete(record);
                    this._release(record);
                    check();
                    this._log.error(`player preparation failed for ${record.logicalMonitorKey}: ${error.message}`);
                    this._supervise(record, error, this._env.classify?.(error) === 'permanent');
                }
            }
            await this._applySystemWallpaper(targets, prepared, cancellable, check);
            await this._retire(removed, targets.length === 0, cancellable, check);
            if (targets.length === 0)
                this._log.info('no wallpaper configured');
            let started = 0;
            for (const target of targets) {
                const record = prepared.get(target.logicalMonitorKey);
                if (!record)
                    continue;
                if (started++ > 0) {
                    await sleep(this._env.staggerMs?.() ?? 0, cancellable);
                    check();
                }
                await this._startTarget(target, this._players.get(target.logicalMonitorKey) ?? null,
                    cancellable, check, record);
            }
        } catch (error) {
            if (generation === this._generation && !cancellable.is_cancelled())
                this._log.error(`player start failed: ${error.message}`);
        } finally {
            for (const record of preparation) {
                if (this._pending.delete(record))
                    this._release(record);
            }
            if (this._cancellable === cancellable)
                this._cancellable = null;
        }
    }

    async _retire(records, restore, cancellable, check) {
        for (const record of records) {
            this._players.delete(record.logicalMonitorKey);
            this._retiring.add(record);
            const health = this._health.get(record.logicalMonitorKey);
            if (health) {
                this._clearTimer(health, 'retryTimer');
                this._clearTimer(health, 'healthyTimer');
                this._health.delete(record.logicalMonitorKey);
            }
            if (record.staticShown && record.layer && record.state !== PlayerState.FAILED) {
                try {
                    record.layer.showStatic();
                } catch (error) {
                    this._log.warn(`still not shown before removal: ${error.message}`);
                }
            }
        }
        await Promise.all(records.map(record => this._release(record, {graceMs: this._graceMs, keepLayer: true})));
        check();
        if (restore) {
            const settleMs = this._env.restoreWallpaper?.() ?? 0;
            if (records.length > 0 && settleMs > 0) {
                await sleep(settleMs, cancellable);
                check();
            }
        }
        for (const record of records) {
            record.layer?.destroy();
            record.state = PlayerState.STOPPED;
            this._retiring.delete(record);
        }
    }

    _record(target) {
        return {logicalMonitorKey: target.logicalMonitorKey, selectionKey: target.selectionKey, vo: target.vo,
            selectedPhysicalMonitorId: target.selectedPhysicalMonitorId, media: null, asset: null, publishedPath: null,
            process: null, ipc: null, layer: null, staticShown: false, reaped: null,
            state: PlayerState.STARTING, released: false};
    }

    async _startTarget(target, previous, cancellable, check, record) {
        this._pending.add(record);
        try {
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
        record.media = media;
        const asset = await this._env.acquireAsset(media, target.geometry,
            {optimize: target.optimize === true, cancellable});
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
    }

    async _applySystemWallpaper(targets, prepared, cancellable, check) {
        const primary = this._env.primaryMonitorIndex?.();
        const target = targets.find(candidate => candidate.monitorIndex === primary) ?? targets[0];
        const record = target && (prepared.get(target.logicalMonitorKey) ??
            this._players.get(target.logicalMonitorKey));
        if (!record?.publishedPath)
            return;
        const options = PICTURE_OPTIONS[target.geometry.fitMode] ?? 'zoom';
        const media = record.media;
        const key = JSON.stringify([record.logicalMonitorKey, record.publishedPath, options,
            media && [media.path, media.size, media.mtime]]);
        if (key === this._wallpaperKey)
            return;
        try {
            let path = record.publishedPath;
            if (media && this._env.nativeStill) {
                const still = await this._env.nativeStill(media, cancellable);
                check();
                path = await this._env.publishWallpaper(still, cancellable);
                check();
            }
            this._env.applyWallpaper(path, options);
            this._wallpaperKey = key;
        } catch (error) {
            check();
            this._log.warn(`system wallpaper not applied: ${error.message}`);
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
        record.process = this._env.createProcess({socketPath, vo: record.vo});
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
        const painted = discovery.then(async window => {
            check();
            record.layer.attach(window);
            await this._env.waitForPaintable?.({cancellable});
            check();
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
        this._checkDecoder(record);
    }

    _checkDecoder(record) {
        if (this._decoderChecked || !this._env.softwareDecoding)
            return;
        record.ipc.command(['get_property', 'hwdec-current']).then(hwdec => {
            if (this._decoderChecked)
                return;
            this._decoderChecked = true;
            if (hwdec && hwdec !== 'no')
                return;
            this._log.warn(`hardware decoding unavailable for ${record.logicalMonitorKey}`);
            this._env.softwareDecoding(record.logicalMonitorKey);
        }).catch(error => this._log.debug(`decoder check failed: ${error.message}`));
    }

    _publishTargets(targets) {
        this._targets = targets;
        this._notify(this._targetListeners, 'target', targets);
        this._notify(this._pauseListeners, 'pause');
    }

    _notify(listeners, kind, ...args) {
        for (const listener of [...listeners]) {
            try {
                listener(...args);
            } catch (error) {
                this._log.error(`${kind} listener failed: ${error.message}`);
            }
        }
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
            return this._releaseAsset(asset);
        }));
        return record.reaped;
    }

    _releaseAsset(asset) {
        if (!asset)
            return;
        return Promise.resolve(this._env.releaseAsset(asset)).catch(error =>
            this._log.warn(`asset release failed: ${error.message}`));
    }
}
