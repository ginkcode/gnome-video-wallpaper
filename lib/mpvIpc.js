import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {createLogger} from './log.js';
import {readLine, sleep} from './async.js';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async', 'connect_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');
Gio._promisify(Gio.IOStream.prototype, 'close_async', 'close_finish');

const readinessProperties = ['path', 'idle-active', 'vo-configured', 'video-out-params'];

export class MpvIpc {
    constructor(socketPath, logger = createLogger('mpv-ipc')) {
        this._socketPath = socketPath;
        this._log = logger;
        this._connection = null;
        this._nextId = 1;
        this._pending = new Map();
        this._events = new Map();
        this._observations = new Map();
        this._waits = new Set();
        this._closed = false;
        this._generation = 0;
        this._io = new Gio.Cancellable();
        this._writes = Promise.resolve();
        this._load = null;
        this._loadSerial = 0;
    }

    async connect({timeoutMs = 5000, cancellable = null} = {}) {
        this._assertOpen();
        cancellable?.set_error_if_cancelled();
        if (this._connection)
            return;
        if (this._connecting)
            throw new Error('mpv IPC connect already in progress');
        const scope = operation(cancellable, timeoutMs, 'mpv IPC connect timed out');
        const generation = this._generation;
        this._connecting = scope;
        scope.done = new Promise(resolve => {
            scope.finish = resolve;
        });
        try {
            const client = new Gio.SocketClient();
            while (true) {
                scope.cancellable.set_error_if_cancelled();
                let connection;
                try {
                    connection = await client.connect_async(
                        Gio.UnixSocketAddress.new(this._socketPath), scope.cancellable);
                } catch (error) {
                    if (scope.cancellable.is_cancelled())
                        throw scope.error ?? error;
                    await sleep(100, scope.cancellable);
                    continue;
                }
                if (this._closed || generation !== this._generation || scope.cancellable.is_cancelled()) {
                    await this._closeConnection(connection);
                    throw scope.error ?? new Error('mpv IPC closed');
                }
                this._connection = connection;
                this._output = connection.get_output_stream();
                this._input = new Gio.DataInputStream({base_stream: connection.get_input_stream()});
                this._reading = this._read(generation);
                for (const property of readinessProperties)
                    this.observe(property, () => {});
                return;
            }
        } catch (error) {
            throw scope.error ?? error;
        } finally {
            scope.dispose();
            scope.finish();
            if (this._connecting === scope)
                this._connecting = null;
        }
    }

    async command(args, {cancellable = null, assetIdentity = null} = {}) {
        this._assertOpen();
        cancellable?.set_error_if_cancelled();
        if (!this._connection)
            throw new Error('mpv IPC not connected');
        if (assetIdentity !== null && (args[0] !== 'loadfile' || typeof assetIdentity !== 'string' || !assetIdentity))
            throw new Error('assetIdentity is only valid for loadfile and must be nonempty');
        const id = this._nextId++;
        const bytes = new TextEncoder().encode(`${JSON.stringify({command: args, request_id: id})}\n`);
        const scope = operation(cancellable);
        let load = null;
        if (args[0] === 'loadfile') {
            if (args[2] && args[2] !== 'replace') {
                scope.dispose();
                throw new Error('content tracking supports only loadfile replace');
            }
            load = {serial: ++this._loadSerial, identity: assetIdentity,
                path: args[1], entryId: null, ready: false, error: null};
            this._load = load;
        }
        const reply = new Promise((resolve, reject) => {
            this._pending.set(id, {resolve, reject, scope});
        });
        const cancelId = scope.cancellable.connect(() => {
            this._settle(id, scope.error ?? cancelled());
        });
        const generation = this._generation;
        const write = this._writes.then(async () => {
            if (!this._pending.has(id))
                return;
            if (generation !== this._generation)
                throw new Error('mpv IPC closed');
            let offset = 0;
            while (offset < bytes.length) {
                // Once a line starts, caller cancellation cannot leave a truncated JSON frame.
                const count = await this._output.write_bytes_async(
                    new GLib.Bytes(bytes.subarray(offset)), GLib.PRIORITY_DEFAULT, this._io);
                if (!count)
                    throw new Error('mpv IPC zero-byte write');
                offset += count;
            }
        });
        this._writes = write.catch(error => {
            if (!this._closed) {
                this._log.debug(`write ended: ${error.message}`);
                this.close();
            }
        });
        try {
            const result = await reply;
            if (load) {
                if (!Number.isInteger(result?.playlist_entry_id))
                    throw new Error('mpv loadfile reply lacks playlist_entry_id; unsupported mpv');
                load.entryId = result.playlist_entry_id;
            }
            return result;
        } catch (error) {
            if (load)
                load.error = error;
            throw error;
        } finally {
            scope.cancellable.disconnect(cancelId);
            scope.dispose();
        }
    }

