# T22 — Preferences: general, diagnostics, cache

- **Milestone:** M5
- **Depends on:** T02, T11, T12
- **Status:** review
- **Owner:** Claude Code
- **Skills:** GTK4, libadwaita

## Goal

Expose global settings and help users fix missing dependencies.

## Deliverables

- `prefs/generalPage.js` — "General":
  - Startup: `startup-delay-ms` (`Adw.SpinRow`, seconds), `stagger-ms`.
  - Pause: switches for `pause-on-maximized`, `pause-on-overview`, `pause-on-battery`.
  - Playback: default fit mode, `optimize-videos` switch, `video-output` combo (advanced expander), `max-retries`.
  - `debug-logging` switch.
  - All bound with `settings.bind`.
- `prefs/diagnosticsPage.js` — "Diagnostics":
  - Rows for mpv, ffmpeg, ffprobe, VA-API with ✓/✗ icon and version string (`checkDependencies()` from T11).
  - Install hint row (e.g. `sudo apt install mpv ffmpeg`, `sudo dnf install mpv ffmpeg`).
  - Cache size and "Clear cache" button calling `clearCache()`, with confirmation dialog. Explain that active playback assets and persistent published wallpapers are preserved; report returned `{removedBytes, preservedActiveBytes, preservedWallpaperBytes}`.
  - Cancelable snapshot clear; concurrent clearing/re-probe handles missing entries safely and ignores caller cancellation for other operations.

## Acceptance criteria

- [x] Every setting round-trips through `gsettings get`.
- [x] Diagnostics correct on this device; renaming `mpv` temporarily (PATH override) shows ✗.
- [x] Clear cache deletes eligible completed entries, updates the size label, and preserves active playback assets plus persistent published wallpapers.
- [x] Clear cache while video is actively playing and system wallpaper is applied deletes only eligible completed cache entries; active video and desktop wallpaper remain intact.
- [x] Cache dialog/toast shows preserved active/published bytes.

## Notes

- Bindings: switches and `max-retries` use `settings.bind`. Millisecond keys are shown in seconds and enums as combo rows through `prefs/bindings.js` (two-way, unbound on close). `video-output` and `max-retries` sit in an "Advanced" expander.
- Dependency versions come from `describeDependencies()` in `lib/deps.js`. The install hint reads `/etc/os-release` asynchronously and falls back to apt and dnf examples. VA-API missing is a warning, not an error, and gets no install command.
- `cacheSize()` counts hard-linked references once. Clear runs behind a confirmation dialog, disables its button while running, and reports freed and kept bytes in a toast.
- The still of a playing wallpaper is a completed cache entry, so clearing deletes it. The player keeps its own reference and the applied wallpaper is a separate published copy; the still is recreated when needed.
- Nested verification (`tests/integration/run-t22-nested.py`, extension playing under a headless shell):
  - All 10 settings round-trip through `gsettings get`, and an external `gsettings reset` updates the widgets.
  - Diagnostics show mpv 0.41.0, ffmpeg/ffprobe 8.0.1 and VA-API. With mpv removed from `PATH`, mpv and VA-API show ✗ and the hint is `sudo apt install mpv`.
  - Clearing while playing removed 199.3 kB and kept 150.3 kB of active references and 195.2 kB of published wallpaper. The same mpv pid kept running, the ref directory stayed, and `picture-uri` still points to an existing file. The size label dropped from 349.5 kB to 150.3 kB.
