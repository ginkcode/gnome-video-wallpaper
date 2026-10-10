// Native window-list exclusion remains until window destruction. Releasing it
// on layer teardown could expose a still-running raw player. M1 verified clone
// painting after first-frame with the source permanently transparent; minimize
// was a no-op on that window, so it is not a readiness or hiding guarantee.
import Cogl from 'gi://Cogl';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta?version=18';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BackgroundLifecycle} from './backgroundLifecycle.js';
import {Disposables} from './disposables.js';
import {createLogger} from './log.js';

Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_async', 'new_from_stream_finish');
Gio._promisify(Gio.InputStream.prototype, 'close_async', 'close_finish');

const ACTOR_ATTEMPTS = 8;

export class BackgroundLayer {
    constructor({monitorIndex, logger = createLogger('background')}) {
        if (!Number.isInteger(monitorIndex) || monitorIndex < 0)
            throw new Error('monitorIndex must be a nonnegative integer');
        this._monitorIndex = monitorIndex;
        this._log = logger;
        this._lifecycle = new BackgroundLifecycle();
        this._resources = new Disposables();
        this._player = null;
        this._window = null;
        this._previousFocus = null;
        this._refocusing = false;
        this._actor = null;
        this._hidden = false;
        this._container = null;
        this._clone = null;
        this._static = null;
        this._staticSerial = 0;
        this._staticCancel = null;
        this._staticOperation = null;
        this._preparedImage = null;
        this._fade = null;
    }

    watchWindow(playerProcess, {timeoutMs = 10000, cancellable = null} = {}) {
        if (!playerProcess || typeof playerProcess.ownsWindow !== 'function')
            throw new Error('watchWindow requires a player process');
        this._player = playerProcess;
        this._previousFocus = global.display.focus_window;
        return this._lifecycle.watchWindow(playerProcess, {
            timeoutMs,
            cancellable,
            connectCreated: callback => {
                let id = global.display.connect('window-created', (_display, window) => callback(window));
                const disconnect = () => {
                    if (id) {
                        global.display.disconnect(id);
                        id = 0;
                    }
                };
                this._resources.add(disconnect);
                return disconnect;
            },
            existingWindows: () => global.display.list_all_windows?.() ?? global.get_window_actors?.().map(actor => actor.meta_window) ?? [],
            prepareWindow: (window, resolve, reject, active) => this._prepare(window, resolve, reject, active),
        });
    }

    attach(metaWindow) {
        this._lifecycle.assertOpen();
        if (!this._hidden || metaWindow !== this._window)
            throw new Error('attach requires the window already hidden by watchWindow');
        if (this._clone)
            throw new Error('background layer is already attached');
        this._ensureContainer();
        const monitor = this._monitor();
        this._clone = new Clutter.Clone({source: this._actor,
            width: monitor.width, height: monitor.height, opacity: 0, reactive: false});
        this._container.add_child(this._clone);
        if (Main.overview.visible)
            this._clone.hide();
    }

    _connect(object, signal, callback) {
        const generation = this._lifecycle.generation;
        return this._resources.connect(object, signal, (...args) => {
            if (this._lifecycle.destroyed || generation !== this._lifecycle.generation)
                return;
            callback(...args);
        });
    }

    _ensureContainer() {
        if (this._container)
            return;
        const monitor = this._monitor();
        this._container = new Clutter.Actor({
            x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
            reactive: false, clip_to_allocation: true,
        });
        this._static = new Clutter.Actor({
            width: monitor.width, height: monitor.height, opacity: 0, reactive: false,
        });
        this._container.add_child(this._static);
        const group = Main.layoutManager._backgroundGroup;
        const backgrounds = group.get_children().filter(child => child instanceof Meta.BackgroundActor);
        const anchor = backgrounds[this._monitorIndex];
        if (anchor)
            group.insert_child_above(this._container, anchor);
        else
            group.insert_child_at_index(this._container, 0);
        this._connect(Main.layoutManager, 'monitors-changed', () => this._syncGeometry());
        this._connect(global.display, 'notify::focus-window', () => this._guardFocus());
        this._guardFocus();
        this._connect(Main.overview, 'showing', () => {
            if (this._clone)
                this._clone.hide();
        });
        this._connect(Main.overview, 'hidden', () => {
            if (this._clone)
                this._clone.show();
        });
    }

