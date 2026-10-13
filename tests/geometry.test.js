import {
    computePlacement,
    ffmpegScaleFilter,
    FitMode,
    TRANSFORM_VERSION,
    targetGeometry,
} from '../lib/geometry.js';
import {test, assertEqual, assertDeepEqual, assertThrows, run} from './harness.js';

test('constants', () => {
    assertEqual(TRANSFORM_VERSION, 1, 'transform version');
    assertEqual(FitMode.FILL, 'fill');
    assertEqual(FitMode.FIT, 'fit');
    assertEqual(FitMode.STRETCH, 'stretch');
});

test('target geometry is the scaled logical raster', () => {
    assertDeepEqual(targetGeometry({width: 1707, height: 960, scale: 1.5}, FitMode.FIT),
        {width: 2561, height: 1440, scale: 1.5, fitMode: 'fit', transformVersion: TRANSFORM_VERSION});
});

test('fill mode crops excess dimension', () => {
    const wide = computePlacement(1920, 1080, 1920, 1200, FitMode.FILL);
    assertEqual(wide.width, 2133);
    assertEqual(wide.height, 1200);
    assertEqual(wide.x, -106);
    assertEqual(wide.y, 0);

    const narrow = computePlacement(1920, 1080, 1200, 1200, FitMode.FILL);
    assertEqual(narrow.width, 2133);
    assertEqual(narrow.height, 1200);
    assertEqual(narrow.x, -466);
    assertEqual(narrow.y, 0);
});

test('fit mode letterboxes and pillarboxes', () => {
    const wide = computePlacement(1920, 1080, 1920, 1200, FitMode.FIT);
    assertEqual(wide.width, 1920);
    assertEqual(wide.height, 1080);
    assertEqual(wide.x, 0);
    assertEqual(wide.y, 60);

    const tall = computePlacement(1920, 1080, 1200, 1200, FitMode.FIT);
    assertEqual(tall.width, 1200);
    assertEqual(tall.height, 675);
    assertEqual(tall.x, 0);
    assertEqual(tall.y, 263);
});

test('stretch mode fills target rectangle exactly', () => {
    assertDeepEqual(
        computePlacement(1920, 1080, 1200, 1600, FitMode.STRETCH),
        {x: 0, y: 0, width: 1200, height: 1600}
    );
});

test('ffmpeg filters match specs', () => {
    assertEqual(
        ffmpegScaleFilter(1920, 1080, FitMode.FILL),
        'scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080'
    );
    assertEqual(
        ffmpegScaleFilter(1920, 1080, FitMode.FIT),
        'scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black'
    );
    assertEqual(
        ffmpegScaleFilter(1920, 1080, FitMode.STRETCH),
        'scale=1920:1080:flags=lanczos'
    );
});

test('invalid arguments throw', () => {
    assertThrows(() => computePlacement(0, 100, 100, 100, FitMode.FILL));
    assertThrows(() => computePlacement(100, 100, 100, 100, 'invalid'));
    assertThrows(() => ffmpegScaleFilter(0, 100, FitMode.FILL));
});

await run();
