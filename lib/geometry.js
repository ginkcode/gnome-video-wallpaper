export const FitMode = {FILL: 'fill', FIT: 'fit', STRETCH: 'stretch'};
export const TRANSFORM_VERSION = 1;

function round(value) {
    return Math.round(value);
}

function requirePositive(name, value) {
    if (!Number.isFinite(value) || value <= 0)
        throw new Error(`${name} must be a positive number`);
}

export function computePlacement(srcW, srcH, dstW, dstH, mode) {
    requirePositive('srcW', srcW);
    requirePositive('srcH', srcH);
    requirePositive('dstW', dstW);
    requirePositive('dstH', dstH);
    if (mode === FitMode.STRETCH)
        return {x: 0, y: 0, width: round(dstW), height: round(dstH)};
    if (mode !== FitMode.FILL && mode !== FitMode.FIT)
        throw new Error(`unknown fit mode ${mode}`);

    const scale = mode === FitMode.FILL
        ? Math.max(dstW / srcW, dstH / srcH)
        : Math.min(dstW / srcW, dstH / srcH);
    const width = round(srcW * scale);
    const height = round(srcH * scale);
    return {
        x: round((dstW - width) / 2),
        y: round((dstH - height) / 2),
        width,
        height,
    };
}

export function ffmpegScaleFilter(dstW, dstH, mode) {
    const width = round(dstW);
    const height = round(dstH);
    requirePositive('dstW', width);
    requirePositive('dstH', height);
    if (mode === FitMode.FILL) {
        return `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`;
    }
    if (mode === FitMode.FIT) {
        return `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
    }
    if (mode === FitMode.STRETCH)
        return `scale=${width}:${height}:flags=lanczos`;
    throw new Error(`unknown fit mode ${mode}`);
}

function edge(value) {
    return round(value);
}

export function computeCanvas(logicalMonitors, rasterScale) {
    requirePositive('rasterScale', rasterScale);
    if (!Array.isArray(logicalMonitors) || logicalMonitors.length === 0)
        throw new Error('logicalMonitors must be a non-empty array');

    for (const monitor of logicalMonitors) {
        if (!Number.isFinite(monitor.x) || !Number.isFinite(monitor.y))
            throw new Error('monitor coordinates must be finite');
        requirePositive('monitor width', monitor.width);
        requirePositive('monitor height', monitor.height);
    }
    const minX = Math.min(...logicalMonitors.map(monitor => monitor.x));
    const minY = Math.min(...logicalMonitors.map(monitor => monitor.y));
    const maxX = Math.max(...logicalMonitors.map(monitor => monitor.x + monitor.width));
    const maxY = Math.max(...logicalMonitors.map(monitor => monitor.y + monitor.height));
    const xEdges = new Map();
    const yEdges = new Map();
    const snap = (value, edges) => {
        const origin = edges === xEdges ? minX : minY;
        if (!edges.has(value))
            edges.set(value, edge((value - origin) * rasterScale));
        return edges.get(value);
    };
    for (const monitor of logicalMonitors) {
        snap(monitor.x, xEdges);
        snap(monitor.x + monitor.width, xEdges);
        snap(monitor.y, yEdges);
        snap(monitor.y + monitor.height, yEdges);
    }
    const originX = snap(minX, xEdges);
    const originY = snap(minY, yEdges);
    return {
        originX: minX,
        originY: minY,
        width: snap(maxX, xEdges) - originX,
        height: snap(maxY, yEdges) - originY,
        rasterScale,
        rectangles: logicalMonitors.map(monitor => {
            const x = snap(monitor.x, xEdges) - originX;
            const y = snap(monitor.y, yEdges) - originY;
            return {
                key: monitor.key,
                x,
                y,
                width: snap(monitor.x + monitor.width, xEdges) - originX - x,
                height: snap(monitor.y + monitor.height, yEdges) - originY - y,
            };
        }),
    };
}
