import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async', 'wait_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'make_directory_async', 'make_directory_finish');
Gio._promisify(Gio.DBusProxy.prototype, 'call', 'call_finish');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish_utf8');

export async function spawnAsync(argv, {cancellable = null, stdout = true, stderr = true} = {}) {
    cancellable?.set_error_if_cancelled();
    const flags =
        (stdout ? Gio.SubprocessFlags.STDOUT_PIPE : Gio.SubprocessFlags.STDOUT_SILENCE) |
        (stderr ? Gio.SubprocessFlags.STDERR_PIPE : Gio.SubprocessFlags.STDERR_SILENCE);
    const subprocess = Gio.Subprocess.new(argv, flags);
    const handlerId = cancellable?.connect(() => subprocess.force_exit()) ?? 0;
    try {
        const [out, err] = await subprocess.communicate_utf8_async(null, cancellable);
        const status = subprocess.get_if_signaled()
            ? 128 + subprocess.get_term_sig()
            : subprocess.get_exit_status();
        return {status, stdout: out ?? '', stderr: err ?? ''};
    } catch (error) {
        subprocess.force_exit();
        await subprocess.wait_async(null);
        throw error;
    } finally {
        if (handlerId)
            cancellable.disconnect(handlerId);
    }
}

export async function spawnLines(argv, {cancellable = null, onLine = () => {}} = {}) {
    cancellable?.set_error_if_cancelled();
    const subprocess = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    const handlerId = cancellable?.connect(() => subprocess.force_exit()) ?? 0;
    const stream = new Gio.DataInputStream({base_stream: subprocess.get_stdout_pipe(), close_base_stream: true});
    try {
        for (;;) {
            const [line] = await stream.read_line_async(GLib.PRIORITY_LOW, null);
            if (line === null)
                break;
            onLine(line);
        }
        await subprocess.wait_async(null);
        cancellable?.set_error_if_cancelled();
        return subprocess.get_if_signaled() ? 128 + subprocess.get_term_sig() : subprocess.get_exit_status();
    } catch (error) {
        subprocess.force_exit();
        await subprocess.wait_async(null);
        throw error;
    } finally {
        if (handlerId)
            cancellable.disconnect(handlerId);
    }
}

export function sleep(ms, cancellable = null) {
    return new Promise((resolve, reject) => {
        cancellable?.set_error_if_cancelled();
        let handlerId = 0;
        let sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            sourceId = 0;
            if (handlerId)
                cancellable.disconnect(handlerId);
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        handlerId = cancellable?.connect(() => {
            if (sourceId) {
                GLib.source_remove(sourceId);
                sourceId = 0;
            }
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (handlerId)
                    cancellable.disconnect(handlerId);
                return GLib.SOURCE_REMOVE;
            });
            reject(new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED,
                'Operation was cancelled'));
        }) ?? 0;
    });
}

export function waitUntil(object, signal, isReady, cancellable = null) {
    return new Promise((resolve, reject) => {
        cancellable?.set_error_if_cancelled();
        if (isReady()) {
            resolve();
            return;
        }
        let cancelId = 0;
        const signalId = object.connect(signal, () => {
            if (!isReady())
                return;
            object.disconnect(signalId);
            if (cancelId)
                cancellable.disconnect(cancelId);
            resolve();
        });
        cancelId = cancellable?.connect(() => {
            object.disconnect(signalId);
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                cancellable.disconnect(cancelId);
                return GLib.SOURCE_REMOVE;
            });
            reject(new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Operation was cancelled'));
        }) ?? 0;
    });
}
