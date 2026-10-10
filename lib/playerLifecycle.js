import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {createLogger} from './log.js';

const allocations = new Map();
const infoAttributes = 'standard::type,unix::mode,unix::uid,owner::user';

function io(file, method, finish, args) {
    return new Promise((resolve, reject) => {
        file[method](...args, (source, result) => {
            try {
                resolve(source[finish](result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function query(file, cancellable = null) {
    return io(file, 'query_info_async', 'query_info_finish', [infoAttributes,
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable]);
}

function missing(error) {
    return error.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND);
}

function validateDirectory(info, uid) {
    if (info.get_file_type() !== Gio.FileType.DIRECTORY ||
        (info.get_attribute_uint32('unix::mode') & 0o7777) !== 0o700 ||
        info.get_attribute_uint32('unix::uid') !== uid)
        throw new Error('player runtime directory is not private or owned by this user');
}

export async function preparePlayerSocket({cancellable = null} = {}) {
    cancellable?.set_error_if_cancelled();
    const runtime = GLib.getenv('XDG_RUNTIME_DIR');
    if (!runtime || !GLib.path_is_absolute(runtime))
        throw new Error('XDG_RUNTIME_DIR is unavailable');
    const root = Gio.File.new_for_path(runtime);
    const rootInfo = await query(root, cancellable);
    if (rootInfo.get_attribute_string('owner::user') !== GLib.get_user_name())
        throw new Error('XDG_RUNTIME_DIR is not owned by this user');
    const uid = rootInfo.get_attribute_uint32('unix::uid');
    validateDirectory(rootInfo, uid);
    const directory = root.get_child('gink-video-wallpaper');
    let info;
    try {
        info = await query(directory, cancellable);
    } catch (error) {
        if (!missing(error))
            throw error;
        let created = false;
        try {
            await io(directory, 'make_directory_async', 'make_directory_finish',
                [GLib.PRIORITY_DEFAULT, cancellable]);
            created = true;
        } catch (createError) {
            if (!createError.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.EXISTS))
                throw createError;
        }
        if (created) {
            const attributes = new Gio.FileInfo();
            attributes.set_attribute_uint32('unix::mode', 0o700);
            await io(directory, 'set_attributes_async', 'set_attributes_finish',
                [attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                    GLib.PRIORITY_DEFAULT, null]);
        }
        info = await query(directory, cancellable);
    }
    validateDirectory(info, uid);
    const socket = directory.get_child(`mpv-${GLib.uuid_string_random()}`);
    const path = socket.get_path();
    if (new TextEncoder().encode(path).length > 107)
        throw new Error('player socket path exceeds the UNIX socket limit');
    try {
        await query(socket, cancellable);
        throw new Error('allocated player socket already exists');
    } catch (error) {
        if (!missing(error))
            throw error;
    }
    cancellable?.set_error_if_cancelled();
    const allocation = {file: socket, uid, cancellable, cancelId: 0};
    allocations.set(path, allocation);
    allocation.cancelId = cancellable?.connect(() => {
        allocations.delete(path);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (allocation.cancelId)
                cancellable.disconnect(allocation.cancelId);
            allocation.cancelId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }) ?? 0;
    cancellable?.set_error_if_cancelled();
    return path;
}

export function releasePlayerSocket(path) {
    const allocation = allocations.get(path);
    if (!allocation)
        return;
    allocations.delete(path);
    if (allocation.cancelId)
        allocation.cancellable.disconnect(allocation.cancelId);
    allocation.cancelId = 0;
}

function consume(path) {
    const allocation = allocations.get(path);
    if (!allocation)
        throw new Error('player socket must be uniquely prepared before construction');
    releasePlayerSocket(path);
    return allocation;
}

export class ProcessLifecycle {
    constructor({argv, socketPath, logger = createLogger('player'), spawn}) {
        if (!Array.isArray(argv) || argv.length === 0 ||
            argv.some(arg => typeof arg !== 'string') ||
            argv.filter(arg => arg.startsWith('--input-ipc-server=')).length !== 1 ||
            !argv.includes(`--input-ipc-server=${socketPath}`))
            throw new Error('player argv socket does not match the owned socket');
        if (typeof spawn !== 'function')
            throw new Error('player requires a spawn function');
        this._allocation = consume(socketPath);
        this._argv = [...argv];
        this._spawn = spawn;
        this._logger = logger;
        this._callbacks = new Set();
        this._client = null;
        this._subprocess = null;
        this._started = false;
        this._terminated = false;
        this._forced = false;
        this._stopRequested = false;
        this._graceSource = 0;
        this._exitResult = null;
        this._reapPromise = null;
        this._finishStarted = false;
        this._reading = null;
        this._stream = null;
        this._readCancel = null;
    }

    get waylandClient() {
        return this._client;
    }

    get pid() {
        return this._subprocess?.get_identifier() ?? null;
    }

    start() {
        if (this._terminated || this._started)
            throw new Error('player cannot start twice or after termination');
        this._started = true;
        let spawned;
        try {
            spawned = this._spawn(this._argv);
            this._subprocess = spawned.subprocess;
            this._client = spawned.client ?? null;
        } catch (error) {
            this._terminated = true;
            this._installReap(this._finish({status: 0, signaled: false}));
            throw error;
        }
        this._readCancel = new Gio.Cancellable();
        const pipe = this._subprocess.get_stderr_pipe();
        if (pipe) {
            this._stream = new Gio.DataInputStream({base_stream: pipe});
            this._reading = this._readLines();
        }
        this._installReap(this._wait());
    }

    ownsWindow(window) {
        return this._client?.owns_window(window) ?? false;
    }

    onExit(callback) {
        const subscription = {callback, active: true};
        if (this._exitResult) {
            this._notify(subscription);
            return () => {};
        }
        this._callbacks.add(subscription);
        return () => {
            subscription.active = false;
            this._callbacks.delete(subscription);
        };
    }

    terminateNow() {
        this._terminated = true;
        this._clearGrace();
        if (!this._started) {
            if (!this._reapPromise)
                this._installReap(this._finish({status: 0, signaled: false}));
            return;
        }
        this._forceExit();
    }

    stop({graceMs = 1000} = {}) {
        if (!Number.isFinite(graceMs) || graceMs < 0)
            throw new Error('graceMs must be a finite nonnegative number');
        this._terminated = true;
        if (!this._started) {
            if (!this._reapPromise)
                this._installReap(this._finish({status: 0, signaled: false}));
        } else if (!this._exitResult && !this._forced && !this._stopRequested && this._subprocess) {
            this._stopRequested = true;
            this._subprocess.send_signal(15);
            this._graceSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                Math.min(Math.ceil(graceMs), 2147483647), () => {
                    this._graceSource = 0;
                    this._forceExit();
                    return GLib.SOURCE_REMOVE;
                });
        }
        return this._reapPromise;
    }

    _installReap(promise) {
        if (!this._reapPromise) {
            this._reapPromise = promise;
            this._reapPromise.catch(error => this._logger.error(error.message));
        }
        return this._reapPromise;
    }

    _forceExit() {
        if (this._forced || this._exitResult || !this._subprocess)
            return;
        this._forced = true;
        this._subprocess.force_exit();
    }

    _clearGrace() {
        if (this._graceSource)
            GLib.source_remove(this._graceSource);
        this._graceSource = 0;
    }

    async _wait() {
        await io(this._subprocess, 'wait_async', 'wait_finish', [null]);
        const signaled = this._subprocess.get_if_signaled();
        return this._finish({status: signaled ? 128 + this._subprocess.get_term_sig()
            : this._subprocess.get_exit_status(), signaled});
    }

    async _finish(result) {
        if (this._finishStarted)
            return this._reapPromise;
        this._finishStarted = true;
        this._terminated = true;
        this._clearGrace();
        this._exitResult = Object.freeze(result);
        await Promise.resolve();
        const callbacks = [...this._callbacks];
        this._callbacks.clear();
        for (const subscription of callbacks) {
            if (subscription.active)
                this._notify(subscription);
        }
        this._readCancel?.cancel();
        await this._reading;
        let closeError = null;
        if (this._stream) {
            try {
                await io(this._stream, 'close_async', 'close_finish',
                    [GLib.PRIORITY_DEFAULT, null]);
            } catch (error) {
                closeError = error;
            }
            this._stream = null;
        }
        if (this._subprocess) {
            try {
                const info = await query(this._allocation.file);
                const mode = info.get_attribute_uint32('unix::mode');
                if ((mode & 0o170000) !== 0o140000 ||
                    info.get_attribute_uint32('unix::uid') !== this._allocation.uid)
                    throw new Error('refusing to delete a non-owned player socket');
                await io(this._allocation.file, 'delete_async', 'delete_finish',
                    [GLib.PRIORITY_DEFAULT, null]);
            } catch (error) {
                if (!missing(error))
                    throw error;
            }
        }
        if (closeError)
            throw closeError;
        return this._exitResult;
    }

    _notify({callback}) {
        try {
            callback(this._exitResult);
        } catch (error) {
            this._logger.error(error.message);
        }
    }

    async _readLines() {
        try {
            while (!this._readCancel.is_cancelled()) {
                const [line] = await io(this._stream, 'read_line_async', 'read_line_finish_utf8',
                    [GLib.PRIORITY_DEFAULT, this._readCancel]);
                if (line === null)
                    return;
                this._logger.debug(line);
            }
        } catch (error) {
            if (!error.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED))
                this._logger.debug(error.message);
        }
    }
}
