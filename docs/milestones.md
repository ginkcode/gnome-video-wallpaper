# Milestones

Hanabi must be disabled while developing and testing.

## M1 — Proof of concept (feasibility gate)

Scope: hard-coded single video on `eDP-1`, no prefs.

- [ ] Project scaffold: `metadata.json`, `extension.js`, MIT `LICENSE`, `Makefile` (install/zip/lint/test/nested), ESLint config.
- [ ] Spawn mpv via `Meta.WaylandClient.new_subprocess`; identify its window with `owns_window`.
- [ ] Hide real window; clone it into the background layer.
- [ ] Opacity-0 clone, fade in after latched compositor and mpv content readiness.

Acceptance:
- Video plays behind all windows; desktop clicks are unaffected.
- Not visible in Alt+Tab, Overview window picker, or Dash to Dock.
- The window-creation callback hides the owned window before it can flash; hiding is not deferred to a later continuation.
- IPC is connected and subscribed before the paused asset loads. A missed early event is recovered by persistent-state reconciliation. Record concrete evidence that paused-content readiness reflects the selected asset and compositor first-frame readiness is latched separately.
- 50 rapid enable/disable cycles leave no mpv processes, actors, or sockets. Disable synchronously revokes shell resources and requests forceful termination; residual reaping cannot touch the next lifecycle.
- Shell-exit behavior, including abnormal Shell exit, is recorded. If children can survive, a verified external lifetime mechanism is required before later milestones treat cleanup as solved. M1 proves feasibility; it does not mark untested behavior verified.
- CPU/GPU comparison of `--vo=gpu-next` vs `--vo=dmabuf-wayland` recorded; default chosen.

## M2 — Still frames and wallpaper sync

- [ ] `ffprobe` validation, including sample aspect ratio, rotation, SDR color metadata, and actionable HDR rejection.
- [ ] `ffmpeg` still extraction from the exact playback asset, without fitting baked geometry twice.
- [ ] Publish immutable wallpapers outside the disposable cache; save, set, and restore system wallpaper settings.
- [ ] Fade-in only after both latched readiness conditions; cancellation settles both waits.

Acceptance: tested SDR perceptual continuity between login/lock still and paused first frame for fill, fit, stretch, anamorphic SAR, rotation, and tagged SDR sources. HDR is rejected. Original wallpaper restored on user disable. A missing prepared transcode selects the original and its matching still together, with no login transcode.

## M3 — Startup and resource control

- [ ] Gate on latched `startup-complete` + delay; staggered starts.
- [ ] `nice` / `ionice`, `--cache=no`, async everything.
- [ ] Bounded retries with backoff and one notification.
- [ ] Lock/unlock handling.

Acceptance (measured from real logout/login, compared with no video wallpaper):
- Time to first video frame recorded.
- App launch times for a fixed set of apps within normal variance.
- No duplicate player processes, including during rapid disable/re-enable while reaping is outstanding.

## M4 — Pause policy

- [ ] Pause on maximized/fullscreen coverage per logical monitor.
- [ ] Pause during Overview.
- [ ] Pause on battery (UPower).

Acceptance: CPU/GPU near idle while paused; resume without flicker. Fade completion removes only the startup pause reason and preserves battery, coverage, and Overview pauses.

## M5 — Preferences

- [ ] libadwaita window with per-monitor file chooser and fit mode.
- [ ] Startup delay, pause toggles, optimize toggle, video output.
- [ ] Dependency diagnostics (mpv, ffmpeg, VA-API) and cache clear.
- [ ] GIF and optional video transcoding with progress.

Acceptance: settings apply live without restarting the extension. A file change shows the prepared matching still before the old player stops; players never overlap. Clear-cache can leave active media entries and always leaves published wallpapers intact; preferences reports preserved assets. Distinct fit variants do not reuse one transcode.

## M6 — Multi-monitor

- [ ] Monitor identity mapping and hotplug reconcile (debounced).
- [ ] Spanned composite wallpaper still.
- [ ] Mixed scale factors.

Acceptance: plugging/unplugging an external display keeps correct logical-monitor videos, no orphan players. Mixed scale, rotation, and mirrored groups use transformed logical rectangles, one player per group, stable sorted connector selection, one common raster scale, and shared edge rounding. Physical selections remain stored for unmirrored use.

## M7 — Hardening and release

- [ ] ESLint clean, gjs unit tests passing.
- [ ] Nested shell test runs.
- [ ] Compatibility check with Blur My Shell and Dash to Dock.
- [ ] README, packaging zip, extensions.gnome.org review-guideline check.
