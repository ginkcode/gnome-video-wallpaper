import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {sleep} from '../lib/async.js';
import {
    ProcessLifecycle,
    preparePlayerSocket,
    releasePlayerSocket,
} from '../lib/playerLifecycle.js';
import {assertEqual, run, test} from './harness.js';

const root = Gio.File.new_for_path(GLib.dir_make_tmp('gink-vw-player-XXXXXX'));
const originalRuntime = GLib.getenv('XDG_RUNTIME_DIR');
let sequence = 0;

function useRuntime(path) {
    GLib.setenv('XDG_RUNTIME_DIR', path, true);
}

function restoreRuntime() {
    if (originalRuntime)
        GLib.setenv('XDG_RUNTIME_DIR', originalRuntime, true);
    else
        GLib.unsetenv('XDG_RUNTIME_DIR');
}

function runtimePath(name) {
    const path = root.get_child(name).get_path();
    GLib.mkdir_with_parents(path, 0o700);
    return path;
}

function mode(path) {
    const info = Gio.File.new_for_path(path).query_info('unix::mode',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    return info.get_attribute_uint32('unix::mode') & 0o7777;
}

function makeSocket(directory) {
    const path = `${directory}/socket-${sequence++}`;
    Gio.File.new_for_path(path).make_symbolic_link('/tmp/outside', null);
    return path;
}

async function rejected(promise) {
    try {
        await promise;
        return false;
    } catch {
        return true;
    }
}

class FakeSubprocess {
    constructor(argv) {
        this.argv = argv;
        this.identifier = String(10000 + sequence++);
        this.lines = ['player warning'];
        this.exitStatus = 0;
        this.termSignal = 0;
        this.signaled = false;
        this.exited = false;
        this.forced = false;
        this.signals = [];
        this.waitCallback = null;
        this.waitCancellable = null;
        this.forceCount = 0;
    }

    get_identifier() {
        return this.identifier;
    }

    get_stderr_pipe() {
        const bytes = new TextEncoder().encode(`${this.lines.join('\n')}\n`);
        return Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes));
    }

    send_signal(signal) {
        this.signals.push(signal);
        if (signal === 15 && !this.exited)
            this.exit(0, 15);
    }

    force_exit() {
        this.forceCount++;
        this.forced = true;
        if (!this.exited)
            this.exit(0, 9);
    }

    wait_async(cancellable, callback) {
        this.waitCancellable = cancellable;
        this.waitCallback = callback;
        if (this.exited)
            this._notify();
    }

    wait_finish() {}

    get_exit_status() {
        return this.exitStatus;
    }

    get_if_signaled() {
        return this.signaled;
    }

    get_term_sig() {
        return this.termSignal;
    }

    exit(status, signal = 0) {
        if (this.exited)
            return;
        this.exited = true;
        this.exitStatus = status;
        this.signaled = signal !== 0;
        this.termSignal = signal;
        this._notify();
    }

    _notify() {
        const callback = this.waitCallback;
        this.waitCallback = null;
        if (!callback)
            return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            callback(this, null);
            return GLib.SOURCE_REMOVE;
        });
    }
}

function spawnFake(state) {
    return argv => {
        const subprocess = new FakeSubprocess(argv);
        state.launched.push(subprocess);
        return {subprocess, client: {owns_window: window => window === state.owned}};
    };
}

async function player({state = {launched: [], owned: {}}, lines, socketPath, argv} = {}) {
    useRuntime(runtimePath(`runtime-${sequence++}`));
    const prepared = socketPath ?? await preparePlayerSocket();
    const lifecycle = new ProcessLifecycle({
        argv: argv ?? ['true', `--input-ipc-server=${prepared}`],
        socketPath: prepared,
        spawn: spawnFake(state),
        logger: {debug() {}, info() {}, warn() {}, error() {}},
    });
    if (lines && state.launched.length)
        state.launched.at(-1).lines = lines;
    return lifecycle;
}

test('preparePlayerSocket enforces a private runtime directory', async () => {
    const runtime = runtimePath('private');
    useRuntime(runtime);
    const socket = await preparePlayerSocket();
    const directory = Gio.File.new_for_path(socket).get_parent().get_path();
    assertEqual(mode(directory), 0o700);
    assertEqual(socket.startsWith(`${runtime}/gink-video-wallpaper/mpv-`), true);
    assertEqual(new TextEncoder().encode(socket).length <= 107, true);
    releasePlayerSocket(socket);
    restoreRuntime();
});

