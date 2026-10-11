import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TARGET = 'gink-video-wallpaper@ginkcode.github.io';
const COVERAGE_REASON = 't10-coverage';
const SAMPLE_MS = 5000;
const STARTUP_MS = 30000;
const REAP_MS = 8000;

function monotonicUs() {
    return GLib.get_monotonic_time();
}

function report(event, details = {}) {
    console.log(`T10_RESULT ${JSON.stringify({event, monotonicUs: monotonicUs(), ...details})}`);
}

function delay(ms, cancellable = null) {
    return new Promise((resolve, reject) => {
        if (cancellable?.is_cancelled()) {
            reject(cancelled());
            return;
        }
        let handler = 0;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (handler)
                cancellable.disconnect(handler);
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        if (cancellable)
            handler = cancellable.connect(() => {
                GLib.source_remove(id);
                reject(cancelled());
            });
    });
}

function cancelled() {
    return new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'T10 operation cancelled');
}

async function waitFor(predicate, ms, cancellable = null) {
    const deadline = monotonicUs() + ms * 1000;
    do {
        cancellable?.set_error_if_cancelled();
        const result = await predicate();
        if (result)
            return result;
        await delay(50, cancellable);
    } while (monotonicUs() < deadline);
    return null;
}

function extension() {
    return Main.extensionManager.lookup(TARGET);
}

function manager() {
    return extension()?.stateObj?._manager ?? null;
}

function record() {
    return manager()?._players.values().next().value ?? null;
}

function outputDir() {
    const path = GLib.getenv('T10_OUTPUT');
    if (!path || !GLib.path_is_absolute(path))
        throw new Error('T10_OUTPUT must be an absolute directory');
    return path;
}

function phaseSeconds() {
    const seconds = Number(GLib.getenv('T10_SECONDS') ?? 60);
    if (!Number.isFinite(seconds) || seconds <= 0)
        throw new Error('T10_SECONDS must be a positive number');
    return seconds;
}

