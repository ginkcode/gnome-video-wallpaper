# T24 — Apply settings live

- **Milestone:** M5
- **Depends on:** T02, T09, T12, T13
- **Status:** review
- **Owner:** Claude Code
- **Skills:** GNOME Shell extension, state reconciliation

## Goal

Changes in preferences take effect without disabling/enabling the extension.

## Deliverables

- `PlayerManager.reconcile()`:
  - Desired state per configured logical monitor includes selected physical ID, exact acquired asset identity, raster geometry, scale, fitMode, transformVersion and vo. Changing fitting or optimization must select/regenerate the matching still before replacement; optimized geometry is never fitted twice.
  - Reconcile logical monitors: resolve the first configured connector in stable sorted order per logical monitor; physical IDs remain stored keys. Mirrored connectors share one logical player.
  - Changed configs: acquire selected `PlaybackAsset` (or original fallback) → ensure matching still → publish wallpaper → guarded `apply` → preload matching static into owned actor → display static over old clone → remove old clone → stop/reap old player (bounded graceful stop permitted for live replacement) → release old asset → spawn/fade new player paused → clear startup reason.
  - No old/new player overlap: every instance owns a unique socket, and new starts serialize with reaping. Do not crossfade raw video windows or run two players simultaneously on the same logical monitor.
  - Removed configs: display preloaded static/restored wallpaper → remove clone → stop/reap player → release asset. Restore original wallpaper only when no monitor has a config.
  - Guard all async reconciles by lifecycle generation and cancellation; serialize reconcile queues. Rapid settings changes do not spawn duplicate players, leak sockets/temps, or corrupt wallpaper state.
- Connect `changed::monitor-configs`, `changed::default-fit-mode`, `changed::video-output`, `changed::optimize-videos` (debounced 300 ms).
- Serialize reconciles (queue; never two concurrently).
- Remove the temporary dev-path fallback from T09.

## Acceptance criteria

- [x] Changing the video in prefs hands off via a prepared displayed matching static without black frames, overlap, or leftover sockets. There is no video-to-video crossfade.
- [x] Rapid settings slider/selection changes queue cleanly and resolve to the final selection with exactly one player per logical monitor.
- [x] Removing all configs restores the original wallpaper and stops all players.
- [x] Mirrored display configuration updates the shared logical player from the first configured connector.

## Verification — 2026-10-11

- `make test` and `make lint` pass. Lifecycle tests cover prepared-still handoff order, coalesced rapid requests, captured video output, config removal, re-addition and cancellation during graceful removal/background settling. Mirrored selection is unit-tested with reversed connector order and physical-ID configs.
- `python3 -I tests/integration/run-t24-nested.py`: all eight checks pass in a private headless GNOME Shell 50.1. Video changes, rapid bursts, VO and fit changes never exceeded one player or socket; removal left no players, sockets or refs and restored the original URI/options. Re-adding a config reapplied the published wallpaper.
- `python3 -I tests/integration/run-t23-nested.py`: all checks pass, including a newly published optimized entry switching the live shell player without re-enabling. No transcode runs in the shell.
- `python3 -I tests/integration/run-t09-nested.py --cycles 10 --modes normal`: verified playback, pause reasons, all ten lifecycle cycles, no overlap/errors, no surviving players and no sockets.
- The headless test stage explicitly hides the startup Overview and drives screenshots so the compositor paints. Before that fixture fix, startup correctly waited for a paintable stage and queued reconciles behind it.
- Nested runners now seed real `monitor-configs`; the temporary environment fallback is removed. T10's private VO/hwdec injection anchor is updated too; saved benchmark fixtures are untouched.

Visual limits: prepared-static ordering and absence of process/socket overlap are verified mechanically. No real-session black-frame/perceptual judgment or physical mirrored-display test was performed; those remain manual review checks.