    waitForFirstFrame(options = {}) {
        return this._lifecycle.waitForFirstFrame(options);
    }

    async prepareStatic(publishedPath, {cancellable = null} = {}) {
        this._lifecycle.assertOpen();
        if (typeof publishedPath !== 'string' || !publishedPath)
            throw new Error('publishedPath must be a nonempty path');
        this._ensureContainer();
        const generation = this._lifecycle.generation;
        const serial = ++this._staticSerial;
        this._staticOperation?.reject(new Error('Static image load superseded'));
        const operation = this._lifecycle.operation({cancellable, message: 'Static image load cancelled'});
        this._staticOperation = operation;
        this._staticCancel = operation.cancellable;
        this._loadStatic(publishedPath, generation, serial, operation);
        return operation.promise;
    }

    async _loadStatic(publishedPath, generation, serial, operation) {
        let stream = null;
        try {
            stream = await Gio.File.new_for_path(publishedPath).read_async(GLib.PRIORITY_DEFAULT, operation.cancellable);
            const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_async(stream, operation.cancellable);
            if (this._lifecycle.destroyed || generation !== this._lifecycle.generation ||
                serial !== this._staticSerial || operation.cancellable.is_cancelled()) {
                operation.reject(new Error('Background layer static load superseded'));
                return;
            }
            const image = St.ImageContent.new_with_preferred_size(pixbuf.get_width(), pixbuf.get_height());
            image.set_bytes(global.stage.context.get_backend().get_cogl_context(), pixbuf.read_pixel_bytes(),
                pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                pixbuf.get_width(), pixbuf.get_height(), pixbuf.get_rowstride());
            this._preparedImage = image;
            this._staticGeneration = serial;
            if (!this._static.content) {
                this._static.content = image;
                this._static.opacity = 255;
            }
            operation.resolve();
        } catch (error) {
            operation.reject(error);
        } finally {
            if (stream) {
                try {
                    await stream.close_async(GLib.PRIORITY_DEFAULT, null);
                } catch (error) {
                    this._log.debug(`static stream close: ${error.message}`);
                }
            }
        }
    }

    showStatic() {
        this._lifecycle.assertOpen();
        if (!this._static || !this._preparedImage)
            throw new Error('showStatic requires a prepared still');
        this._static.content = this._preparedImage;
        this._static.opacity = 255;
        this._fade?.reject(new Error('Background video replaced by still'));
        this._clone?.set_source(null);
        this._clone?.destroy();
        this._clone = null;
    }

