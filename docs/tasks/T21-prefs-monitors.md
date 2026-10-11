# T21 — Preferences: per-monitor page

- **Milestone:** M5
- **Depends on:** T02, T05, T11, T12
- **Status:** review
- **Owner:** Claude Code
- **Skills:** GTK4, libadwaita (no GNOME Shell knowledge needed)

## Goal

Let users pick a video/GIF and fit mode for each monitor.

## Deliverables

- `prefs/monitorsPage.js` — `Adw.PreferencesPage` "Wallpapers".
  - Destructure `{physicalMonitors, logicalMonitors}` from `getMonitors(cancellable)`. Keep selection controls per physical ID (title `displayName`, connector and physical mode dimensions); show associated transformed logical dimensions/scale separately. Mirrored logical groups share one player/wallpaper: identify the first configured connector in stable sorted order as the effective selection in UI, while retaining all independent physical selection controls and stored IDs.
  - Row: selected file name + `Gtk.FileDialog` button. Filters: "Videos and GIFs" (`video/*`, `image/gif`), "All files".
  - Preview thumbnail (`Gtk.Picture`) using `ensureStill` via acquired `PlaybackAsset` when available; placeholder otherwise. FitMode combo: "Default (…)", Fill, Fit, Stretch.
  - "Remove" button clears the monitor's config.
  - Disconnected monitors that still have configs are listed in a collapsed "Other monitors" group with remove buttons.
  - On file select: run `probe()`. Reject unsupported HDR with an actionable `Adw.Toast` explaining that tone mapping is unsupported and suggesting an SDR source; validate display geometry before saving. Probe/still generation is async and cancellable; changing selections settles previous work promptly and cannot save stale configs.
- `prefs.js` adds this page.

## Acceptance criteria

- [x] Selecting a file writes `monitor-configs` JSON correctly.
- [x] Invalid file shows an error toast and leaves config unchanged.
- [x] UI never freezes while probing.
- [x] Works at narrow window width (adaptive).
- [x] Mirrored monitors clearly show shared playback assignment with distinct physical stored IDs. Unit-tested with the mirrored fixture; the nested session has one virtual monitor, so the mirrored UI was not seen on screen.
- [x] Selecting an HDR file shows an actionable toast and leaves configuration untouched; valid SDR with anamorphic SAR or rotation updates preview and saves config.
- [x] Rapid file/fit reselection or window close while probing/generating preview cancels previous work without race conditions, stale saves or temp leaks.

## Notes

- Pure logic lives in `prefs/monitorModel.js` (model, selection, preview) and `prefs/latestJobs.js` (one cancellable per key; a newer job or `close()` cancels the older one, and results after cancellation are dropped). `prefs/monitorsPage.js` is the Adw UI.
- One group per physical monitor: file row with choose/remove, preview, fit-mode combo. Mirrored members get an "In use"/"Not used" badge and an explanation. Disconnected configs sit in a collapsed "Other monitors" expander.
- The page rebuilds only when the monitor topology changes (`MonitorsChanged` on `org.gnome.Mutter.DisplayConfig`); config changes update rows in place.
- Fit-mode changes write immediately; a pending file selection reads the stored fit mode at save time, so the two never overwrite each other.
- `targetGeometry` moved to `lib/geometry.js` and is shared with `PlayerManager`, so previews pre-warm the extension's still cache.
- Nested smoke: `tests/integration/run-t21-nested.py` runs the page under a headless shell at 360 px width. Select writes the config and shows a preview; HDR, text and missing files toast and leave the config unchanged; four rapid selections plus two fit changes settle on the last ones; the main loop never stalled more than 24 ms; after close, no refs or job directories remain.
- The file dialog itself was not exercised headlessly (it needs the portal); the smoke test calls `select()` directly.