test('preparePlayerSocket rejects unsafe runtime paths and cancellation', async () => {
    const relative = root.get_child('relative').get_path();
    GLib.mkdir_with_parents(relative, 0o700);
    useRuntime(relative.slice(1));
    assertEqual(await rejected(preparePlayerSocket()), true);

    const loose = runtimePath('loose');
    Gio.File.new_for_path(loose).set_attribute_uint32('unix::mode', 0o755,
        Gio.FileQueryInfoFlags.NONE, null);
    useRuntime(loose);
    assertEqual(await rejected(preparePlayerSocket()), true);

    const linked = runtimePath('linked-parent');
    useRuntime(linked);
    const child = `${linked}/gink-video-wallpaper`;
    Gio.File.new_for_path(child).make_symbolic_link(loose, null);
    assertEqual(await rejected(preparePlayerSocket()), true);

    const safe = runtimePath('cancel');
    useRuntime(safe);
    const cancellable = new Gio.Cancellable();
    const pending = preparePlayerSocket({cancellable});
    cancellable.cancel();
    assertEqual(await rejected(pending), true);
    restoreRuntime();
});

test('unsafe existing directories and long UNIX paths are rejected', async () => {
    const runtime = runtimePath('unsafe-child');
    useRuntime(runtime);
    GLib.mkdir_with_parents(`${runtime}/gink-video-wallpaper`, 0o755);
    assertEqual(await rejected(preparePlayerSocket()), true);
    assertEqual(mode(`${runtime}/gink-video-wallpaper`), 0o755);
    const long = runtimePath('x'.repeat(75));
    useRuntime(long);
    assertEqual(await rejected(preparePlayerSocket()), true);
    restoreRuntime();
});

test('constructor consumes one prepared path and rejects invalid argv', async () => {
    useRuntime(runtimePath('consume'));
    const socket = await preparePlayerSocket();
    let constructed = false;
    try {
        const lifecycle = new ProcessLifecycle({
            argv: ['true'],
            socketPath: socket,
            spawn: () => ({}),
        });
        constructed = Boolean(lifecycle);
    } catch {
        constructed = false;
    }
    assertEqual(constructed, false);
    const lifecycle = await player({socketPath: socket});
    let reused = false;
    try {
        const duplicate = new ProcessLifecycle({
            argv: ['true', `--input-ipc-server=${socket}`],
            socketPath: socket,
            spawn: () => ({}),
        });
        reused = Boolean(duplicate);
    } catch {
        reused = false;
    }
    assertEqual(reused, false);
    lifecycle.terminateNow();
    await lifecycle.stop();
    restoreRuntime();
});

test('stop and terminate before start never spawn or delete files', async () => {
    const state = {launched: [], owned: {}};
    const lifecycle = await player({state});
    const first = lifecycle.stop();
    const second = lifecycle.terminateNow();
    assertEqual(second, undefined);
    const result = await first;
    assertEqual(result.status, 0);
    assertEqual(result.signaled, false);
    assertEqual(state.launched.length, 0);
    let started = false;
    try {
        lifecycle.start();
        started = true;
    } catch {
        started = false;
    }
    assertEqual(started, false);
    restoreRuntime();
});

test('callbacks, late subscriptions, stop coalescing and signaling are isolated', async () => {
    const state = {launched: [], owned: {window: true}};
    const lifecycle = await player({state});
    const seen = [];
    const callback = result => {
        seen.push(result.status);
        throw new Error('subscriber failed');
    };
    lifecycle.onExit(callback);
    lifecycle.onExit(callback);
    lifecycle.start();
    const subprocess = state.launched.at(-1);
    const stopping = lifecycle.stop({graceMs: 60000});
    await sleep(20);
    const repeated = lifecycle.stop({graceMs: 1});
    lifecycle.terminateNow();
    const result = await stopping;
    assertEqual(result, await repeated);
    assertEqual(result.status, 143);
    assertEqual(result.signaled, true);
    assertEqual(subprocess.signals.join(','), '15');
    assertEqual(subprocess.forceCount, 0);
    let lateCount = 0;
    lifecycle.onExit(() => lateCount++);
    lifecycle.onExit(() => lateCount++);
    assertEqual(lateCount, 2);
    assertEqual(seen.join(','), '143,143');
    assertEqual(lifecycle.ownsWindow(state.owned), true);
    assertEqual(lifecycle.ownsWindow({}), false);
    restoreRuntime();
});

