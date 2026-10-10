# T26 — Spanned multi-monitor still

- **Milestone:** M6
- **Depends on:** T12, T13, T25
- **Status:** todo
- **Owner:**
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
- [ ] Arrangement changes regenerate the composite.
- [ ] Single monitor still uses non-spanned path.
- [ ] Spanned canvas shared edges with mixed 100%/150% scales align with no seams, gaps, or overlapping pixels; tests record the selected common raster scale and cover negative origins, unequal heights and rotated rectangles.
- [ ] Mirrored monitors compose exactly once onto the shared logical rectangle.
- [ ] Cache clear does not remove the active published spanned wallpaper.
