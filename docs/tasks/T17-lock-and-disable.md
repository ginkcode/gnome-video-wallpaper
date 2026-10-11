# T17 — Lock/unlock and disable semantics

- **Milestone:** M3
- **Depends on:** T13, T14, T15
- **Status:** review
- **Owner:** Claude Code
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

- [x] Lock → lock screen shows still; no mpv running while locked. Nested run: the system background stays on the published still and the player is reaped.
- [ ] Unlock → video resumes after delay, no flicker. Resume after the delay is verified in the nested run (new player 2.1 s after unlock with a 1.5 s delay); flicker needs the real-session gate.
- [x] User disables → original wallpaper restored.
- [ ] Suspend/resume 5× → exactly one player per logical monitor afterwards. Unit-tested with a fake login manager and five stop/start cycles; a real suspend is not possible in the nested session.
- [x] After logout, `pgrep -u $USER mpv` shows none from this extension. The T09 nested run checks normal exit and SIGKILL of the Shell: no survivors.
- [x] Disable at probe/publication, IPC connect/load, content/paint wait, fade and retry boundaries immediately cleans shell state; stale completion cannot spawn, apply settings or touch the next lifecycle.
- [x] Rapid lock/unlock, suspend/resume and disable/re-enable never overlap old/new players; every old socket/reference is cleaned only after its own reap.

## Notes

- `disable()` calls `PlayerManager.stop({restore})`, where `restore` is false when `isLockedSession(Main.sessionMode)` is true (`isLocked` or `unlock-dialog`). With `session-modes: ["user"]`, the Shell disables the extension on lock while already in `unlock-dialog`; the nested run confirmed this.
- Restore creates a `WallpaperSync` if none exists yet, so originals saved by an earlier session are still restored.
- Sleep uses the Shell's `LoginManager` singleton (`misc/loginManager.js`), which already holds an async logind proxy and emits `prepare-for-sleep`. `watchSleep` (`lib/sessionLifecycle.js`) ignores repeated signals; sleep stops the players without restoring, and resume calls the gated `start()`.
- Unlock re-enables the extension, so the gate sees `startup-complete` already fired and waits only `startup-delay-ms`.
- Logout and Shell crash rely on the T07 parent-death signal; nothing is added here.
- The T09 probe audit now waits for the Shell's own ~1 s background cross-fade caused by the restore before counting background-group children.
- Nested verification: `tests/integration/run-t17-nested.py` (lock, unlock, disable) and `run-t09-nested.py` both pass.
