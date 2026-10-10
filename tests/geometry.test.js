import {
    computePlacement,
    ffmpegScaleFilter,
    computeCanvas,
    FitMode,
    TRANSFORM_VERSION,
} from '../lib/geometry.js';
import {test, assertEqual, assertDeepEqual, assertThrows, run} from './harness.js';

test('constants', () => {
    assertEqual(TRANSFORM_VERSION, 1, 'transform version');
    assertEqual(FitMode.FILL, 'fill');
    assertEqual(FitMode.FIT, 'fit');
    assertEqual(FitMode.STRETCH, 'stretch');
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
    assertThrows(() => computeCanvas([], 1));
});

test('computeCanvas handles adjacent monitors and common scale', () => {
    const monitors = [
        {key: 'eDP-1', x: 0, y: 0, width: 1920, height: 1080},
        {key: 'HDMI-1', x: 1920, y: 0, width: 2560, height: 1440},
    ];
    const canvas = computeCanvas(monitors, 1.5);
    assertEqual(canvas.width, (1920 + 2560) * 1.5);
    assertEqual(canvas.height, 1440 * 1.5);
    assertEqual(canvas.rectangles[0].width, 1920 * 1.5);
    assertEqual(canvas.rectangles[1].x, canvas.rectangles[0].x + canvas.rectangles[0].width);
});

test('computeCanvas deduplicates shared edges without gaps', () => {
    const monitors = [
        {key: 'left', x: -1000, y: -500, width: 1000, height: 1000},
        {key: 'right', x: 0, y: -500, width: 1000, height: 1000},
    ];
    const canvas = computeCanvas(monitors, 1.25);
    assertEqual(canvas.rectangles[0].x + canvas.rectangles[0].width, canvas.rectangles[1].x);
    assertEqual(canvas.width, 2000 * 1.25);
});

await run();
