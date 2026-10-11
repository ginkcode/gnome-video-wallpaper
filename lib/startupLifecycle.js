import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function cancelled() {
    return new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Startup wait cancelled');
}

// Connecting before reading _startingUp means a completion racing the check is
// observed either by the flag or by the signal.
export function waitForStartupOn(layoutManager, {delayMs = 0, cancellable = null, onComplete = null} = {}) {
    if (!Number.isFinite(delayMs) || delayMs < 0)
        return Promise.reject(new Error('delayMs must be a finite nonnegative number'));
    return new Promise((resolve, reject) => {
        if (cancellable?.is_cancelled()) {
            reject(cancelled());
            return;
        }
        let signalId = 0;
        let sourceId = 0;
        let cancelId = 0;
        let settled = false;
        const cleanup = () => {
            settled = true;
            if (signalId) {
                layoutManager.disconnect(signalId);
                signalId = 0;
            }
            if (sourceId) {
                GLib.source_remove(sourceId);
                sourceId = 0;
            }
        };
        const complete = () => {
            if (settled || sourceId)
                return;
            if (signalId) {
                layoutManager.disconnect(signalId);
                signalId = 0;
            }
            onComplete?.();
            sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(delayMs), () => {
                sourceId = 0;
                cleanup();
                if (cancelId)
                    cancellable.disconnect(cancelId);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        };
        signalId = layoutManager.connect('startup-complete', complete);
        if (cancellable) {
            cancelId = cancellable.connect(() => {
                if (settled)
                    return;
                cleanup();
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    cancellable.disconnect(cancelId);
                    return GLib.SOURCE_REMOVE;
                });
                reject(cancelled());
            });
        }
        if (!layoutManager._startingUp)
            complete();
    });
}
