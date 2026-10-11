import GLib from 'gi://GLib';

import {Disposables} from './disposables.js';
import {createLogger} from './log.js';

export const COVERED = 'covered';
const DEBOUNCE_MS = 200;
const WINDOW_SIGNALS = ['notify::maximized-horizontally', 'notify::maximized-vertically', 'notify::fullscreen',
    'notify::minimized', 'position-changed', 'workspace-changed'];

export function coveredMonitors(windows, {workspace, isOwn, normalType, maximizeBoth}) {
    const covered = new Set();
    for (const window of windows) {
        if (window.minimized || window.get_window_type() !== normalType || isOwn(window) ||
            !window.located_on_workspace(workspace))
            continue;
        if (window.is_fullscreen() || window.get_maximize_flags() === maximizeBoth)
            covered.add(window.get_monitor());
    }
    return covered;
}

export class CoverageController {
    constructor({playerManager, settings, display, workspaceManager, normalType, maximizeBoth,
        debounceMs = DEBOUNCE_MS, logger = createLogger('coverage')}) {
        this._manager = playerManager;
        this._settings = settings;
        this._display = display;
        this._workspaces = workspaceManager;
        this._normalType = normalType;
        this._maximizeBoth = maximizeBoth;
        this._debounceMs = debounceMs;
        this._log = logger;
        this._disposables = null;
        this._windows = new Map();
        this._applied = new Map();
        this._timer = 0;
    }

    enable() {
        if (this._disposables)
            throw new Error('CoverageController is already enabled');
        const disposables = new Disposables();
        this._disposables = disposables;
        const schedule = () => this._schedule();
        disposables.connect(this._settings, 'changed::pause-on-maximized', schedule);
        disposables.connect(this._display, 'window-created', (_display, window) => {
            this._track(window);
            schedule();
        });
        disposables.connect(this._display, 'in-fullscreen-changed', schedule);
        disposables.connect(this._display, 'restacked', schedule);
        disposables.connect(this._workspaces, 'active-workspace-changed', schedule);
        disposables.add(this._manager.onTargets(() => {
            this._applied.clear();
            this._recompute();
        }));
        disposables.add(() => {
            for (const window of [...this._windows.keys()])
                this._untrack(window);
        });
        for (const window of this._display.list_all_windows())
            this._track(window);
        this._recompute();
    }

    disable() {
        this._disposables?.dispose();
        this._disposables = null;
        this._timer = 0;
        this._applied.clear();
    }

    _track(window) {
        if (this._windows.has(window))
            return;
        const ids = WINDOW_SIGNALS.map(signal => window.connect(signal, () => this._schedule()));
        ids.push(window.connect('unmanaged', () => {
            this._untrack(window);
            this._schedule();
        }));
        this._windows.set(window, ids);
    }

    _untrack(window) {
        for (const id of this._windows.get(window) ?? [])
            window.disconnect(id);
        this._windows.delete(window);
    }

    _schedule() {
        if (this._timer || !this._disposables)
            return;
        this._timer = this._disposables.timeout(this._debounceMs, () => {
            this._timer = 0;
            this._recompute();
            return GLib.SOURCE_REMOVE;
        });
    }

    _recompute() {
        const covered = this._settings.get_boolean('pause-on-maximized')
            ? coveredMonitors(this._display.list_all_windows(), {
                workspace: this._workspaces.get_active_workspace(),
                isOwn: window => this._manager.ownsWindow(window),
                normalType: this._normalType, maximizeBoth: this._maximizeBoth,
            })
            : new Set();
        for (const {logicalMonitorKey: key, monitorIndex} of this._manager.targets) {
            const paused = covered.has(monitorIndex);
            if (this._applied.get(key) === paused)
                continue;
            this._applied.set(key, paused);
            this._log.debug(`${key} ${paused ? 'covered' : 'uncovered'}`);
            this._manager.setPaused(key, COVERED, paused);
        }
    }
}
