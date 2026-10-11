import GLib from 'gi://GLib';

import {selectConfigured} from './config.js';
import {computeCanvas, TRANSFORM_VERSION, targetGeometry} from './geometry.js';
import {createLogger} from './log.js';

export const MONITOR_DEBOUNCE_MS = 1000;
export const MONITOR_SIGNAL = 'monitors-changed';

export function planTargets({physicalMonitors, logicalMonitors}, configs,
    {defaultFitMode, optimizeVideos, vo, monitorIndexFor, fileFor = (_id, config) => config.file, logger = null}) {
    const plans = [];
    const ordered = [...logicalMonitors].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    for (const logical of ordered) {
        const chosen = selectConfigured(logical.connectors, physicalMonitors, configs);
        if (!chosen)
            continue;
        const monitorIndex = monitorIndexFor(logical.connectors[0]);
        if (!Number.isInteger(monitorIndex) || monitorIndex < 0) {
            logger?.warn(`logical monitor ${logical.key} has no layout index yet; skipping`);
            continue;
        }
        const {physical, config} = chosen;
        const fitMode = config.fitMode ?? defaultFitMode;
        plans.push({
            logicalMonitorKey: logical.key,
            selectedPhysicalMonitorId: physical.id,
            monitorIndex,
            placement: {x: logical.x, y: logical.y, width: logical.width, height: logical.height,
                scale: logical.scale, transform: logical.transform},
            file: fileFor(physical.id, config),
            optimize: config.optimize ?? optimizeVideos,
            vo,
            geometry: targetGeometry(logical, fitMode),
        });
    }
    return plans;
}

export function planWallpaper({logicalMonitors}) {
    const ordered = [...logicalMonitors].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    if (ordered.length < 2)
        return null;
    return {...computeCanvas(ordered, Math.max(...ordered.map(monitor => monitor.scale))),
        transformVersion: TRANSFORM_VERSION,
        transforms: ordered.map(({key, transform}) => [key, transform])};
}

export function selectionKey(plan, asset) {
    return JSON.stringify([plan.selectedPhysicalMonitorId, plan.file, plan.geometry, plan.optimize, asset, plan.vo,
        plan.monitorIndex, plan.placement]);
}

export class MonitorWatcher {
    constructor({sources, onChange, debounceMs = MONITOR_DEBOUNCE_MS, logger = createLogger('monitors')}) {
        this._sources = sources.filter(Boolean);
        this._onChange = onChange;
        this._debounceMs = debounceMs;
        this._log = logger;
        this._handlers = [];
        this._timer = 0;
        this._generation = 0;
    }

    enable() {
        if (this._handlers.length > 0)
            return;
        const generation = ++this._generation;
        this._handlers = this._sources.map(source =>
            [source, source.connect(MONITOR_SIGNAL, () => this._queue(generation))]);
    }

    disable() {
        this._generation++;
        for (const [source, id] of this._handlers)
            source.disconnect(id);
        this._handlers = [];
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
    }

    _queue(generation) {
        if (generation !== this._generation)
            return;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._debounceMs, () => {
            this._timer = 0;
            if (generation !== this._generation)
                return GLib.SOURCE_REMOVE;
            this._log.debug('monitor configuration changed; reconciling');
            try {
                this._onChange();
            } catch (error) {
                this._log.error(`monitor change handler failed: ${error.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }
}
