import {cacheKey} from '../lib/cacheKey.js';
import {assertEqual, assertThrows, run, test} from './harness.js';

const base = {path: '/videos/a.mp4', size: 100, mtime: 1700000000000000, width: 1920, height: 1080,
    scale: 1, fitMode: 'fill', transformVersion: 1, kind: 'still', assetIdentity: 'original:/videos/a.mp4'};

test('key is a stable SHA-256 hex digest', () => {
    const key = cacheKey(base);
    assertEqual(/^[0-9a-f]{64}$/.test(key), true, 'hex digest');
    assertEqual(cacheKey({...base}), key, 'stable');
});

test('every identity field changes the key', () => {
    const key = cacheKey(base);
    const changes = {path: '/videos/b.mp4', size: 101, mtime: 1700000000000001, width: 1280, height: 720,
        scale: 2, fitMode: 'fit', transformVersion: 2, kind: 'media', assetIdentity: 'optimized:/c/x.mp4'};
    for (const [field, value] of Object.entries(changes))
        assertEqual(cacheKey({...base, [field]: value}) !== key, true, field);
});

test('invalid input is rejected', () => {
    assertThrows(() => cacheKey({...base, kind: 'other'}), 'kind');
    assertThrows(() => cacheKey({...base, path: ''}), 'path');
    assertThrows(() => cacheKey({...base, mtime: NaN}), 'mtime');
});

await run();
