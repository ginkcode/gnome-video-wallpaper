# T09 — PlayerManager proof of concept

- **Milestone:** M1
- **Depends on:** T02, T05, T06, T07, T08
- **Status:** review
- **Owner:** Claude Code
- **Skills:** GNOME Shell extension lifecycle

## Goal

Wire modules together: one video on the primary monitor, driven by `extension.js`. This is the M1 feasibility gate.

## Deliverables

- `lib/playerManager.js` — per [interfaces.md](interfaces.md#libplayermanagerjs-t09-extended-by-t14t25-shell), minimal:
  - Scope remains the primary logical monitor PoC. Record `{logicalMonitorKey, selectedPhysicalMonitorId, asset, process, ipc, layer, state}`; resolve the first configured sorted connector, retaining physical IDs in config. Use an explicitly staged private test asset/matching persistent still in M1 (contract-compatible fixtures/stubs for T12/T13); production acquisition/publication is T14, not a new M1 cache implementation.
  - `start()`: prepare matching static actor → install `watchWindow` synchronously → spawn idle/no-file mpv → connect/subscribe IPC → load the exact asset paused → attach hidden owned window → await both latched cancellable `waitForContent` and `waitForFirstFrame` → fade → clear only `startup` pause reason. The window observer and IPC subscription must precede their producers; waits reconcile already-arrived evidence.
  - States: `starting`, `playing`, `paused`, `failed`, `stopped`.
  - `stop()` is synchronous: increment lifecycle generation, cancel waits/fades/retries, destroy layers, close IPC, disconnect signals, and call `terminateNow()` on every owned process. Do not await shell cleanup; isolated reapers retain only old process/socket ownership. Serialize all starts with outstanding reaping, even across rapid disable/re-enable; release the old private asset only after reap.
  - `setPaused(logicalMonitorKey, reason, paused)`: maintains a `Set` of reasons per player; paused iff non-empty. Clearing startup must preserve battery/coverage/overview reasons. Every async continuation checks generation and cancellation before spawn or shell-state changes.
- `extension.js`: `enable()` creates settings, logger, `PlayerManager`, calls `start()`; `disable()` calls `stop()` and disposes. Guard against `disable()` during an in-flight `start()` (use a cancellable).
- Temporary: if `monitor-configs` is empty, read `GINK_VW_TEST_FILE` env var or a hard-coded dev path for the primary monitor (remove in T24).

## Acceptance criteria

- [ ] Video plays as wallpaper in nested shell and in the real session (Hanabi disabled). Nested: verified. The capture centre was `[28,200,59]` (selected green) against wallpaper `[2,60,136]` before enable. `time-pos` advanced 1.0 s per 1.0 s at about 60 display fps with zero drops. The wallpaper window was unfocused and `skip_taskbar`. Real session: not yet verified. It needs the user, with Hanabi disabled.
- [x] 50 rapid disable/enable cycles: no shell errors, no leftover mpv, no leftover sockets, no extra actors in `_backgroundGroup`. The cycles called `Main.extensionManager.disableExtension`/`enableExtension`, the same path the `gnome-extensions` CLI reaches over D-Bus. After the final disable, the reap count was 0, the socket directory was empty, `_backgroundGroup` was back at baseline 1 and the capture matched the wallpaper. No `[gink-vw]` warnings or errors, no `JS ERROR`.
- [x] `setPaused` with two reasons only resumes when both cleared. With one reason left: `pause:true`, `time-pos` frozen, state `paused`. With both cleared: `pause:false`, advancing, state `playing`. Unit tests also cover reasons set during startup.
- [x] M1 records feasible paused-content evidence and independent compositor-first-frame evidence, including arrival before waiter registration; neither relies only on an event or hangs on cancellation. `start()` reaches `playing` only after both `waitForContent` (paused load) and `waitForFirstFrame` resolve. That happened 100 times across the two sessions. Latched late-waiter and cancellation behaviour are covered by the T05/T08 unit tests.
- [x] Disable at connect, load, readiness and fade boundaries is synchronous; stale completion cannot spawn or touch a new lifecycle. Immediate re-enable waits for old reap and never overlaps processes. `tests/playerManager.test.js` stops at every boundary (resolve, static, socket, connect, load, content, frame, fade) and asserts no later work and no spawn. Nested cycles hit connect, readiness, fade, static/socket, awaiting-reap and playing. A 5 ms `/proc` sampler saw 50 distinct mpv PIDs per session and never more than one alive at a time.
- [x] M1 verifies process lifetime on both normal and abnormal Shell exit (T07). Normal: `global.context.terminate()`, Shell exit 0. Abnormal: the runner sent SIGKILL to the exact private Shell PID. In both cases no private mpv survived. The feasibility gate stays open until the real-session check above passes.

## Evidence

Private nested Shell (`gnome-shell --headless --virtual-monitor=1024x768`, Shell 50.1, private D-Bus and keyfile GSettings) via `python3 -I tests/integration/run-t09-nested.py --keep`. Run `/tmp/t09-dx37cpw0` reported `verified` for both the `normal` and `abnormal` sessions. The probe extension (`tests/integration/t09-probe.js`) enables the real extension, which was staged with `GINK_VW_TEST_FILE`/`GINK_VW_TEST_STILL`.

| Capture | Centre RGB |
|---|---|
| before enable | `[2, 60, 136]` wallpaper |
| playing | `[28, 200, 59]` selected green |
| after final disable | `[2, 60, 136]` wallpaper |

Video output measurement (nested, hidden window with a clone):

| `--vo` | Result |
|---|---|
| `gpu-next` | stalls: `time-pos` +0.03–0.1 s per second, then frozen after unpause |
| `dmabuf-wayland` | real time, ~60 display fps, 0 drops |
| `wlshm` | real time, ~60 display fps, 0 drops |

`auto` therefore maps to `dmabuf-wayland,wlshm` for now. T10 is still to benchmark it on real hardware.

Notes:

- When the Shell exits, the extension is never disabled, so the socket path of the last player stays in `$XDG_RUNTIME_DIR/gink-video-wallpaper`. The file is a UUID-named entry on tmpfs, so no new allocation can collide with it. No process survives. A sweep of stale sockets at startup could be added later.
