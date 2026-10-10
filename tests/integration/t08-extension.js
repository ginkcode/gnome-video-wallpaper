import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PlayerProcess, preparePlayerSocket} from './lib/playerProcess.js';
import {buildMpvArgv} from './lib/mpvArgs.js';
import {MpvIpc} from './lib/mpvIpc.js';
import {BackgroundLayer} from './lib/backgroundLayer.js';

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

export default class T08Fixture extends Extension {
    enable() {
        this._actors = [];
        this._signals = [];
        this._players = [];
        this._ipcs = [];
        this._run().catch(error => {
            report('fail', {message: error.message, stack: error.stack});
            for (const player of this._players)
                player.terminateNow();
            global.context.terminate();
        });
    }

    disable() {
        for (const [object, id] of this._signals)
            object.disconnect(id);
        for (const actor of this._actors)
            actor.destroy();
        for (const ipc of this._ipcs)
            ipc.close();
        for (const player of this._players)
            player.terminateNow();
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
        report('capture', {name});
    }

    async _layerCycle(cycle, baseline) {
        const socketPath = await preparePlayerSocket();
        const player = new PlayerProcess({argv: buildMpvArgv({mpvPath: '/usr/bin/mpv', socketPath,
            vo: 'wlshm', hwdec: 'no'}), socketPath, logger});
        this._players.push(player);
        const layer = new BackgroundLayer({monitorIndex: 0, logger});
        const discovery = layer.watchWindow(player, {timeoutMs: 5000});
        await layer.prepareStatic(GLib.getenv('T08_STILL'));
        player.start();
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
        let window = null;
        let actor = null;
        let firstFrame = false;
        const id = global.display.connect('window-created', (_display, candidate) => {
            if (!player.ownsWindow(candidate))
                return;
            window = candidate;
            actor = window.get_compositor_private();
            report('discovery', {actor: Boolean(actor), opacity: actor?.opacity,
                mapped: actor?.mapped});
            window.hide_from_window_list();
            window.lower();
            window.stick();
            if (!actor)
                throw new Error('actor absent in creation callback');
            Main.wm.skipNextEffect(actor);
            actor.opacity = 0;
            actor.reactive = false;
            this._signals.push([actor, actor.connect('notify::opacity', () => {
                if (actor.opacity !== 0)
                    actor.opacity = 0;
            })]);
            this._signals.push([actor, actor.connect('first-frame', () => {
                firstFrame = true;
                report('first-frame', {opacity: actor.opacity, mapped: actor.mapped});
            })]);
        });
        this._signals.push([global.display, id]);
        player.start();
        const ipc = new MpvIpc(socketPath, logger);
        this._ipcs.push(ipc);
        await ipc.connect({timeoutMs: 5000});
        await delay(700);
        report('idle', {window: Boolean(window)});
        await ipc.command(['loadfile', GLib.getenv('T08_ASSET')], {assetIdentity: 'selected-green'});
        await ipc.waitForContent({assetIdentity: 'selected-green', timeoutMs: 10000});
        const deadline = GLib.get_monotonic_time() + 5000000;
        while (!firstFrame && GLib.get_monotonic_time() < deadline)
            await delay(10);
        report('readiness', {firstFrame, focused: window === global.display.focus_window,
            skipTaskbar: window.skip_taskbar, mapped: actor.mapped, minimized: window.minimized,
            hidden: window.is_hidden(), unsetFocus: typeof global.display.unset_input_focus});
        if (typeof global.display.unset_input_focus === 'function')
            global.display.unset_input_focus(global.get_current_time());
        await this._capture('before-clone');
        const clone = new Clutter.Clone({source: actor, reactive: false});
        const container = new Clutter.Actor({reactive: false});
        this._actors.push(container);
        container.add_child(clone);
        const monitor = Main.layoutManager.monitors[0];
        container.set_position(monitor.x, monitor.y);
        container.set_size(monitor.width, monitor.height);
        container.set_clip(0, 0, monitor.width, monitor.height);
        clone.set_size(monitor.width, monitor.height);
        Main.layoutManager._backgroundGroup.add_child(container);
        await delay(300);
        await this._capture('transparent-source-clone');
        await delay(300);
        await this._capture('settled-source-clone');
        Main.overview.show();
        await delay(600);
        await this._capture('overview');
        report('overview-exclusion', {tabList: global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .includes(window)});
        Main.overview.hide();
        await delay(600);
        report('clone', {mapped: clone.mapped, opacity: clone.opacity,
            sourceMapped: actor.mapped, focused: window === global.display.focus_window,
            minimized: window.minimized, hidden: window.is_hidden()});
        clone.set_source(null);
        container.destroy();
        this._actors = [];
        report('baseline', {before: baseline, after: Main.layoutManager._backgroundGroup.get_n_children()});
        await ipc.close();
        await player.stop({graceMs: 100});
        for (let cycle = 0; cycle < 10; cycle++)
            await this._layerCycle(cycle, baseline);
        report('complete');
        global.context.terminate();
    }
}
