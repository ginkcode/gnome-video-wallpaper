# T21 — Preferences: per-monitor page

- **Milestone:** M5
- **Depends on:** T02, T05, T11, T12
- **Status:** todo
- **Owner:**
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

- [ ] Selecting a file writes `monitor-configs` JSON correctly.
- [ ] Invalid file shows an error toast and leaves config unchanged.
- [ ] UI never freezes while probing.
- [ ] Works at narrow window width (adaptive).
- [ ] Mirrored monitors clearly show shared playback assignment with distinct physical stored IDs.
- [ ] Selecting an HDR file shows an actionable toast and leaves configuration untouched; valid SDR with anamorphic SAR or rotation updates preview and saves config.
- [ ] Rapid file/fit reselection or window close while probing/generating preview cancels previous work without race conditions, stale saves or temp leaks.