test('terminateNow cancels grace and later stop does not signal again', async () => {
    const state = {launched: [], owned: {}};
    const lifecycle = await player({state});
    lifecycle.start();
    const subprocess = state.launched.at(-1);
    subprocess.send_signal = () => subprocess.signals.push('unexpected');
    const stopping = lifecycle.stop({graceMs: 60000});
    lifecycle.terminateNow();
    const result = await stopping;
    await lifecycle.stop({graceMs: 1});
    lifecycle.terminateNow();
    assertEqual(subprocess.forced, true);
    assertEqual(subprocess.forceCount, 1);
    assertEqual(subprocess.signals.length, 1);
    assertEqual(result.status, 137);
    assertEqual(lifecycle._graceSource, 0);
    restoreRuntime();
});

test('real subprocesses clean only their own sockets', async () => {
    const runtime = runtimePath('real');
    useRuntime(runtime);
    const socket = await preparePlayerSocket();
    const directory = Gio.File.new_for_path(socket).get_parent();
    const other = directory.get_child('other.sock');
    GLib.file_set_contents(other.get_path(), '');
    const linked = makeSocket(directory.get_path());
    const lifecycle = new ProcessLifecycle({
        argv: [GLib.find_program_in_path('true'), `--input-ipc-server=${socket}`],
        socketPath: socket,
        spawn: argv => ({subprocess: Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE)}),
    });
    const exited = new Promise(resolve => lifecycle.onExit(resolve));
    lifecycle.start();
    await exited;
    const result = await lifecycle.stop({graceMs: 1000});
    assertEqual(result.status, 0);
    assertEqual(Gio.File.new_for_path(socket).query_exists(null), false);
    assertEqual(other.query_exists(null), true);
    assertEqual(Gio.File.new_for_path(linked).query_exists(null), true);
    restoreRuntime();
});

test('no-start reentrant callbacks use the assigned reap promise', async () => {
    const lifecycle = await player();
    let reentrant;
    let callbacks = 0;
    lifecycle.onExit(result => {
        callbacks++;
        reentrant = lifecycle.stop();
        lifecycle.terminateNow();
        try {
            result.status = 999;
        } catch {
            // Frozen exit evidence cannot be changed by subscribers.
        }
    });
    lifecycle.terminateNow();
    const stopping = lifecycle.stop();
    const result = await stopping;
    assertEqual(reentrant, stopping);
    assertEqual(callbacks, 1);
    assertEqual(result.status, 0);
    assertEqual(Object.isFrozen(result), true);
    restoreRuntime();
});

test('real subprocess grace escalation reaps a TERM-ignoring child', async () => {
    useRuntime(runtimePath('real-force'));
    const path = await preparePlayerSocket();
    const lifecycle = new ProcessLifecycle({
        argv: ['/bin/sh', '-c', 'trap "" TERM; printf "ready\\n" >&2; while :; do :; done',
            `--input-ipc-server=${path}`],
        socketPath: path,
        spawn: argv => ({subprocess: Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE)}),
        logger: {debug() {}, info() {}, warn() {}, error() {}},
    });
    lifecycle.start();
    await sleep(30);
    const result = await lifecycle.stop({graceMs: 20});
    assertEqual(result.status, 137);
    assertEqual(result.signaled, true);
    assertEqual(lifecycle._stream, null);
    restoreRuntime();
});

