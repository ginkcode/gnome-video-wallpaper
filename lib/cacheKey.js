import GLib from 'gi://GLib';

const KINDS = new Set(['still', 'native', 'media']);

export function cacheKey({path, size, mtime, width, height, scale, fitMode, transformVersion, kind,
    assetIdentity}) {
    if (!KINDS.has(kind))
        throw new Error(`unknown cache kind ${kind}`);
    if (typeof path !== 'string' || !path)
        throw new Error('cache key needs a source path');
    for (const [name, value] of Object.entries({size, mtime, width, height, scale, transformVersion})) {
        if (!Number.isFinite(value) || value < 0)
            throw new Error(`cache key ${name} must be a finite number`);
    }
    const parts = [kind, path, size, mtime, width, height, scale, fitMode ?? null, transformVersion,
        assetIdentity ?? null];
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, JSON.stringify(parts), -1);
}
