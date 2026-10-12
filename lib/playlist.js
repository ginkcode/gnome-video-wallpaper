import GLib from 'gi://GLib';

import {Disposables} from './disposables.js';
import {createLogger} from './log.js';

function readPositions(settings) {
    try {
        const positions = JSON.parse(settings.get_string('playlist-state'));
        return positions && typeof positions === 'object' && !Array.isArray(positions) ? positions : {};
    } catch {
        return {};
    }
}

export function nextIndex(index, count, order, random = Math.random) {
    if (count < 2)
        return 0;
    if (order !== 'random')
        return (index + 1) % count;
    const pick = Math.floor(random() * (count - 1));
    return pick >= index ? pick + 1 : pick;
}

export class Playlist {
    constructor({settings, onChange, random = Math.random, minuteMs = 60000, logger = createLogger('playlist')}) {
        this._settings = settings;
        this._onChange = onChange;
        this._random = random;
        this._minuteMs = minuteMs;
        this._log = logger;
        this._entries = new Map();
        this._disposables = null;
        this._timer = 0;
    }

    enable() {
        if (this._disposables)
            throw new Error('Playlist is already enabled');
        this._disposables = new Disposables();
        this._disposables.connect(this._settings, 'changed::playlist-interval-minutes', () => this._schedule());
        this._disposables.add(() => this._clearTimer());
        this._schedule();
    }

    disable() {
        this._disposables?.dispose();
        this._disposables = null;
        this._entries.clear();
    }

    fileFor(id, files) {
        if (files.length < 2) {
            this._entries.delete(id);
            this._persist(id, undefined);
            return files[0];
        }
        const key = JSON.stringify(files);
        let entry = this._entries.get(id);
        if (entry?.key !== key) {
            const current = entry?.file ?? readPositions(this._settings)[id];
            const index = files.indexOf(current);
            entry = {key, files, index: index >= 0 ? index : this._initialIndex(files.length)};
            entry.file = files[entry.index];
            this._entries.set(id, entry);
            this._persist(id, entry.file);
        }
        return entry.file;
    }

    advance() {
        if (this._entries.size === 0)
            return false;
        const order = this._settings.get_string('playlist-order');
        const positions = readPositions(this._settings);
        for (const [id, entry] of this._entries) {
            entry.index = nextIndex(entry.index, entry.files.length, order, this._random);
            entry.file = entry.files[entry.index];
            positions[id] = entry.file;
            this._log.debug(`${id} next ${entry.file}`);
        }
        this._settings.set_string('playlist-state', JSON.stringify(positions));
        this._onChange();
        return true;
    }

    // Preferences show the stored position, so every pick is stored, not only advances.
    _persist(id, file) {
        const positions = readPositions(this._settings);
        if (positions[id] === file)
            return;
        if (file === undefined)
            delete positions[id];
        else
            positions[id] = file;
        this._settings.set_string('playlist-state', JSON.stringify(positions));
    }

    _initialIndex(count) {
        return this._settings.get_string('playlist-order') === 'random' ? Math.floor(this._random() * count) : 0;
    }

    _schedule() {
        this._clearTimer();
        const ms = Math.max(1, this._settings.get_uint('playlist-interval-minutes')) * this._minuteMs;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (!this._settings.get_boolean('paused'))
                this.advance();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _clearTimer() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }
}
