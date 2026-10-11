# T30 — Video playlists

- **Milestone:** M7
- **Depends on:** T21, T22, T24, T29
- **Status:** review
- **Owner:** Claude Code
- **Skills:** GSettings, libadwaita, GNOME Shell timers

## Goal

Each display can have several videos. The display changes to the next video after a set time (default 30 minutes), in list order or shuffled.

## Deliverables

- Config: a monitor config holds `files` (a non-empty list of absolute paths, without duplicates). `file` stays as `files[0]`, so older configs (`file` only) still load and older readers keep working.
- Schema keys:
  - `playlist-interval-minutes` (u, 30, range 1–1440)
  - `playlist-order` (enum `sequential`|`random`)
  - `playlist-state` (s, JSON `{physicalMonitorId: currentFile}`)
- `lib/playlist.js`:
  - `Playlist.fileFor(id, files)` picks each display's current file.
  - A timer advances every playlist and triggers a reconcile, which reuses the T24 still→video handoff.
  - Shuffle never repeats the current file.
  - Positions persist, so a playlist resumes where it left off.
  - The timer skips while the user has paused playback (T29).
- `planTargets(..., {fileFor})` chooses the file per physical monitor.
- Preferences:
  - Wallpapers: a Videos expander per display with Add (multi-select), Remove all, and per-file Play earlier/Remove.
  - General → Playlists: interval and order.
  - Optimization runs for every file in the list.
- Top bar: a Next Video item.

## Acceptance criteria

- [x] Several videos can be added per display; the list can be reordered and items removed. Removing the last one removes the config.
- [x] Videos change in order and wrap around; shuffle picks a different video each time.
- [x] Each change plays the new video in a new player with the usual handoff.
- [x] The position survives disable/enable and login.
- [x] Changing the interval reschedules the timer; nothing changes while paused.
- [x] Older single-file configs keep working.
- [ ] Long-running rotation on real hardware (real session).

## Notes

- Unit tests: `tests/playlist.test.js`, plus playlist cases in `tests/config.test.js`, `tests/monitorTopology.test.js` and `tests/monitorModel.test.js`.
- `python3 -I tests/integration/run-t30-nested.py` passed all checks:
  - start at the first file
  - advance green→red→blue→green
  - Next Video menu item
  - a new mpv for each change
  - persisted position resumed after re-enable
  - an advance while paused stays paused
  - no survivors
  - no `JS ERROR`
- `tests/integration/t21-prefs-smoke.js` now also covers add, play earlier and remove.
