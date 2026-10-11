import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export function cancelledError() {
    return new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'Operation was cancelled');
}

export class SharedWork {
    constructor() {
        this._pending = new Map();
    }

    async run(key, work, cancellable = null) {
        cancellable?.set_error_if_cancelled();
        let entry = this._pending.get(key);
        if (!entry) {
            const shared = new Gio.Cancellable();
            entry = {cancellable: shared, waiters: 0};
            entry.promise = work(shared).finally(() => {
                if (this._pending.get(key) === entry)
                    this._pending.delete(key);
            });
            entry.promise.catch(() => {});
            this._pending.set(key, entry);
        }
        entry.waiters++;
        let handlerId = 0;
        try {
            const cancelled = new Promise((_, reject) => {
                handlerId = cancellable?.connect(() => reject(cancelledError())) ?? 0;
            });
            return await Promise.race([entry.promise, cancelled]);
        } finally {
            if (handlerId)
                cancellable.disconnect(handlerId);
            if (--entry.waiters === 0 && this._pending.get(key) === entry) {
                this._pending.delete(key);
                entry.cancellable.cancel();
            }
        }
    }
}
