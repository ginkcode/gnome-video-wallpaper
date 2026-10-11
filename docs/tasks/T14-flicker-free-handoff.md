# T14 — Flicker-free still → video handoff

- **Milestone:** M2
- **Depends on:** T09, T12, T13
- **Status:** review
- **Owner:** Claude Code
- **Skills:** Clutter animation, mpv IPC, careful visual testing

## Goal

Login and enable show the persistent still immediately; video handoff targets tested SDR perceptual continuity without a visible jump, not pixel identity across rendering pipelines.

## Deliverables

- In `PlayerManager.start()` per logical monitor:
  1. Probe → acquire selected `PlaybackAsset` → `ensureStill(asset, geometry, cancellable)` → `publishWallpaper` → guarded `WallpaperSync.apply(publishedUri)` (single-monitor; spanned handled in T26). Choose original fallback before still selection if optimized media is unavailable; never silently switch assets afterward.
  2. `prepareStatic(publishedPath)` and display the matching owned actor; install `watchWindow` synchronously before spawning idle/no-file paused mpv.
  3. Connect and subscribe/reconcile IPC before `loadfile` of the private asset path; use identity fitting for baked geometry, configured fitting otherwise. Attach the already-hidden window, await both latched cancellable `waitForContent({assetIdentity, ...})` and `waitForFirstFrame(...)` with verified M1 evidence.
  4. `fadeIn(300, {cancellable})`, then clear only `startup` pause reason. Coverage/Overview/battery reasons remain authoritative. Keep static underneath until system background is known loaded or continue using it underneath playback.
- Replacement is old video → preloaded/displayed matching replacement static → remove old clone → bounded stop/reap old process → start/fade new player. No old/new player overlap; every instance owns a unique socket and all starts serialize with reaping, including re-enable. Release old asset only after reap.
- Prepare stills/publications on selection when possible; on login the persistent published still is already the system wallpaper. No login transcode. Cache misses/original fallback must prepare the exact asset's matching still before handoff; guard every probe/acquisition/publication/readiness/fade continuation by lifecycle generation and cancellation.
- If any step fails or times out (10 s), leave the still visible and hand off to the supervisor (T16).

## Acceptance criteria

- [ ] 60 fps recordings of login, enable and replacement demonstrate SDR perceptual continuity without a visible color/scale/position jump; do not assert pixel identity across pipelines. Not recorded: needs a real-session or capture-capable nested run.
- [ ] Fill, fit, stretch modes all match. Still geometry is unit-tested in T12; the visual match with mpv is unverified.
- [ ] Killing mpv mid-start leaves the still visible with no black frame. Unit-tested: an unexpected exit or failed step keeps the layer and calls `showStatic()`. Visual check pending.
- [ ] Anamorphic SAR, 90°/270° rotation, tagged SDR and optimized FIT/STRETCH samples match; HDR fails with actionable prefs guidance. Still-side handling is tested in T11/T12, and HDR stops at probe before any still or wallpaper write. The visual comparison against mpv and the prefs message (T21/T22) are pending.
- [x] Clear/delete optimized cache during acquisition uses original plus original still; clear cache during handoff does not invalidate playback/publication. Covered by the T12 tests; playback loads the private reference and the layer shows the published copy.
- [x] Early content/paint events, delayed background loading, cancellation during both waits/fade, and rapid disable/re-enable cannot flash, hang, spawn stale work or overlap players. Unit tests stop at each of 12 boundaries. A headless nested T09 run (5 cycles) had at most 1 player, no errors, no leftover sockets and all players reaped.
- [ ] Replacement recordings show the matching static is displayed before old clone removal and before old stop/reap; pause reasons survive fade completion. The order and pause-reason survival are unit-tested; recordings are pending.

## Notes

- `PlayerManagerLifecycle` runs probe, acquire, `ensureStill`, publish and apply, then the handoff and launch. Every await checks the generation and cancellation. An asset acquired after `stop()` is released at once. Otherwise assets are released only after their process is reaped.
- The system wallpaper is written only when there is exactly one logical monitor; spanned stills are T26.
- `start()` and `reconcile()` runs are serialized, and queued requests are coalesced. Calling `reconcile()` with an unchanged `selectionKey` is a no-op.
- Replacement order:
  1. The old layer preloads the new still and calls `showStatic()`, which removes the old clone.
  2. The old player gets a graceful 1 s stop and is reaped, then its asset is released.
  3. A new layer preloads the same still underneath, then the old layer is destroyed.
  4. The new player is spawned.
- On failure, the layer and still stay and the player is terminated. Retries are T16.
- Geometry is the logical rectangle scaled to raster pixels. Without stored selections, only `GINK_VW_TEST_FILE` is used; the staged still fixture is gone.
- Disable does not restore the original wallpaper yet; that is T17. In the T09 nested run, the published still therefore stays after disable, and its outdated "not green after disable" check fails as expected.