test('cleanup deletes owned sockets and rejects regular files or symlinks', async () => {
    for (const kind of ['socket', 'file', 'link']) {
        useRuntime(runtimePath(`cleanup-${kind}`));
        const path = await preparePlayerSocket();
        let bound = null;
        const lifecycle = new ProcessLifecycle({
            argv: ['true', `--input-ipc-server=${path}`],
            socketPath: path,
            spawn: argv => {
                if (kind === 'socket') {
                    bound = Gio.Socket.new(Gio.SocketFamily.UNIX,
                        Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT);
                    bound.bind(Gio.UnixSocketAddress.new(path), false);
                } else if (kind === 'file') {
                    GLib.file_set_contents(path, 'not a socket');
                } else {
                    Gio.File.new_for_path(path).make_symbolic_link('/tmp/not-owned', null);
                }
                return {subprocess: new FakeSubprocess(argv)};
            },
            logger: {debug() {}, info() {}, warn() {}, error() {}},
        });
        lifecycle.start();
        const stopping = lifecycle.stop();
        assertEqual(await rejected(stopping), kind !== 'socket');
        const exists = (() => {
            try {
                Gio.File.new_for_path(path).query_info('standard::type',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
                return true;
            } catch {
                return false;
            }
        })();
        assertEqual(exists, kind !== 'socket');
        bound?.close();
    }
    restoreRuntime();
});

test('grace expires once and force-before-stop never requests TERM', async () => {
    const state = {launched: [], owned: {}};
    const lifecycle = await player({state});
    lifecycle.start();
    const subprocess = state.launched.at(-1);
    subprocess.send_signal = signal => subprocess.signals.push(signal);
    const first = lifecycle.stop({graceMs: 10});
    const second = lifecycle.stop({graceMs: 5000});
    assertEqual(first, second);
    assertEqual((await first).status, 137);
    assertEqual(subprocess.signals.join(','), '15');
    assertEqual(subprocess.forceCount, 1);
    const forced = await player({state});
    forced.start();
    const process = state.launched.at(-1);
    forced.terminateNow();
    forced.terminateNow();
    await forced.stop();
    assertEqual(process.signals.length, 0);
    assertEqual(process.forceCount, 1);
    restoreRuntime();
});

test('cancelled and released allocations cannot be consumed', async () => {
    useRuntime(runtimePath('cancel-allocation'));
    const cancellable = new Gio.Cancellable();
    const cancelled = await preparePlayerSocket({cancellable});
    cancellable.cancel();
    await sleep(1);
    const released = await preparePlayerSocket();
    releasePlayerSocket(released);
    for (const path of [cancelled, released]) {
        let threw = false;
        try {
            new ProcessLifecycle({argv: ['true', `--input-ipc-server=${path}`],
                socketPath: path, spawn: () => ({})});
        } catch {
            threw = true;
        }
        assertEqual(threw, true);
    }
    restoreRuntime();
});

test('reentrant stop shares one reap and unsubscribed callbacks are skipped', async () => {
    const state = {launched: [], owned: {}};
    const lifecycle = await player({state});
    let calls = 0;
    let unsubscribe = () => {};
    lifecycle.onExit(() => {
        calls++;
        unsubscribe();
        lifecycle.stop();
        lifecycle.terminateNow();
    });
    unsubscribe = lifecycle.onExit(() => {
        calls++;
    });
    lifecycle.start();
    const first = lifecycle.stop({graceMs: 5000});
    const result = await first;
    assertEqual(await lifecycle.stop(), result);
    assertEqual(calls, 1);
    assertEqual(state.launched.at(-1).forceCount, 0);
    restoreRuntime();
});

test('spawn failure settles without signaling and stderr is logged', async () => {
    useRuntime(runtimePath('spawn-failure'));
    const socket = await preparePlayerSocket();
    const logged = [];
    const lifecycle = new ProcessLifecycle({
        argv: ['true', `--input-ipc-server=${socket}`],
        socketPath: socket,
        spawn: () => {
            throw new Error('spawn failed');
        },
        logger: {debug: line => logged.push(line), info() {}, warn() {}, error() {}},
    });
    let failed = false;
    try {
        lifecycle.start();
    } catch (error) {
        failed = error.message === 'spawn failed';
    }
    const result = await lifecycle.stop({graceMs: 1});
    assertEqual(failed, true);
    assertEqual(result.status, 0);
    assertEqual(result.signaled, false);

    useRuntime(runtimePath('stderr'));
    const stderrSocket = await preparePlayerSocket();
    const messages = [];
    const reading = new ProcessLifecycle({
        argv: ['true', `--input-ipc-server=${stderrSocket}`],
        socketPath: stderrSocket,
        spawn: argv => ({subprocess: new FakeSubprocess(argv)}),
        logger: {debug: line => messages.push(line), info() {}, warn() {}, error() {}},
    });
    reading.start();
    await reading.stop({graceMs: 1000});
    assertEqual(messages.includes('player warning'), true);
    restoreRuntime();
});

await run().finally(() => {
    restoreRuntime();
    const removeTree = file => {
        if (!file.get_path().startsWith(`${root.get_path()}/`) &&
            !file.equal(root))
            throw new Error('refusing cleanup outside the test root');
        const info = file.query_info('standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            const enumerator = file.enumerate_children('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let child;
            while ((child = enumerator.next_file(null)))
                removeTree(file.get_child(child.get_name()));
            enumerator.close(null);
        }
        file.delete(null);
    };
    removeTree(root);
});
