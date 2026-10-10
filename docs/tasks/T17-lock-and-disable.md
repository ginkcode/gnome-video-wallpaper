# T17 — Lock/unlock and disable semantics

- **Milestone:** M3
- **Depends on:** T13, T14, T15
- **Status:** todo
- **Owner:**
- **Skills:** GNOME Shell session modes

## Goal

Distinguish "screen locked" (keep still wallpaper) from "user disabled extension" (restore original wallpaper).

## Deliverables

- `extension.js` `disable()`:
  - Synchronously invalidate generation, cancel every pending wait/fade/retry, destroy owned actors, disconnect signals, close IPC and request `terminateNow()` for all players. Do not await shell work or leave grace timers touching extension state; isolated residual reaping owns only old processes/sockets. New starts (including unlock/resume/re-enable) serialize with these reaps.
  - If `Main.sessionMode.isLocked` (or `currentMode === 'unlock-dialog'`), **do not** restore wallpaper.
  - Otherwise call `WallpaperSync.restore()`.
- On `enable()` after unlock: gate uses `startup-delay-ms` again (startup-complete already fired → only the delay).
- Suspend/resume: listen to logind `PrepareForSleep` (async D-Bus proxy); stop players on sleep, restart via gate on resume.
- Logout/abnormal Shell exit: use the lifetime mechanism demonstrated in M1 (T07/T09); do not assume children die with Shell. Verify no orphans remain on both normal and abnormal exit. Published static wallpapers remain outside cache and are not garbage-collected on restore.

## Acceptance criteria

- [ ] Lock → lock screen shows still; no mpv running while locked.
- [ ] Unlock → video resumes after delay, no flicker.
- [ ] User disables → original wallpaper restored.
- [ ] Suspend/resume 5× → exactly one player per logical monitor afterwards.
- [ ] After logout, `pgrep -u $USER mpv` shows none from this extension.
- [ ] Disable at probe/publication, IPC connect/load, content/paint wait, fade and retry boundaries immediately cleans shell state; stale completion cannot spawn, apply settings or touch the next lifecycle.
- [ ] Rapid lock/unlock, suspend/resume and disable/re-enable never overlap old/new players; every old socket/reference is cleaned only after its own reap.
