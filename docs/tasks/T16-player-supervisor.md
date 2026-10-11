# T16 — Bounded retries and failure notification

- **Milestone:** M3
- **Depends on:** T09, T14
- **Status:** review
- **Owner:** Claude Code
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

- [x] `kill -9` mpv 3× quickly → retries with backoff, then stops and shows exactly one notification. Verified by `tests/integration/run-t16-nested.py` (headless nested): 3 spawns, kill gaps of 2.6 s and 8.7 s, state `failed` with the still shown, and one notification with "Open Preferences".
- [ ] Deleting the configured video file before acquisition or during a future reconcile fails cleanly without retries, shows one notification, and retains the displayed matching still; deleting the source file while a player is actively running does not disturb its acquired private reference or trigger retries. Unit-tested: `ProbeError` and permanent `CacheError` codes block retries and notify once, and a reconcile with an unchanged selection leaves the running player alone. A nested file-deletion run is pending.
- [x] Owned mpv count never exceeds configured logical monitors, including mirrored groups and retry/replacement transitions. The nested T16 run never saw more than one player. A per-key live-process guard refuses a second spawn until the previous process is reaped.
- [x] Disable during backoff, an exit callback or a 60 s reset prevents stale retries/notifications; immediate re-enable waits for reap and cannot unlink a new attempt socket.

## Notes

- The supervisor lives in `PlayerManagerLifecycle`.
  - Each logical monitor keeps a list of failure times within a 10-minute window. Backoff is `2s, 8s, 30s`; the last value repeats when `max-retries` is above 3.
  - A monitor is blocked when its failure count reaches `max-retries`, or at once for a permanent error. The block holds until the selection key changes or the extension is re-enabled.
  - 60 s of playback after the fade clears the failure list.
  - All timers are generation-guarded and removed by `stop()`.
- A retry is a normal reconcile, so it waits for outstanding reaps, reuses the failed record's still layer, and gets a fresh socket.
- `FailureNotifier` (`lib/notifier.js`) uses its own `MessageTray.Source`, which is destroyed on disable.
- **Finding for T20:** GNOME starts in the Overview, which hides the window group. A player started there never paints its first frame. It times out after 10 s and burns through the retries. In the nested run the start failed 3/3 times until the probe hid the Overview. T20 must hold or extend readiness while the Overview is visible. Resolved in T20 (`waitForPaintable`).
- Also fixed: a start that failed before handoff used to stay in the pending set.
