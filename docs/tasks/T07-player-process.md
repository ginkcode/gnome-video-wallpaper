# T07 — mpv player process

- **Milestone:** M1
- **Depends on:** T03, T04
- **Status:** todo
- **Owner:**
- **Skills:** Mutter, Gio.Subprocess, mpv

## Goal

Spawn mpv as a trusted Wayland client of GNOME Shell so its windows can be identified, and stop it reliably.

## Deliverables

- `lib/mpvArgs.js` [pure] — per [interfaces.md](interfaces.md#libmpvargsjs-t07-pure). Base options:
  ```
  --no-config --no-audio --loop-file=inf --hwdec=<hwdec> --cache=no
  --osc=no --osd-level=0 --input-default-bindings=no --input-vo-keyboard=no
  --no-input-cursor --cursor-autohide=always --no-border --title-bar=no
  --force-window=no --idle=yes --pause=yes --keep-open=no --background-color=#000000
  --wayland-app-id=<appId> --title=gink-video-wallpaper
  --input-ipc-server=<socketPath> --vo=<vo> --video-sync=display-resample
  --wayland-content-type=video --msg-level=all=warn
  ```
  `buildMpvArgv({mpvPath, socketPath, vo, hwdec, appId, lowPriority})` has no file or fit argument: start idle with no media window. After IPC subscriptions are installed, select load options from `PlaybackAsset`: identity fitting for `geometryBaked`, configured fill/fit/stretch otherwise; then load the private asset path paused.
  `lowPriority` prefixes `nice -n 10 ionice -c3`.
- `lib/playerProcess.js` [shell] — per [interfaces.md](interfaces.md#libplayerprocessjs-t07-shell).
  - `Meta.WaylandClient.new_subprocess(global.context, launcher, argv)` with a `Gio.SubprocessLauncher` (flags: stdout/stderr pipe or silence; set `XDG_RUNTIME_DIR` passthrough).
  - Ensure `$XDG_RUNTIME_DIR/gink-video-wallpaper/` exists (mode 0700). Allocate a short unique socket basename per instance, never a reusable monitor socket or another instance's socket. Unlink only the owned socket after reaping.
  - `wait_async` drives latched `onExit(callback)`; late subscribers receive the exit result.
  - `stop({graceMs = 1000})`: bounded graceful termination, resolving only after reap; coalesce concurrent stop/reap requests. `terminateNow()` synchronously cancels any grace timer and requests forceful termination without awaiting. Residual reaping owns only the old process/socket, not extension state. Serialize later starts against outstanding reaps.
  - M1 must verify normal and abnormal Shell-exit lifetime behavior. Do not assume subprocess ancestry kills children; if the spawning API does not ensure it, establish and verify an external lifetime mechanism before passing M1.
  - Read stderr asynchronously and forward lines to the logger at debug level.
- `tests/mpvArgs.test.js`.

## Acceptance criteria

- [ ] Idle spawn creates no media window; subscribing IPC then loading a paused test asset produces an owned window (integrated hiding is T08).
- [ ] `ownsWindow()` true for that window, false for others.
- [ ] `stop()` always leaves no `mpv` process (`pgrep -f gink-video-wallpaper` empty).
- [ ] mpv crash (`kill -9`) fires `onExit` exactly once.
- [ ] Late `onExit` registration is delivered exactly once; repeated stop/forceful termination safely share one reap and never unlink a newer instance socket.
- [ ] Normal nested-Shell exit and abnormal Shell termination leave no owned mpv process; record tested lifetime evidence or the verified external mechanism in M1.