    fadeIn(ms = 300, {cancellable = null} = {}) {
        this._lifecycle.assertOpen();
        if (!this._clone)
            throw new Error('fadeIn requires an attached video clone');
        if (!Number.isFinite(ms) || ms < 0)
            throw new Error('fade duration must be finite and nonnegative');
        const generation = this._lifecycle.generation;
        const clone = this._clone;
        this._fade?.reject(new Error('Background fade superseded'));
        const operation = this._lifecycle.operation({cancellable, message: 'Background fade cancelled'});
        this._fade = operation;
        if (operation.done)
            return operation.promise;
        operation.promise.catch(() => {
            if (!this._lifecycle.destroyed && generation === this._lifecycle.generation &&
                this._clone === clone && this._fade === operation)
                clone.remove_all_transitions();
        });
        if (ms === 0) {
            clone.opacity = 255;
            clone.remove_all_transitions();
            operation.resolve();
            return operation.promise;
        }
        clone.remove_all_transitions();
        clone.ease({
            opacity: 255,
            duration: ms,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._lifecycle.destroyed || generation !== this._lifecycle.generation ||
                    this._clone !== clone || operation.cancellable.is_cancelled())
                    return;
                operation.resolve();
            },
            onStopped: isFinished => {
                if (!isFinished)
                    operation.reject(new Error('Background fade stopped'));
            },
        });
        return operation.promise;
    }

    destroy() {
        if (this._lifecycle.destroyed)
            return;
        this._lifecycle.destroy();
        this._staticCancel?.cancel();
        this._fade?.reject(new Error('Background layer destroyed'));
        this._clone?.set_source(null);
        this._container?.destroy();
        this._container = null;
        this._clone = null;
        this._static = null;
        this._preparedImage = null;
        this._resources.dispose();
        this._actor = null;
    }

    _prepare(window, resolve, reject, active) {
        this._window = window;
        window.hide_from_window_list();
        window.lower();
        window.stick();
        const actor = window.get_compositor_private();
        if (actor) {
            Main.wm.skipNextEffect(actor);
            actor.opacity = 0;
            actor.reactive = false;
        }
        this._connect(window, 'unmanaged', () => this._sourceLost());
        if (!actor) {
            // Without an actor, native minimization is the only synchronous guard.
            window.minimize();
            if (!window.minimized) {
                reject(new Error('Missing compositor actor and native minimization failed; before-first-paint hiding is unverified'));
                return;
            }
            this._retryActor(window, 0, resolve, reject, active);
            return;
        }
        this._hide(window, actor, resolve, reject, active);
    }

    _laters() {
        return global.compositor?.get_laters?.() ?? null;
    }

    _retryActor(window, attempt, resolve, reject, active) {
        const laters = this._laters();
        if (!laters) {
            reject(new Error('Compositor later scheduler is unavailable'));
            return;
        }
        if (attempt >= ACTOR_ATTEMPTS) {
            reject(new Error('Player compositor actor was not available before first paint'));
            return;
        }
        let removed = false;
        const id = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            removed = true;
            if (!active() || this._window !== window)
                return GLib.SOURCE_REMOVE;
            const actor = window.get_compositor_private();
            if (!actor) {
                this._retryActor(window, attempt + 1, resolve, reject, active);
                return GLib.SOURCE_REMOVE;
            }
            try {
                this._hide(window, actor, resolve, reject, active);
            } catch (error) {
                reject(error);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._resources.add(() => {
            if (!removed)
                laters.remove(id);
        });
    }

    _hide(window, actor, resolve, reject, active) {
        this._actor = actor;
        Main.wm.skipNextEffect(actor);
        actor.opacity = 0;
        actor.reactive = false;
        this._connect(actor, 'notify::opacity', () => {
            if (actor.opacity !== 0)
                actor.opacity = 0;
        });
        this._connect(actor, 'first-frame', () => this._lifecycle.latchFirstFrame());
        this._connect(actor, 'destroy', () => this._sourceLost());
        this._connect(window, 'notify::appears-focused', () => this._guardFocus());
        this._connect(window, 'focus', () => this._guardFocus());
        if (!active())
            return;
        this._hidden = true;
        const monitor = this._monitor();
        window.move_resize_frame(false, monitor.x, monitor.y, monitor.width, monitor.height);
        this._guardFocus();
        resolve();
    }

    _sourceLost() {
        if (this._lifecycle.destroyed)
            return;
        this._lifecycle.fail(new Error('Player compositor window disappeared'));
        this._clone?.set_source(null);
        this._clone?.hide();
    }

    _guardFocus() {
        if (!this._window || this._lifecycle.destroyed || this._refocusing)
            return;
        const focused = global.display.focus_window;
        if (focused && focused !== this._window) {
            this._previousFocus = focused;
            return;
        }
        if (focused !== this._window && !this._window.appears_focused)
            return;
        this._refocusing = true;
        try {
            const timestamp = global.get_current_time();
            if (this._previousFocus && !this._previousFocus.minimized)
                this._previousFocus.activate(timestamp);
            else
                global.display.unset_input_focus(timestamp);
        } finally {
            this._refocusing = false;
        }
    }

    _monitor() {
        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        if (!monitor)
            throw new Error(`monitor ${this._monitorIndex} is unavailable`);
        return monitor;
    }

    _syncGeometry() {
        if (!this._container || this._lifecycle.destroyed)
            return;
        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        if (!monitor)
            return;
        this._container.set_position(monitor.x, monitor.y);
        this._container.set_size(monitor.width, monitor.height);
        for (const child of [this._static, this._clone]) {
            child?.set_size(monitor.width, monitor.height);
        }
        this._window?.move_resize_frame?.(false, monitor.x, monitor.y, monitor.width, monitor.height);
    }
}
