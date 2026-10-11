import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {makeDir} from './cacheFs.js';
import {createLogger} from './log.js';

export const LIVE_KEYS = ['monitor-configs', 'default-fit-mode', 'video-output', 'optimize-videos'];
const APPEARED = new Set([Gio.FileMonitorEvent.CREATED, Gio.FileMonitorEvent.MOVED_IN, Gio.FileMonitorEvent.RENAMED]);

export class LiveSettings {
    constructor({settings, onChange, debounceMs = 300, directories = [], logger = createLogger('live-settings')}) {
        this._settings = settings;
        this._log = logger;
        this._onChange = onChange;
        this._debounceMs = debounceMs;
        this._directories = directories;
        this._handlers = [];
        this._monitors = [];
        this._timer = 0;
        this._cancellable = null;
    }

    enable() {
        if (this._handlers.length > 0)
            return;
        this._handlers = LIVE_KEYS.map(key => this._settings.connect(`changed::${key}`, () => this._queue()));
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        for (const path of this._directories) {
            this._watch(path, cancellable).catch(error => {
                if (!cancellable.is_cancelled())
                    this._log.warn(`cannot watch ${path}: ${error.message}`);
            });
        }
    }

    async _watch(path, cancellable) {
        await makeDir(path, cancellable);
        cancellable.set_error_if_cancelled();
        const monitor = Gio.File.new_for_path(path).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, cancellable);
        monitor.connect('changed', (_monitor, _file, _other, event) => {
            if (APPEARED.has(event))
                this._queue();
        });
        this._monitors.push(monitor);
    }

    disable() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
        this._cancellable?.cancel();
        this._cancellable = null;
        for (const monitor of this._monitors)
            monitor.cancel();
        this._monitors = [];
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
    }

    _queue() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._debounceMs, () => {
            this._timer = 0;
            this._onChange();
            return GLib.SOURCE_REMOVE;
        });
    }
}
