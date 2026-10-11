import {targetGeometry} from '../lib/geometry.js';

function byPosition(a, b) {
    return Number(b.primary) - Number(a.primary) || a.y - b.y || a.x - b.x;
}

export function describeMonitorId(id) {
    const [connector = '', vendor = '', product = '', ...serial] = id.split(':');
    const name = [vendor, product].filter(Boolean).join(' ');
    return {connector, title: name || connector || id, serial: serial.join(':')};
}

export function buildMonitorModel({physicalMonitors, logicalMonitors}, configs) {
    const byConnector = new Map(physicalMonitors.map(monitor => [monitor.connector, monitor]));
    const shown = new Set();
    const groups = [...logicalMonitors].sort(byPosition).map(logical => {
        const physical = logical.connectors.map(connector => byConnector.get(connector)).filter(Boolean);
        const effective = physical.find(monitor => configs[monitor.id]) ?? null;
        for (const monitor of physical)
            shown.add(monitor.id);
        return {
            logical,
            mirrored: physical.length > 1,
            effectiveId: effective?.id ?? null,
            members: physical.map(monitor => ({
                physical: monitor,
                config: configs[monitor.id] ?? null,
                effective: monitor.id === effective?.id,
            })),
        };
    });
    const others = Object.keys(configs).filter(id => !shown.has(id)).sort()
        .map(id => ({id, config: configs[id], ...describeMonitorId(id)}));
    return {groups, others};
}

export function modelLayout({groups, others}) {
    return JSON.stringify([
        groups.map(({logical, members}) => [logical.key, logical.width, logical.height, logical.scale,
            members.map(({physical}) => [physical.id, physical.displayName, physical.modeWidth, physical.modeHeight])]),
        others.map(other => other.id),
    ]);
}

function validRaster({width, height}) {
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;
}

export async function applySelection({files, added = files, logical, defaultFitMode, probe, readConfig, writeConfig,
    prepare = null, cancellable}) {
    const current = readConfig();
    const fitMode = current?.fitMode ?? null;
    const geometry = targetGeometry(logical, fitMode ?? defaultFitMode());
    if (!validRaster(geometry))
        throw new Error('This display reports an invalid size. Reconnect it and try again.');
    const media = [];
    for (const file of added) {
        media.push(await probe(file, cancellable));
        cancellable.set_error_if_cancelled();
    }
    if (prepare) {
        for (const [index, file] of added.entries()) {
            await prepare(media[index], geometry, {file, fitMode, optimize: current?.optimize ?? null}, cancellable);
            cancellable.set_error_if_cancelled();
        }
    }
    const latest = readConfig();
    writeConfig({files, fitMode: latest?.fitMode ?? null, optimize: latest?.optimize ?? null});
    return {media, geometry};
}

export function editPlaylist(files, {add = [], remove = null, raise = null} = {}) {
    let result = [...files, ...add.filter(file => !files.includes(file))];
    if (remove !== null)
        result = result.filter(file => file !== remove);
    const index = raise === null ? -1 : result.indexOf(raise);
    if (index > 0)
        result.splice(index - 1, 2, result[index], result[index - 1]);
    return [...new Set(result)];
}

export async function loadPreview({file, geometry, probe, acquire, ensureStill, release, optimizedPathFor = () => null,
    cancellable}) {
    const media = await probe(file, cancellable);
    const asset = await acquire(media, geometry, {cancellable, optimizedPath: optimizedPathFor(media, geometry)});
    try {
        return await ensureStill(asset, geometry, cancellable);
    } finally {
        await release(asset);
    }
}
