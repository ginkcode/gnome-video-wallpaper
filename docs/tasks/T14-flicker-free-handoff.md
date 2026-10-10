# T14 — Flicker-free still → video handoff

- **Milestone:** M2
- **Depends on:** T09, T12, T13
- **Status:** todo
- **Owner:**
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

- [ ] 60 fps recordings of login, enable and replacement demonstrate SDR perceptual continuity without a visible color/scale/position jump; do not assert pixel identity across pipelines.
- [ ] Fill, fit, stretch modes all match.
- [ ] Killing mpv mid-start leaves the still visible with no black frame.
- [ ] Anamorphic SAR, 90°/270° rotation, tagged SDR and optimized FIT/STRETCH samples match; HDR fails with actionable prefs guidance.
- [ ] Clear/delete optimized cache during acquisition uses original plus original still; clear cache during handoff does not invalidate playback/publication.
- [ ] Early content/paint events, delayed background loading, cancellation during both waits/fade, and rapid disable/re-enable cannot flash, hang, spawn stale work or overlap players.
- [ ] Replacement recordings show the matching static is displayed before old clone removal and before old stop/reap; pause reasons survive fade completion.
