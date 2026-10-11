# T15 — Startup gating and staggered start

- **Milestone:** M3
- **Depends on:** T09
- **Status:** review
- **Owner:** Claude Code
- **Skills:** GNOME Shell startup

## Goal

Never compete with the session for CPU/disk/GPU during login.

## Deliverables

- `lib/startupGate.js` — per [interfaces.md](interfaces.md#libstartupgatejs-t15-shell).
  - `waitForStartup({delayMs, cancellable})` installs/latches the startup-complete observation and reconciles `_startingUp` so an early completion cannot be missed. If already complete, only wait the delay.
  - Cancellation rejects promptly and disconnects the signal/removes the delay source; callbacks check lifecycle generation before releasing work.
- `PlayerManager.start()`: await gate, then start logical-monitor players sequentially with cancellable `stagger-ms` between each. Generation-check each continuation and serialize starts with outstanding old-player reaps.
- Ensure `enable()` returns immediately (all of this is async; no work in `enable()` besides wiring).
- Low priority: confirm `nice`/`ionice` prefix applied; mpv `--cache=no`, `--demuxer-max-bytes=32MiB`.
- Log timestamps: `enable`, `startup-complete`, gate released, each player spawned, each fade-in done.

## Acceptance criteria

- [ ] On login, journal shows mpv spawned only after `startup-complete + delay`. Debug logs record each timestamp, and the order is unit-tested. A real-login journal has not been captured.
- [ ] `enable()` duration < 5 ms (log it). Logged at debug level; not yet measured in a session.
- [ ] With 2 monitors, spawns are staggered. Unit-tested with two targets. The real resolver still returns only the primary monitor until T25.
- [x] `disable()` during the delay cancels cleanly with no spawn.
- [x] Completion immediately before/after listener registration never hangs; disable during completion or stagger cancels promptly, and stale gate completion cannot spawn after re-enable.

## Notes

- `lib/startupLifecycle.js` holds the testable core, `waitForStartupOn(layoutManager, ...)`. `lib/startupGate.js` binds it to `Main.layoutManager`.
  - The core connects `startup-complete` before reading `_startingUp`. A completion seen by both the signal and the flag counts once.
  - Cancellation removes the signal handler and the delay source.
- Only `start()` is gated; `reconcile()` is not. A gated start always runs even if a reconcile queued behind it.
- Players start one after another: each reaches fade-in before the cancellable `stagger-ms` sleep that precedes the next.
- Low priority was already `nice -n 10 ionice -c3` with `--cache=no`; this task adds `--demuxer-max-bytes=32MiB`.
- A headless nested T09 run (3 cycles) with the default 3 s delay played normally, never had more than one player, and logged no errors.
