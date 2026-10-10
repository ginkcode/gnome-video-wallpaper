# T22 — Preferences: general, diagnostics, cache

- **Milestone:** M5
- **Depends on:** T02, T11, T12
- **Status:** todo
- **Owner:**
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

- [ ] Every setting round-trips through `gsettings get`.
- [ ] Diagnostics correct on this device; renaming `mpv` temporarily (PATH override) shows ✗.
- [ ] Clear cache deletes eligible completed entries, updates the size label, and preserves active playback assets plus persistent published wallpapers.
- [ ] Clear cache while video is actively playing and system wallpaper is applied deletes only eligible completed cache entries; active video and desktop wallpaper remain intact.
- [ ] Cache dialog/toast shows preserved active/published bytes.
