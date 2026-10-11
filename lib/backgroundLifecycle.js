import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Disposables} from './disposables.js';

function cancelled() {
    return new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED,
        'Background operation was cancelled');
}

export class LayerOperation {
    constructor({timeoutMs = null, cancellable = null, message = 'Background operation timed out'} = {}) {
        if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs < 0))
            throw new Error('timeoutMs must be finite and nonnegative');
        this.cancellable = new Gio.Cancellable();
        this.done = false;
        this._resources = new Disposables();
        this.promise = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
        this.promise.catch(() => {});
        if (cancellable?.is_cancelled()) {
            this.reject(cancelled());
            return;
        }
        if (cancellable) {
            const id = cancellable.connect(() => this.reject(cancelled()));
            this._resources.add(() => {
                // Gio.Cancellable.disconnect cannot run inside its cancellation callback.
                if (cancellable.is_cancelled()) {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        cancellable.disconnect(id);
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    cancellable.disconnect(id);
                }
            });
        }
        if (timeoutMs !== null) {
            this._resources.timeout(Math.max(1, Math.ceil(timeoutMs)), () => {
                this.reject(new Error(message));
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    resolve(value) {
        this._settle(null, value);
    }

    reject(error) {
        this._settle(error);
    }

    _settle(error, value) {
        if (this.done)
            return;
        this.done = true;
        this._resources.dispose();
        if (error) {
            this.cancellable.cancel();
            this._reject(error);
        } else {
            this._resolve(value);
        }
    }
}

export class BackgroundLifecycle {
    constructor() {
        this.generation = 0;
        this.destroyed = false;
        this.window = null;
        this.firstFrame = false;
        this.error = null;
        this._operations = new Set();
        this._frameWaits = new Set();
        this._watch = null;
    }

    assertOpen() {
        if (this.destroyed || this.error)
            throw this.error ?? new Error('Background layer destroyed');
    }

    operation(options = {}) {
        this.assertOpen();
        const operation = new LayerOperation(options);
        this._operations.add(operation);
        operation.promise.then(() => this._operations.delete(operation),
            () => this._operations.delete(operation));
        return operation;
    }

    watchWindow(player, {connectCreated, existingWindows, prepareWindow,
        timeoutMs = 10000, cancellable = null}) {
        this.assertOpen();
        if (this._watch)
            throw new Error('Background layer already watches a player');
        const operation = this.operation({timeoutMs, cancellable,
            message: 'Player window discovery timed out'});
        this._watch = operation;
        if (operation.done)
            return operation.promise;
        const accept = (window, existing = false) => {
            if (operation.done || this.destroyed || this.window || !player.ownsWindow(window))
                return;
            if (existing) {
                this.fail(new Error('Preexisting player window has no verified before-first-paint hiding evidence'));
                return;
            }
            this.window = window;
            try {
                // Hiding must happen on this stack, never in the Promise continuation.
                prepareWindow(window, () => operation.resolve(window), error => this.fail(error),
                    () => !operation.done && !this.destroyed && !this.error);
            } catch (error) {
                this.fail(error);
            }
        };
        const disconnect = connectCreated(window => accept(window));
        operation.promise.then(disconnect, disconnect);
        for (const window of existingWindows())
            accept(window, true);
        return operation.promise;
    }

    latchFirstFrame() {
        if (this.destroyed || this.error || !this.window)
            return;
        this.firstFrame = true;
        for (const operation of this._frameWaits)
            operation.resolve();
        this._frameWaits.clear();
    }

    waitForFirstFrame({timeoutMs = 10000, cancellable = null} = {}) {
        const operation = this.operation({timeoutMs, cancellable,
            message: 'Player compositor first frame timed out'});
        if (this.firstFrame)
            operation.resolve();
        else if (!operation.done)
            this._frameWaits.add(operation);
        operation.promise.then(() => this._frameWaits.delete(operation),
            () => this._frameWaits.delete(operation));
        return operation.promise;
    }

    fail(error) {
        this.error ??= error;
        for (const operation of this._operations)
            operation.reject(this.error);
        this._frameWaits.clear();
    }

    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.generation++;
        this.fail(new Error('Background layer destroyed'));
    }
}

export function findBackgroundAnchor(children, monitorIndex, isBackground) {
    let anchor = null;
    for (const child of children) {
        if (isBackground(child) && child.monitor === monitorIndex)
            anchor = child;
    }
    return anchor;
}

export function placeAboveBackground(group, layer, anchor) {
    const parent = layer.get_parent();
    if (parent !== group) {
        parent?.remove_child(layer);
        if (anchor)
            group.insert_child_above(layer, anchor);
        else
            group.insert_child_at_index(layer, 0);
        return;
    }
    if (!anchor)
        return;
    const children = group.get_children();
    if (children.indexOf(layer) < children.indexOf(anchor))
        group.set_child_above_sibling(layer, anchor);
}

export function windowGeometryCorrection(frame, target, {maximized = false} = {}) {
    const sized = frame.width === target.width && frame.height === target.height;
    if (maximized)
        return {unmaximize: true, moveResize: [target.x, target.y, target.width, target.height]};
    if (sized && frame.x === target.x && frame.y === target.y)
        return null;
    return sized ? {move: [target.x, target.y]}
        : {moveResize: [target.x, target.y, target.width, target.height]};
}