    setPause(paused, options = {}) {
        return this.command(['set_property', 'pause', Boolean(paused)], options);
    }

    observe(property, callback) {
        this._assertOpen();
        if (!this._connection)
            throw new Error('mpv IPC not connected');
        let observation = this._observations.get(property);
        if (!observation) {
            observation = {id: this._nextId++, callbacks: new Set(), hasValue: false,
                value: undefined, revision: 0};
            this._observations.set(property, observation);
            this.command(['observe_property', observation.id, property]).then(async () => {
                const revision = observation.revision;
                const value = await this.command(['get_property', property]);
                if (this._observations.get(property) === observation && revision === observation.revision)
                    this._property(observation, value);
            }).catch(error => this._log.debug(`observe ${property}: ${error.message}`));
        }
        const subscription = value => callback(value);
        observation.callbacks.add(subscription);
        if (observation.hasValue)
            this._safe(subscription, observation.value);
        return () => {
            if (!observation.callbacks.delete(subscription) || observation.callbacks.size)
                return;
            this._observations.delete(property);
            if (!this._closed)
                this.command(['unobserve_property', observation.id]).catch(error =>
                    this._log.debug(`unobserve ${property}: ${error.message}`));
        };
    }

    onEvent(name, callback) {
        this._assertOpen();
        if (!this._connection)
            throw new Error('mpv IPC not connected');
        const callbacks = this._events.get(name) ?? new Set();
        const subscription = event => callback(event);
        callbacks.add(subscription);
        this._events.set(name, callbacks);
        return () => {
            callbacks.delete(subscription);
            if (!callbacks.size)
                this._events.delete(name);
        };
    }

    async waitForContent({assetIdentity, timeoutMs = 10000, cancellable = null} = {}) {
        this._assertOpen();
        cancellable?.set_error_if_cancelled();
        if (typeof assetIdentity !== 'string' || !assetIdentity)
            throw new Error('assetIdentity must be a nonempty string');
        const scope = operation(cancellable, timeoutMs, 'mpv content timed out');
        this._waits.add(scope);
        let selected = this._load?.identity === assetIdentity ? this._load : null;
        try {
            while (true) {
                scope.cancellable.set_error_if_cancelled();
                this._assertOpen();
                if (!selected && this._load?.identity === assetIdentity)
                    selected = this._load;
                if (selected && selected !== this._load)
                    throw new Error('mpv content load superseded');
                if (selected?.error)
                    throw selected.error;
                if (selected?.entryId !== null && selected) {
                    if (await this._reconcile(selected, scope.cancellable))
                        return;
                }
                await sleep(50, scope.cancellable);
            }
        } catch (error) {
            throw scope.error ?? error;
        } finally {
            this._waits.delete(scope);
            scope.dispose();
        }
    }

