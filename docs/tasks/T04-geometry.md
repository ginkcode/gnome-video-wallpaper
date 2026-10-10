# T04 — Geometry (fit modes) and unit test runner

- **Milestone:** M1
- **Depends on:** T01
- **Status:** todo
- **Owner:**
- **Skills:** JS, basic math

## Goal

Single source of truth for normalized display geometry and target raster fitting, shared by playback (T07) and ffmpeg stills (T12). Target tested SDR perceptual continuity, not pixel identity across ffmpeg/mpv/compositor pipelines. Export `TRANSFORM_VERSION = 1`; normalize SAR and rotation before fitting and interpret SDR metadata consistently.

## Deliverables

- `tests/harness.js` — tiny assertion lib (`test(name, fn)`, `assertEqual`, `assertDeepEqual`, `assertThrows`, async support) and a runner that prints results and sets exit code. Used by all `tests/*.test.js`.
- `lib/geometry.js` — per [interfaces.md](interfaces.md#libgeometryjs-t04-pure).
  - `FILL`: scale = max(dstW/srcW, dstH/srcH), centered (crop).
  - `FIT`: scale = min(...), centered, black bars.
  - `STRETCH`: rect = full dst.
  - Round to integer pixels consistently (document rounding in a test).
  - `ffmpegScaleFilter`:
    - FILL → `scale=W:H:force_original_aspect_ratio=increase:flags=lanczos,crop=W:H`
    - FIT → `scale=W:H:force_original_aspect_ratio=decrease:flags=lanczos,pad=W:H:(ow-iw)/2:(oh-ih)/2:black`
    - STRETCH → `scale=W:H:flags=lanczos`
  - `computeCanvas(logicalMonitors, rasterScale)`: canvas bounds are the union of logical rectangles, translated by the minimum x/y and rasterized at one common scale (caller policy uses the maximum logical scale across connected monitors). Round shared edges once so adjacent rectangles cannot develop gaps/overlap; compose each logical rectangle once, including mirrored groups. Transform/rotation and media display geometry are explicit inputs, not inferred from physical mode width/height.
  - Playback load options are selected after IPC subscription (T07): configured fitting for original assets, identity fitting for `geometryBaked` assets. No extra public geometry exports beyond the contract.
- `tests/geometry.test.js` — 16:9 into 16:10, 4:3, 21:9, portrait, equal aspect; all three modes, plus canvas cases with mixed scales and mirrored/adjacent rectangles.

## Acceptance criteria

- [ ] All geometry tests pass.
- [ ] Test runner reports failures with non-zero exit.
- [ ] `computeCanvas` produces gap-free adjacent rectangles at a common scale for mixed 100%/150% monitors, and round-trips mirrored groups exactly once.
- [ ] SAR/rotation normalization inputs produce placement/scale independent of raw physical mode width/height.
