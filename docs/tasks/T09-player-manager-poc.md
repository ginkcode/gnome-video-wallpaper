# T09 — PlayerManager proof of concept

- **Milestone:** M1
- **Depends on:** T02, T05, T06, T07, T08
- **Status:** todo
- **Owner:**
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

- [ ] Video plays as wallpaper in nested shell and in the real session (Hanabi disabled).
- [ ] 50 rapid `gnome-extensions disable/enable` cycles: no shell errors, no leftover mpv, no leftover sockets, no extra actors in `_backgroundGroup`.
- [ ] `setPaused` with two reasons only resumes when both cleared.
- [ ] M1 records feasible paused-content evidence and independent compositor-first-frame evidence, including arrival before waiter registration; neither relies only on an event or hangs on cancellation.
- [ ] Disable at connect, load, readiness and fade boundaries is synchronous; stale completion cannot spawn or touch a new lifecycle. Immediate re-enable waits for old reap and never overlaps processes.
- [ ] M1 verifies process lifetime on both normal and abnormal Shell exit (T07); block the feasibility gate if any readiness/lifetime mechanism remains unproven.
