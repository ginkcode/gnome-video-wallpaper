# T07 — mpv player process

- **Milestone:** M1
- **Depends on:** T03, T04
- **Status:** done
- **Owner:** Claude Code
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
  --wayland-content-type=video --msg-level=all=warn --clipboard-backends=vo
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

- [x] Idle spawn creates no media window; subscribing IPC then loading a paused test asset produces an owned window (integrated hiding is T08).
- [x] `ownsWindow()` true for that window, false for others.
- [x] `stop()` always leaves no `mpv` process (`pgrep -f gink-video-wallpaper` empty).
- [x] mpv crash (`kill -9`) fires `onExit` exactly once.
- [x] Late `onExit` registration is delivered exactly once; repeated stop/forceful termination safely share one reap and never unlink a newer instance socket.
- [x] Normal nested-Shell exit and abnormal Shell termination leave no owned mpv process; record tested lifetime evidence or the verified external mechanism in M1.

## Verification

GNOME Shell 50.1, GJS 1.88.0, mpv 0.41.0, FFmpeg 8.0.1, and Mutter 18 confirm `Meta.WaylandClient.new_subprocess(context, launcher, argv)`, `get_subprocess()`, `get_pid()`, and `owns_window()`. `preparePlayerSocket({cancellable})` allocates the private runtime socket before argv construction; the caller builds argv and constructs the player before synchronous `start()`.

`make test` passes. `gjs -m tests/mpvArgs.test.js` covers the complete base argv, substitutions/defaults, the `nice`/`ionice` prefix, the absence of initial media or fitting, and the `withParentDeathSignal` wrapper (real processes: runs under the expected parent, exits 1 when reparented). `gjs -m tests/playerProcess.test.js` (15 tests, pure Gio, no compositor) covers private-directory creation and permission enforcement, rejection of unsafe/relative/symlinked/wrong-mode runtime paths and cancellation, one-time socket allocation with release, argv/socket matching, stop-before-start and terminate-before-start never spawning, latched immutable exit results with `128 + signal` status, callback isolation and unsubscribe, coalesced stop, grace escalation to `force_exit`, force-before-stop skipping SIGTERM, reentrant stop sharing one reap, spawn failure, asynchronous stderr logging, and cleanup that deletes only the owned socket (never a regular file, symlink, or another instance's socket). These do not exercise a Wayland compositor.

### Nested Shell

`python3 -I tests/integration/run-t07-nested.py` runs each mode in a private headless GNOME Shell 50.1 (`dbus-run-session`, private `XDG_*` tree, keyfile GSettings, generated test asset). The user's real session is untouched. All five modes pass on two consecutive runs, and no spawned PID survives:

- **behavior:**
  - Trusted spawn works, and idle mpv has no window.
  - After IPC subscription, a paused `loadfile` creates a `wlshm` window that `ownsWindow()` accepts in the `window-created` callback.
  - A second player's window is accepted by that player and rejected by the first.
  - SIGKILL with the exit callback unsubscribed: no delivery. A late subscription is delivered exactly once with `signaled`.
  - Ten null-VO cycles of concurrent `stop()` + `terminateNow()` reap the process and remove each owned socket.
  - A coalesced stop removes both remaining sockets.
- **normal-idle / normal-loaded** (`global.context.terminate()`) and **abnormal-idle / abnormal-loaded** (nested Shell SIGKILL, exit 137): no mpv process remains 2 s later.

Findings:
- **Ownership:** mpv 0.41's Wayland clipboard backend connects at startup and consumes `WAYLAND_SOCKET`. The video window then used a second, untrusted `WAYLAND_DISPLAY` connection, so `owns_window()` was false. `--clipboard-backends=vo` fixes this; it is now in the base argv.
- **Lifetime:** Mutter's child setup sets no parent-death signal. Loaded mpv exits when its trusted connection drops, but idle mpv has no Wayland connection and survived both normal and abnormal Shell exit. `PlayerProcess` now spawns through `withParentDeathSignal`. That wrapper runs `setpriv --pdeathsig KILL` and then `/bin/sh`, which `exec`s the argv only if `$PPID` is still the Shell. This closes the race where the Shell dies before the signal is armed. Every wrapper stage `exec`s, so the PID stays mpv's. `tests/mpvArgs.test.js` verifies the parent check with real processes.

### Checks

- `make test` — passes (including existing T06 IPC tests).
- `make lint` — passes.
- `git diff --check` — passes.

No test enables the extension or changes settings in the user's real GNOME Shell session.
