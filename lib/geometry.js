export const FitMode = {FILL: 'fill', FIT: 'fit', STRETCH: 'stretch'};
export const TRANSFORM_VERSION = 1;

export function targetGeometry({width, height, scale}, fitMode) {
    return {width: Math.round(width * scale), height: Math.round(height * scale), scale,
        fitMode, transformVersion: TRANSFORM_VERSION};
}

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
