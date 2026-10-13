# T26 — Spanned multi-monitor still

> Superseded by [T39](T39-native-system-wallpaper.md): the spanned composite was removed.

- **Milestone:** M6
- **Depends on:** T12, T13, T25
- **Status:** review
- **Owner:** Claude Code
- **Skills:** ffmpeg filter graphs

## Goal

With different videos per monitor, the system wallpaper (login, lock, Overview) shows each monitor's own still.

## Deliverables

- `stillCache.composeSpanned()`:
  - Canvas is the bounding box of logical monitor rectangles computed by `computeCanvas(logicalMonitors, rasterScale)` (T04), translated by min x/y and rasterized at one common scale. Caller policy initially chooses the maximum connected logical-monitor scale and records it in the composite identity/tests; never mix physical mode layouts or per-monitor canvas scales. Round shared edges once so adjacent rectangles cannot develop gaps/overlap; compose each logical rectangle once, including mirrored groups.
  - `composeSpanned(stills /* [{path, key}] */, canvas, cancellable)` returns a completed PNG cache path using the canvas rectangles. Place each logical monitor's exact-asset matching still at its rectangle; unconfigured monitors use saved original wallpaper (with saved `picture-options`) or black. Use async composition, unique producer jobs/temps and immutable atomic cache publication; caller cancellation must not delete another producer's work.
  - Publish the completed composite via `publishWallpaper` before applying its URI under `$XDG_DATA_HOME/gink-video-wallpaper/wallpapers/`. Preserve published spanned files across cache clear/restore; publication GC is deferred.
  - Cache key incorporates all logical keys, rects, common scale, transform versions and exact asset identities.
- `WallpaperSync.apply(spannedUri, 'spanned')` when ≥2 logical monitors; single logical monitor uses the plain published still with `zoom`. Guard composition and apply by lifecycle generation/cancellation.

## Acceptance criteria

- [ ] Two monitors with different videos: lock screen and Overview show each still on its own monitor, aligned with the video handoff.
- [x] Arrangement changes regenerate the composite.
- [x] Single monitor still uses non-spanned path.
- [x] Spanned canvas shared edges with mixed 100%/150% scales align with no seams, gaps, or overlapping pixels; tests record the selected common raster scale and cover negative origins, unequal heights and rotated rectangles.
- [x] Mirrored monitors compose exactly once onto the shared logical rectangle.
- [x] Cache clear does not remove the active published spanned wallpaper.

## Verification — 2026-10-11

- `make test` and `make lint` pass. Unit coverage includes translated negative origins, unequal/rotated logical rectangles, maximum common 150% scale and adjacent edge pixels, black gaps, original zoom/scaled/centered/stretched/tiled/spanned/none options, identity/version changes, shared cancellation, composite regeneration after cache clear and persistent publication survival. Lifecycle tests cover all-assets-first ordering, composition/publication cancellation, and composition failure with continuing playback.
- `python3 -I tests/integration/run-t26-nested.py ` passes (twice) all 15 checks in private headless GNOME Shell 50 with two virtual monitors. The driver decodes the applied published PNG with ffmpeg and checks dimensions/monitor centre and edge colours, spanned options, stacked arrangement regeneration, mixed 100%/150% scale, rotation, original-wallpaper fallback, mirrored single rectangle/zoom, single-monitor zoom, cache-clear/restore publication survival and clean disable. No fixture processes survive or shell errors are reported.
- Regression commands: `python3 -I tests/integration/run-t25-nested.py --quick` passes. `python3 -I tests/integration/run-t24-nested.py` passed in three sequential runs. One run made while another nested shell was running at the same time failed its `changeHandsOff` and `removeRestores` wallpaper-URI checks, with no shell or driver errors and correct player transitions; the cause was not isolated.

Limitations: no real-session install, lock-screen/Overview visual check, physical hotplug, or real mixed-scale hardware validation. The lock-screen/Overview acceptance criterion remains a manual check. Published wallpaper GC remains deferred.
