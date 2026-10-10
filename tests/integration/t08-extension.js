import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PlayerProcess, preparePlayerSocket} from './lib/playerProcess.js';
import {buildMpvArgv} from './lib/mpvArgs.js';
import {MpvIpc} from './lib/mpvIpc.js';
import {BackgroundLayer} from './lib/backgroundLayer.js';
import {startRecording, stopRecording} from './t08-capture.js';
import {verifyConsumers} from './t08-consumers.js';

function report(event, details = {}) {
    console.log(`T08_RESULT ${JSON.stringify({event, ...details})}`);
}

function delay(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level =>
    [level, (...args) => report(level, {message: args.join(' ')})]));

async function waitFor(predicate, ms = 3000) {
    const deadline = GLib.get_monotonic_time() + ms * 1000;
    do {
        const result = predicate();
        if (result)
            return result;
        await delay(50);
    } while (GLib.get_monotonic_time() < deadline);
    return null;
}

export default class T08Fixture extends Extension {
    enable() {
        this._actors = [];
        this._signals = [];
        this._players = [];
        this._ipcs = [];
        this._layers = [];
        this._restoreBackgroundLoad = null;
        this._restoreDockFilter = null;
        this._restoreIconClick = null;
        this._control = null;
        this._run().catch(error => {
            this._restoreBackgroundLoad?.();
            for (const layer of this._layers)
                layer.destroy();
            report('fail', {message: error.message, stack: error.stack});
            for (const player of this._players)
                player.terminateNow();
            global.context.terminate();
        });
    }

    disable() {
        if (this._heartbeatId) {
            GLib.source_remove(this._heartbeatId);
            this._heartbeatId = 0;
        }
        for (const [object, id] of this._signals)
            object.disconnect(id);
        for (const actor of this._actors)
            actor.destroy();
        for (const ipc of this._ipcs)
            ipc.close();
        this._restoreBackgroundLoad?.();
        for (const layer of this._layers)
            layer.destroy();
        for (const player of this._players)
            player.terminateNow();
        this._control?.force_exit();
    }

    async _controlWindow() {
        this._control = Gio.Subprocess.new(['zenity', '--info', '--text', 'T08 control window',
            '--no-wrap'], Gio.SubprocessFlags.NONE);
        report('control-spawn', {pid: Number(this._control.get_identifier())});
        const deadline = GLib.get_monotonic_time() + 5000000;
        let control = null;
        while (!control && GLib.get_monotonic_time() < deadline) {
            control = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
                .find(candidate => candidate.get_pid() === Number(this._control.get_identifier()));
            if (!control)
                await delay(100);
        }
        if (!control)
            throw new Error('Control window did not appear in the tab list');
        return control;
    }

