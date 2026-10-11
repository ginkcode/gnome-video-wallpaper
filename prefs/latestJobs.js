import Gio from 'gi://Gio';

function isCancelledError(error) {
    return error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) === true;
}

export class LatestJobs {
    constructor() {
        this._slots = new Map();
        this._closed = false;
    }

    get pending() {
        return this._slots.size;
    }

    async run(key, task) {
        if (this._closed)
            return {cancelled: true};
        this._slots.get(key)?.cancel();
        const cancellable = new Gio.Cancellable();
        this._slots.set(key, cancellable);
        try {
            const value = await task(cancellable);
            return cancellable.is_cancelled() ? {cancelled: true} : {value};
        } catch (error) {
            return cancellable.is_cancelled() || isCancelledError(error) ? {cancelled: true} : {error};
        } finally {
            if (this._slots.get(key) === cancellable)
                this._slots.delete(key);
        }
    }

    cancel(key) {
        this._slots.get(key)?.cancel();
        this._slots.delete(key);
    }

    close() {
        this._closed = true;
        for (const cancellable of this._slots.values())
            cancellable.cancel();
        this._slots.clear();
    }
}
