# T16 — Bounded retries and failure notification

- **Milestone:** M3
- **Depends on:** T09, T14
- **Status:** todo
- **Owner:**
- **Skills:** Error handling, GNOME notifications

## Goal

A broken file or crashing player must never cause a restart loop or repeated spawning (a root cause of Hanabi's slow login).

## Deliverables

- In `PlayerManager`:
  - On unexpected exit or start failure: state `failed`, layer `showStatic()`, schedule restart with backoff `2s, 8s, 30s`.
  - After `max-retries` failures within 10 minutes: stop retrying for that monitor until settings change or next enable; send **one** notification via `Main.notify` / `MessageTray` with the error summary and a "Open Preferences" action.
  - Successful playback for 60 s resets the failure counter.
  - Guarantee at most one live mpv process per logical monitor, including mirrored groups and replacements (assert/log violations). Retry only after old reap, retaining displayed matching static; allocate a unique socket per attempt.
  - Generation-guard exit callbacks, backoff timers, reset timers and notifications. Disable synchronously cancels retries and forcefully terminates processes; residual reap retains only old process/socket. Rapid settings changes or re-enable cannot bypass outstanding reaping.
- Classify errors: missing file / probe failure → no retry (immediate notification); crash → retry.

## Acceptance criteria

- [ ] `kill -9` mpv 3× quickly → retries with backoff, then stops and shows exactly one notification.
- [ ] Deleting the configured video file before acquisition or during a future reconcile fails cleanly without retries, shows one notification, and retains the displayed matching still; deleting the source file while a player is actively running does not disturb its acquired private reference or trigger retries.
- [ ] Owned mpv count never exceeds configured logical monitors, including mirrored groups and retry/replacement transitions.
- [ ] Disable during backoff, an exit callback or a 60 s reset prevents stale retries/notifications; immediate re-enable waits for reap and cannot unlink a new attempt socket.