    async _capture(name) {
        const shot = new Shell.Screenshot();
        const path = `${GLib.getenv('T08_OUTPUT')}/${name}.png`;
        const [content, scale] = await shot.screenshot_stage_to_content();
        const stream = Gio.MemoryOutputStream.new_resizable();
        await Shell.Screenshot.composite_to_stream(content.get_texture(),
            0, 0, -1, -1, scale, null, 0, 0, 1, stream);
        stream.close(null);
        await new Promise((resolve, reject) => Gio.File.new_for_path(path).replace_contents_bytes_async(
            stream.steal_as_bytes(), null, false, Gio.FileCreateFlags.NONE, null, (file, result) => {
                try {
                    file.replace_contents_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            }));
        report('capture', {name, monotonicUs: GLib.get_monotonic_time()});
    }

    async _delayedBackground(layer) {
        const manager = Main.layoutManager._bgManagers[0];
        const prototype = Object.getPrototypeOf(manager.backgroundActor.content.background);
        const original = prototype._loadFile;
        const target = Gio.File.new_for_path(GLib.getenv('T08_STILL'));
        let release;
        let intercepted = false;
        let loaded = false;
        const gate = new Promise(resolve => {
            release = resolve;
        });
        prototype._loadFile = async function (file) {
            if (file.equal(target)) {
                intercepted = true;
                report('system-load-held');
                await gate;
            }
            if (!this._cancellable.is_cancelled())
                return original.call(this, file);
            return undefined;
        };
        this._restoreBackgroundLoad = () => {
            prototype._loadFile = original;
            release();
            this._restoreBackgroundLoad = null;
        };
        try {
            const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
            settings.set_string('picture-uri', target.get_uri());
            settings.set_string('picture-uri-dark', target.get_uri());
            const deadline = GLib.get_monotonic_time() + 2000000;
            while (!intercepted && GLib.get_monotonic_time() < deadline)
                await delay(10);
            if (!intercepted || !manager._newBackgroundActor)
                throw new Error('system background loading was not intercepted');
            const pending = manager._newBackgroundActor.content.background;
            const id = pending.connect('loaded', () => {
                loaded = true;
            });
            try {
                const clone = layer._clone;
                const originalSetSource = clone.set_source.bind(clone);
                let ordering = false;
                clone.set_source = source => {
                    ordering = layer._static.opacity === 255 &&
                        layer._static.content === layer._preparedImage;
                    originalSetSource(source);
                };
                layer.showStatic();
                if (!ordering || layer._clone || pending.isLoaded)
                    throw new Error('still handoff ordering or delayed load failed');
                await this._capture('handoff-transition');
                for (let sample = 0; sample < 5; sample++) {
                    await delay(200);
                    if (pending.isLoaded || loaded)
                        throw new Error('system background loaded before gate release');
                    await this._capture(`handoff-delay-${sample}`);
                }
                report('handoff-held', {ordering, loaded, isLoaded: pending.isLoaded});
                release();
                const loadDeadline = GLib.get_monotonic_time() + 5000000;
                while (!loaded && GLib.get_monotonic_time() < loadDeadline)
                    await delay(10);
                if (!loaded)
                    throw new Error('system background did not load after release');
                await this._capture('handoff-loaded');
                await delay(1200);
                report('handoff-complete', {loaded, retained: layer._static.opacity === 255});
            } finally {
                pending.disconnect(id);
            }
        } finally {
            this._restoreBackgroundLoad();
        }
    }

    async _layerCycle(cycle, baseline) {
        const socketPath = await preparePlayerSocket();
        const player = new PlayerProcess({argv: buildMpvArgv({mpvPath: '/usr/bin/mpv', socketPath,
            vo: 'wlshm', hwdec: 'no'}), socketPath, logger});
        this._players.push(player);
        const layer = new BackgroundLayer({monitorIndex: 0, logger});
        this._layers.push(layer);
        const discovery = layer.watchWindow(player, {timeoutMs: 5000});
        await layer.prepareStatic(GLib.getenv('T08_STILL'));
        player.start();
        report('spawn', {pid: player.pid});
        const ipc = new MpvIpc(socketPath, logger);
        this._ipcs.push(ipc);
        await ipc.connect({timeoutMs: 5000});
        await ipc.command(['loadfile', GLib.getenv('T08_ASSET')], {assetIdentity: `cycle-${cycle}`});
        await ipc.waitForContent({assetIdentity: `cycle-${cycle}`, timeoutMs: 10000});
        const window = await discovery;
        layer.attach(window);
        await layer.waitForFirstFrame({timeoutMs: 5000});
        await layer.fadeIn(100);
        await delay(50);
        if (cycle === 0)
            await this._capture('layer-video');
        if (cycle === 0)
            await this._delayedBackground(layer);
        else
            layer.showStatic();
        await delay(50);
        if (cycle === 0)
            await this._capture('layer-static');
        layer.destroy();
        report('cycle', {cycle, children: Main.layoutManager._backgroundGroup.get_n_children(), baseline});
        if (Main.layoutManager._backgroundGroup.get_n_children() !== baseline)
            throw new Error(`cycle ${cycle} leaked background children`);
        await ipc.close();
        await player.stop({graceMs: 100});
    }

    async _run() {
        report('fixture', {shellPid: 0});
        await delay(1800);
        Main.overview.hide();
        await delay(800);
        report('api', {hide: typeof Meta.Window.prototype.hide_from_window_list,
            below: typeof Meta.Window.prototype.make_below, type: typeof Meta.Window.prototype.set_type});
        const baseline = Main.layoutManager._backgroundGroup.get_n_children();
        const socketPath = await preparePlayerSocket();
        const player = new PlayerProcess({argv: buildMpvArgv({mpvPath: '/usr/bin/mpv', socketPath,
            vo: 'wlshm', hwdec: 'no'}), socketPath, logger});
        this._players.push(player);
        const layer = new BackgroundLayer({monitorIndex: 0, logger});
        this._layers.push(layer);
        const discovery = layer.watchWindow(player, {timeoutMs: 30000});
        discovery.catch(() => {});
        const id = global.display.connect('window-created', (_display, candidate) => {
            if (!player.ownsWindow(candidate))
                return;
            const source = candidate.get_compositor_private();
            report('discovery', {actor: Boolean(source), opacity: source?.opacity,
                mapped: source?.mapped, monotonicUs: GLib.get_monotonic_time()});
            if (source) {
                this._signals.push([source, source.connect('first-frame', () => {
                    report('first-frame', {opacity: source.opacity, mapped: source.mapped,
                        monotonicUs: GLib.get_monotonic_time()});
                })]);
            }
        });
        this._signals.push([global.display, id]);
        let recording = null;
        let heartbeat = null;
        try {
            heartbeat = new St.Widget({width: 16, height: 16, x: 1000, y: 0,
                reactive: false, style: 'background-color: #ff0000;'});
            global.stage.add_child(heartbeat);
            this._actors.push(heartbeat);
            this._heartbeatId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8, () => {
                heartbeat.opacity = heartbeat.opacity === 255 ? 128 : 255;
                return GLib.SOURCE_CONTINUE;
            });
        } catch (error) {
            report('heartbeat-blocked', {message: error.message});
        }
        try {
            recording = await startRecording('map-flash');
            report('recording-started', {filename: recording.filename, monotonicUs: recording.startedUs});
        } catch (error) {
            report('capture-blocked', {message: error.message});
        }
        player.start();
        report('spawn', {pid: player.pid});
        const ipc = new MpvIpc(socketPath, logger);
        this._ipcs.push(ipc);
        await ipc.connect({timeoutMs: 5000});
        await delay(700);
        report('idle', {window: Boolean(layer._window)});
        await ipc.command(['loadfile', GLib.getenv('T08_ASSET')], {assetIdentity: 'selected-green'});
        await ipc.waitForContent({assetIdentity: 'selected-green', timeoutMs: 10000});
        const window = await discovery;
        const actor = window.get_compositor_private();
        await layer.waitForFirstFrame({timeoutMs: 10000});
        report('readiness', {firstFrame: true, focused: window === global.display.focus_window,
            skipTaskbar: window.skip_taskbar, mapped: actor.mapped, minimized: window.minimized,
            hidden: window.is_hidden(), unsetFocus: typeof global.display.unset_input_focus,
            monotonicUs: GLib.get_monotonic_time()});
        const rect = window.get_frame_rect();
        report('window-rect', {x: rect.x, y: rect.y, width: rect.width, height: rect.height});
        if (typeof global.display.unset_input_focus === 'function')
            global.display.unset_input_focus(global.get_current_time());
        await this._capture('before-clone');
        report('clone-reveal', {monotonicUs: GLib.get_monotonic_time()});
        layer.attach(window);
        await layer.fadeIn(0);
        await delay(300);
        await this._capture('transparent-source-clone');
        await delay(300);
        await this._capture('settled-source-clone');
        if (recording) {
            try {
                await stopRecording();
                report('recording-stopped', {monotonicUs: GLib.get_monotonic_time()});
            } catch (error) {
                report('capture-stop-failed', {message: error.message});
            }
        }
        if (this._heartbeatId) {
            GLib.source_remove(this._heartbeatId);
            this._heartbeatId = 0;
        }
        if (GLib.getenv('T08_PRIVATE_NESTED') === '1') {
            try {
                await this._controlWindow();
                const consumerReports = await verifyConsumers(window, name => this._capture(name));
                report('consumers', {reports: consumerReports});
            } catch (error) {
                report('consumers-failed', {message: error.message, reports: error.reports ?? []});
            } finally {
                const controlPid = Number(this._control?.get_identifier());
                this._control?.force_exit();
                this._control = null;
                await waitFor(() => !global.get_window_actors().some(actor =>
                    actor.meta_window.get_pid() === controlPid), 3000);
                report('control-closed', {pid: controlPid});
            }
        } else {
            report('consumers-skipped', {reason: 'T08_PRIVATE_NESTED not set'});
        }
        Main.overview.show();
        await delay(600);
        await this._capture('overview');
        report('overview-exclusion', {tabList: global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .includes(window)});
        Main.overview.hide();
        await delay(600);
        report('clone', {mapped: layer._clone?.mapped, opacity: layer._clone?.opacity,
            sourceMapped: actor.mapped, focused: window === global.display.focus_window,
            minimized: window.minimized, hidden: window.is_hidden()});
        layer.destroy();
        report('baseline', {before: baseline, after: Main.layoutManager._backgroundGroup.get_n_children()});
        await ipc.close();
        await player.stop({graceMs: 100});
        for (let cycle = 0; cycle < 10; cycle++)
            await this._layerCycle(cycle, baseline);
        report('complete');
        global.context.terminate();
    }
}