async function listSockets() {
    const dir = Gio.File.new_for_path(`${GLib.getenv('XDG_RUNTIME_DIR')}/gink-video-wallpaper`);
    const enumerator = await new Promise((resolve, reject) => dir.enumerate_children_async('standard::name',
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (file, result) => {
            try {
                resolve(file.enumerate_children_finish(result));
            } catch (error) {
                if (error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND))
                    resolve(null);
                else
                    reject(error);
            }
        }));
    if (!enumerator)
        return [];
    const names = [];
    try {
        while (true) {
            const batch = await new Promise((resolve, reject) => enumerator.next_files_async(32,
                GLib.PRIORITY_DEFAULT, null, (object, result) => {
                    try {
                        resolve(object.next_files_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                }));
            if (!batch.length)
                break;
            names.push(...batch.map(info => info.get_name()));
        }
    } finally {
        await new Promise((resolve, reject) => enumerator.close_async(GLib.PRIORITY_DEFAULT, null,
            (object, result) => {
                try {
                    object.close_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            }));
    }
    return names;
}

function windowForPid(pid) {
    return global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
        .find(candidate => candidate.get_pid() === pid) ?? null;
}

function rectOf(window) {
    const rect = window.get_frame_rect();
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}

function advance(first, second, duration, elapsed) {
    if (![first, second, duration, elapsed].every(Number.isFinite) || duration <= 0)
        return NaN;
    let delta = second - first;
    if (delta < 0)
        delta += duration;
    if (elapsed > duration)
        delta += Math.max(0, Math.round((elapsed - delta) / duration)) * duration;
    return delta;
}

function socketOf(process) {
    return process?._argv?.find(arg => arg.startsWith('--input-ipc-server='))?.slice('--input-ipc-server='.length) ?? null;
}

function covers(inner, outer) {
    return inner.x >= outer.x && inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height;
}

export default class T10Probe extends Extension {
    enable() {
        this._control = null;
        this._cancellable = new Gio.Cancellable();
        this._restore = [];
        this._baseline = null;
        this._playerPid = null;
        this._socket = null;
        this._readiness = {};
        this._run().catch(async error => {
            report('fail', {message: error.message, stack: error.stack});
            try {
                await this._audit(this._baseline, this._playerPid, this._socket);
            } catch (cleanupError) {
                report('audit-failed', {message: cleanupError.message});
            } finally {
                this._cleanup();
                global.context.terminate();
            }
        });
    }

    disable() {
        this._cancellable?.cancel();
        this._cleanup();
    }

    _cleanup() {
        for (const restore of this._restore.splice(0))
            restore();
        try {
            if (extension()?.state === 1)
                Main.extensionManager.disableExtension(TARGET);
        } catch (error) {
            report('cleanup-failed', {step: 'disable', message: error.message});
        }
        try {
            this._control?.force_exit();
        } catch (error) {
            report('cleanup-failed', {step: 'control', message: error.message});
        }
        this._control = null;
    }

    _instrument() {
        const dir = extension()?.dir;
        if (!dir)
            throw new Error('target extension is not loaded');
        return Promise.all([
            import(dir.get_child('lib/mpvIpc.js').get_uri()),
            import(dir.get_child('lib/backgroundLayer.js').get_uri()),
        ]).then(([ipcModule, layerModule]) => {
            this._wrap(ipcModule.MpvIpc.prototype, 'waitForContent', async (original, args) => {
                const started = monotonicUs();
                const value = await original(...args);
                const current = record();
                report('content-ready', {elapsedUs: monotonicUs() - started,
                    requestedIdentity: args[0]?.assetIdentity ?? null,
                    identity: current?.asset?.identity ?? null});
                this._readiness.contentReadyUs = monotonicUs() - started;
                const reconciled = await this._reconciled(current);
                this._readiness.content = reconciled;
                report('content-reconciled', {reconciled});
                return value;
            });
            this._wrap(layerModule.BackgroundLayer.prototype, 'waitForFirstFrame', async (original, args) => {
                const started = monotonicUs();
                const value = await original(...args);
                const current = record();
                report('first-frame-ready', {elapsedUs: monotonicUs() - started,
                    identity: current?.asset?.identity ?? null});
                this._readiness.firstFrameReadyUs = monotonicUs() - started;
                const frameReconciled = await this._reconciled(current);
                this._readiness.frame = frameReconciled;
                report('first-frame-reconciled', {reconciled: frameReconciled});
                return value;
            });
        });
    }

    _wrap(prototype, name, around) {
        const original = prototype[name];
        prototype[name] = function (...args) {
            return around(original.bind(this), args);
        };
        this._restore.push(() => {
            prototype[name] = original;
        });
    }

    async _reconciled(current) {
        const names = ['pause', 'path', 'playlist', 'idle-active', 'vo-configured', 'video-out-params'];
        const values = await Promise.all(names.map(name => this._property(name)));
        const properties = Object.fromEntries(names.map((name, index) => [name, values[index]]));
        const load = current?.ipc?._load;
        const entryId = properties.playlist?.find(entry => entry.current)?.id;
        return {properties, state: current?.state ?? null,
            loadReady: load?.ready ?? null, loadIdentity: load?.identity ?? null,
            entryId, expectedEntryId: load?.entryId ?? null,
            identityMatches: load?.identity === current?.asset?.identity,
            paused: properties.pause, pathMatches: properties.path === current?.asset?.path};
    }

    async _property(name) {
        const current = record();
        if (!current?.ipc)
            throw new Error(`no player IPC for ${name}`);
        const cancellable = new Gio.Cancellable();
        const parent = this._cancellable;
        parent.set_error_if_cancelled();
        const handler = parent.connect(() => cancellable.cancel());
        let timer = 0;
        const timeout = new Promise((_resolve, reject) => {
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                timer = 0;
                reject(new Error(`IPC property ${name} timed out`));
                cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });
        });
        try {
            return await Promise.race([
                current.ipc.command(['get_property', name], {cancellable}), timeout,
            ]);
        } finally {
            parent.disconnect(handler);
            if (timer)
                GLib.source_remove(timer);
        }
    }

    async _sample(phase, elapsedUs = 0) {
        const names = ['time-pos', 'pause', 'duration', 'current-vo', 'hwdec-current',
            'video-codec', 'frame-drop-count', 'vo-delayed-frame-count'];
        const values = await Promise.all(names.map(name => this._property(name).catch(() => null)));
        const [timePos, pause, duration, vo, hwdec, videoCodec, dropped, delayed] = values;
        report('sample', {phase, elapsedUs, elapsedSec: elapsedUs / 1000000,
            timePos, pause, duration, vo, hwdec, videoCodec,
            dropped, delayed, state: record()?.state ?? null});
        return {timePos, pause, duration, monotonicUs: monotonicUs()};
    }

    async _capture(name) {
        const timePosBefore = await this._property('time-pos');
        const startedUs = monotonicUs();
        const shot = new Shell.Screenshot();
        const [content, scale] = await shot.screenshot_stage_to_content();
        const capturedUs = monotonicUs();
        const timePosAfter = await this._property('time-pos');
        const stream = Gio.MemoryOutputStream.new_resizable();
        await Shell.Screenshot.composite_to_stream(content.get_texture(),
            0, 0, -1, -1, scale, null, 0, 0, 1, stream);
        stream.close(null);
        const path = `${outputDir()}/${name}.png`;
        await new Promise((resolve, reject) => Gio.File.new_for_path(path).replace_contents_bytes_async(
            stream.steal_as_bytes(), null, false, Gio.FileCreateFlags.NONE, null, (file, result) => {
                try {
                    file.replace_contents_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            }));
        report('capture', {name, path, timePos: timePosBefore,
            timePosBefore, timePosAfter, startedUs, capturedUs});
        return timePosBefore;
    }

    async _phase(name, seconds) {
        const phaseStartUs = monotonicUs();
        report('phase-start', {phase: name, seconds});
        const before = await this._capture(`${name}-a`);
        const samples = [];
        const intervals = Math.max(1, Math.floor(seconds * 1000 / SAMPLE_MS));
        let previous = await this._sample(name, monotonicUs() - phaseStartUs);
        samples.push(previous);
        for (let index = 0; index < intervals; index++) {
            await delay(SAMPLE_MS, this._cancellable);
            const current = await this._sample(name, monotonicUs() - phaseStartUs);
            samples.push(current);
            if (name !== 'covered-paused') {
                const intervalElapsed = (current.monotonicUs - previous.monotonicUs) / 1000000;
                const delta = advance(previous.timePos, current.timePos, current.duration, intervalElapsed);
                if (!Number.isFinite(delta) || delta < intervalElapsed * 0.7)
                    throw new Error(`${name} sample interval stalled: advanced ${delta}s in ${intervalElapsed}s`);
            }
            previous = current;
        }
        const after = await this._capture(`${name}-b`);
        const elapsedUs = monotonicUs() - phaseStartUs;
        report('phase-end', {phase: name, samples: samples.length, elapsedUs,
            before, after, advancing: after > before});
        return {before, after, samples, elapsedUs};
    }

    async _controlWindow() {
        if (GLib.getenv('T10_CONTROL_PID'))
            throw new Error('T10_CONTROL_PID is unsupported: the probe owns its zenity process');
        this._control = Gio.Subprocess.new(['zenity', '--text-info', '--title', 't10-coverage',
            '--filename=/dev/null', '--width=640', '--height=480'], Gio.SubprocessFlags.NONE);
        const pid = Number(this._control.get_identifier());
        report('control-spawn', {pid});
        const window = await waitFor(() => windowForPid(pid), 8000, this._cancellable);
        if (!window)
            throw new Error(`coverage window for PID ${pid} did not appear`);
        window.activate(global.get_current_time());
        window.maximize();
        const monitorIndex = Main.layoutManager.primaryIndex;
        window.move_to_monitor(monitorIndex);
        const workArea = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(monitorIndex);
        const covered = await waitFor(() => {
            if (!window.is_maximized?.() && (window.get_maximize_flags?.() !== Meta.MaximizeFlags.BOTH))
                return null;
            const rect = rectOf(window);
            return covers(workArea, rect) ? rect : null;
        }, 4000, this._cancellable);
        if (!covered)
            throw new Error(`PID ${pid} window does not cover the primary monitor`);
        report('coverage', {reason: COVERAGE_REASON, pid, rect: covered, workArea: {x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height},
            containsWorkArea: covers(workArea, covered),
            maximized: window.is_maximized ? window.is_maximized() : window.get_maximize_flags() === Meta.MaximizeFlags.BOTH});
        return window;
    }

    async _audit(baseline, playerPid, socket) {
        const current = record();
        playerPid ??= Number(current?.process?.pid ?? null);
        socket ??= socketOf(current?.process);
        const lifecycle = await import(extension().dir.get_child('lib/playerManagerLifecycle.js').get_uri());
        Main.extensionManager.disableExtension(TARGET);
        const control = this._control;
        const controlPid = Number(control?.get_identifier() ?? 0);
        this._control = null;
        let controlReaped = !control;
        if (control) {
            control.force_exit();
            control.wait_async(null, (process, result) => {
                try {
                    controlReaped = process.wait_finish(result);
                } catch (error) {
                    report('cleanup-failed', {step: 'control-reap', message: error.message});
                }
            });
        }
        const reaped = await waitFor(() => lifecycle.outstandingReapCount() === 0, REAP_MS);
        await delay(300);
        const sockets = await listSockets();
        const children = Main.layoutManager._backgroundGroup.get_n_children();
        const controlGone = await waitFor(() => controlReaped &&
            (!controlPid || !windowForPid(controlPid)), 3000);
        const audit = {reaped: Boolean(reaped), playerPid, socket, sockets,
            children, baseline, controlPid, controlGone: Boolean(controlGone),
            reapedTrue: Boolean(reaped), socketsEmpty: sockets.length === 0,
            childrenBaseline: children === baseline};
        report('audit', audit);
        return audit;
    }

    async _run() {
        const seconds = phaseSeconds();
        const dir = outputDir();
        report('protocol', {output: dir, seconds, sampleMs: SAMPLE_MS,
            control: 'probe spawns zenity and reports its exact PID; T10_CONTROL_PID must be unset'});
        await delay(1800, this._cancellable);
        Main.overview.hide();
        await delay(800, this._cancellable);
        await this._instrument();
        const baseline = Main.layoutManager._backgroundGroup.get_n_children();
        this._baseline = baseline;
        report('baseline', {children: baseline});
        const started = monotonicUs();
        Main.extensionManager.enableExtension(TARGET);
        const playing = await waitFor(() => record()?.state === 'playing' ? record() : null,
            STARTUP_MS, this._cancellable);
        if (!playing)
            throw new Error(`startup exceeded ${STARTUP_MS}ms (state ${record()?.state ?? 'none'})`);
        const socket = socketOf(playing.process);
        const playerPid = Number(playing.process?.pid ?? null);
        this._playerPid = playerPid;
        this._socket = socket;
        report('player', {pid: playerPid, socket,
            identity: playing.asset?.identity ?? null, key: playing.logicalMonitorKey,
            startupUs: monotonicUs() - started, reconciled: await this._reconciled(playing)});

        const preflightStart = monotonicUs();
        const preflightBefore = await this._capture('preflight-a');
        await delay(1300, this._cancellable);
        const preflightAfter = await this._capture('preflight-b');
        const preflightDuration = await this._property('duration');
        const preflightAdvance = advance(preflightBefore, preflightAfter, preflightDuration, 1.3);
        report('preflight', {before: preflightBefore, after: preflightAfter, duration: preflightDuration,
            advance: preflightAdvance, elapsedUs: monotonicUs() - preflightStart});
        if (!Number.isFinite(preflightAdvance) || preflightAdvance < 0.8)
            throw new Error(`preflight stalled: advanced ${preflightAdvance}s in 1.3s`);

        const visible = await this._phase('visible', seconds);
        const window = await this._controlWindow();
        const workArea = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(Main.layoutManager.primaryIndex);
        const covered = await this._phase('covered-unpaused', seconds);
        manager().setPaused(playing.logicalMonitorKey, COVERAGE_REASON, true);
        const paused = await waitFor(async () => await this._property('pause') === true, 3000, this._cancellable);
        if (!paused)
            throw new Error('coverage pause was not applied');
        const held = await this._phase('covered-paused', seconds);

        window.unmaximize();
        const uncovered = await waitFor(() => {
            if (window.is_maximized?.() || window.get_maximize_flags?.() === Meta.MaximizeFlags.BOTH)
                return null;
            const rect = rectOf(window);
            return covers(workArea, rect) ? null : rect;
        }, 4000, this._cancellable);
        if (!uncovered)
            throw new Error('coverage window remained maximized');
        report('uncovered', {rect: uncovered, workArea: {x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height},
            maximized: window.is_maximized ? window.is_maximized() : window.get_maximize_flags() === Meta.MaximizeFlags.BOTH,
            pause: await this._property('pause')});
        manager().setPaused(playing.logicalMonitorKey, COVERAGE_REASON, false);
        const resumed = await waitFor(async () => await this._property('pause') === false, 3000, this._cancellable);
        if (!resumed)
            throw new Error('playback did not resume after uncover');
        const control = this._control;
        const controlPid = Number(control?.get_identifier() ?? 0);
        let controlReaped = false;
        control.force_exit();
        control.wait_async(null, (process, result) => {
            try {
                controlReaped = process.wait_finish(result);
            } catch (error) {
                report('cleanup-failed', {step: 'uncover-control-reap', message: error.message});
            }
        });
        const controlGone = await waitFor(() => controlReaped && !windowForPid(controlPid), 4000, this._cancellable);
        if (!controlGone)
            throw new Error('coverage control did not exit after uncover');
        this._control = null;
        report('control-closed', {pid: controlPid, reaped: controlReaped});
        const resumeBefore = await this._capture('uncovered-a');
        await delay(1300, this._cancellable);
        const resumeAfter = await this._capture('uncovered-b');
        const resumeDuration = await this._property('duration');
        const resumeAdvance = advance(resumeBefore, resumeAfter, resumeDuration, 1.3);
        report('resumed', {before: resumeBefore, after: resumeAfter, duration: resumeDuration,
            advance: resumeAdvance, advancing: resumeAdvance >= 0.8});
        const moving = phase => phase.samples.every(sample => sample.pause === false && Number.isFinite(sample.timePos)) &&
            (phase.after !== phase.before || phase.samples.some(sample => sample.timePos !== phase.samples[0].timePos));
        const ready = this._readiness;
        const checks = {contentReady: ready.content?.paused === true && ready.content?.loadReady === true &&
                ready.content?.identityMatches === true && ready.content?.pathMatches === true &&
                ready.content?.entryId === ready.content?.expectedEntryId,
            firstFrameReady: Number.isFinite(ready.firstFrameReadyUs) && ready.frame?.paused === true,
            visible: moving(visible),
            coveredUnpaused: moving(covered),
            coveredPaused: held.samples.every(sample => sample.pause === true && Number.isFinite(sample.timePos)) &&
                Math.abs(held.after - held.before) < 0.01,
            resumed: Number.isFinite(resumeAdvance) && resumeAdvance >= 0.8};
        report('motion', checks);

        const audit = await this._audit(baseline, playerPid, socket);
        Object.assign(checks, {reaped: audit.reaped, socketsEmpty: audit.socketsEmpty,
            childrenBaseline: audit.childrenBaseline, controlGone: audit.controlGone});
        if (!Object.values(checks).every(Boolean))
            throw new Error(`validation failed: ${JSON.stringify(checks)}`);
        this._cleanup();
        report('complete', {checks});
        global.context.terminate();
    }
}
