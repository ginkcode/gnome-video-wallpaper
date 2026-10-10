# T15 — Startup gating and staggered start

- **Milestone:** M3
- **Depends on:** T09
- **Status:** todo
- **Owner:**
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

- [ ] On login, journal shows mpv spawned only after `startup-complete + delay`.
- [ ] `enable()` duration < 5 ms (log it).
- [ ] With 2 monitors, spawns are staggered.
- [ ] `disable()` during the delay cancels cleanly with no spawn.
- [ ] Completion immediately before/after listener registration never hangs; disable during completion or stagger cancels promptly, and stale gate completion cannot spawn after re-enable.
