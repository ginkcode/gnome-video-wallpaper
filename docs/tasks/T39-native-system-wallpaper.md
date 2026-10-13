# T39 — Native-size system wallpaper that stays after disable

- **Milestone:** M7
- **Depends on:** T13, T17, T26
- **Status:** review
- **Owner:** Claude Code
- **Skills:** ffmpeg, GSettings

## Goal

Turning the extension off should look like pausing the video. The spanned composite only fit the monitor layout it was built for, so it was stretched or merged after a layout change, and disable brought back an old wallpaper.

## Deliverables

- `stillCache.ensureNativeStill(media)`: the first frame of the original source at its display size (SAR applied, no fitting), cached as kind `native`.
- The system wallpaper is the published native still of the primary monitor's target (or the first target), with `picture-options` from its fit mode: fill → `zoom`, fit → `scaled`, stretch → `stretched`, on a solid black background.
- Spanned composition (`composeSpanned`, `computeCanvas`, `planWallpaper`) and the T26 nested test are removed.
- `disable()` never restores the wallpaper. The original returns only when every video is removed in preferences.
- `WallpaperSync` saves and restores `primary-color` and `color-shading-type` (new `saved-*` keys). Keys changed while the extension was off replace the saved originals on the next apply.

## Acceptance criteria

- [x] Unit tests cover native still size, caching, cancellation and source change; primary selection, fit mapping and failure handling in the lifecycle; color keys and changes made while off in `WallpaperSync`.
- [x] T17 nested run shows the still kept after disable; T24 and T25 (`--quick`) nested runs pass.
- [ ] Verified on the real session with two monitors, after unplugging one and after disable.
