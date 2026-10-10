import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {createLogger} from './log.js';

const log = createLogger('disposables');

export class Disposables {
    constructor() {
        this._entries = [];
        this._disposed = false;
    }

    connect(gobject, signal, callback) {
        return this._connect(gobject, signal, callback, false);
    }

    connectAfter(gobject, signal, callback) {
        return this._connect(gobject, signal, callback, true);
    }

    timeout(ms, callback) {
        return this._source(callback, id => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, id));
    }

    idle(callback) {
        return this._source(callback, id => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, id));
    }

    add(fn) {
        this._assertOpen();
        this._entries.push({run: fn});
        return fn;
    }

    cancellable() {
        this._assertOpen();
        const cancellable = new Gio.Cancellable();
        this.add(() => cancellable.cancel());
        return cancellable;
    }

    dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        while (this._entries.length > 0) {
            const entry = this._entries.pop();
            try {
                entry.run();
            } catch (error) {
                log.error(`cleanup failed: ${error.message}`);
            }
        }
    }

    _connect(gobject, signal, callback, after) {
        this._assertOpen();
        const id = after
            ? gobject.connect_after(signal, callback)
            : gobject.connect(signal, callback);
        this._entries.push({run: () => gobject.disconnect(id)});
        return id;
    }

    _source(callback, schedule) {
        this._assertOpen();
        let sourceId = 0;
        let entry = null;
        const wrapped = () => {
            let result = GLib.SOURCE_REMOVE;
            try {
                result = callback();
            } finally {
                if (result !== GLib.SOURCE_CONTINUE && entry)
                    this._forget(entry);
            }
            return result;
        };
        sourceId = schedule(wrapped);
        entry = {
            run: () => {
                if (sourceId !== 0)
                    GLib.source_remove(sourceId);
            },
        };
        this._entries.push(entry);
        return sourceId;
    }

    _forget(entry) {
        const index = this._entries.indexOf(entry);
        if (index >= 0)
            this._entries.splice(index, 1);
    }

    _assertOpen() {
        if (this._disposed)
            throw new Error('Disposables is already disposed');
    }
}