    async _reconcile(load, cancellable) {
        const get = property => this.command(['get_property', property], {cancellable})
            .catch(error => {
                if (cancellable.is_cancelled() || this._closed)
                    throw error;
                return undefined;
            });
        const first = await get('playlist');
        const values = await Promise.all(readinessProperties.map(get));
        const last = await get('playlist');
        if (load !== this._load || this._closed || cancellable.is_cancelled())
            return false;
        const current = playlist => playlist?.find(entry => entry.current)?.id;
        const [path, idle, configured, params] = values;
        load.ready = current(first) === load.entryId && current(last) === load.entryId &&
            path === load.path && idle === false && configured === true &&
            typeof params?.pixelformat === 'string' && params.w > 0 && params.h > 0;
        return load.ready;
    }

    close() {
        if (this._closed)
            return this._closing;
        this._closed = true;
        this._generation++;
        const error = new Error('mpv IPC closed');
        this._connecting?.cancel(error);
        for (const scope of this._waits)
            scope.cancel(error);
        for (const id of this._pending.keys())
            this._settle(id, error);
        this._io.cancel();
        this._events.clear();
        this._observations.clear();
        const connection = this._connection;
        this._connection = null;
        this._closing = Promise.allSettled([this._reading, this._writes, this._connecting?.done]).then(() =>
            connection ? this._closeConnection(connection) : undefined);
        return this._closing;
    }

    async _closeConnection(connection) {
        try {
            await connection.close_async(GLib.PRIORITY_DEFAULT, null);
        } catch (error) {
            this._log.debug(`close: ${error.message}`);
        }
    }

    async _read(generation) {
        try {
            while (!this._closed && generation === this._generation) {
                const line = await readLine(this._input, GLib.PRIORITY_DEFAULT, this._io);
                if (this._closed || generation !== this._generation)
                    return;
                if (line === null)
                    break;
                try {
                    this._dispatch(JSON.parse(line));
                } catch (error) {
                    this._log.debug(`invalid IPC message: ${error.message}`);
                }
            }
        } catch (error) {
            if (!this._closed)
                this._log.debug(`read ended: ${error.message}`);
        } finally {
            this.close();
        }
    }

    _dispatch(message) {
        if (message.event === 'property-change') {
            const observation = this._observations.get(message.name);
            if (observation?.id === message.id)
                this._property(observation, message.data);
        }
        if (message.event) {
            if (message.event === 'start-file' || message.event === 'end-file') {
                if (this._load)
                    this._load.ready = false;
            }
            for (const callback of [...this._events.get(message.event) ?? []])
                this._safe(callback, message);
        }
        if (message.request_id !== undefined)
            this._settle(message.request_id, message.error !== 'success'
                ? new Error(message.error ?? 'invalid mpv reply') : null, message.data);
    }

    _property(observation, value) {
        observation.revision++;
        observation.hasValue = true;
        observation.value = value;
        for (const callback of [...observation.callbacks])
            this._safe(callback, value);
    }

    _safe(callback, value) {
        try {
            callback(value);
        } catch (error) {
            this._log.warn(`IPC callback failed: ${error.message}`);
        }
    }

    _settle(id, error, value) {
        const entry = this._pending.get(id);
        if (!entry)
            return;
        this._pending.delete(id);
        if (error)
            entry.reject(error);
        else
            entry.resolve(value);
    }

    _assertOpen() {
        if (this._closed)
            throw new Error('mpv IPC closed');
    }
}

function cancelled() {
    return new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Operation was cancelled');
}

function operation(parent, timeoutMs = null, timeoutMessage = '') {
    const cancellable = new Gio.Cancellable();
    let handler = 0;
    let timer = 0;
    const scope = {
        cancellable,
        error: null,
        cancel(error) {
            scope.error ??= error;
            cancellable.cancel();
        },
        dispose() {
            if (handler) {
                parent.disconnect(handler);
                handler = 0;
            }
            if (timer) {
                GLib.source_remove(timer);
                timer = 0;
            }
        },
    };
    if (parent)
        handler = parent.connect(() => scope.cancel(cancelled()));
    if (timeoutMs !== null) {
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, timeoutMs), () => {
            timer = 0;
            scope.cancel(new Error(timeoutMessage));
            return GLib.SOURCE_REMOVE;
        });
    }
    return scope;
}
