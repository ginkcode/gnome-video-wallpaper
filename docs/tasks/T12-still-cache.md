# T12 — Still frame cache (ffmpeg)

- **Milestone:** M2
- **Depends on:** T04, T11
- **Status:** todo
- **Owner:**
- **Skills:** ffmpeg, async GJS

## Goal

Acquire the exact playback bytes and generate their matching still with identical display geometry and SDR interpretation. Promise tested perceptual continuity, not pixel identity across color pipelines.

## Deliverables

- `lib/cacheKey.js` [pure] — per [interfaces.md](interfaces.md#libcachekeyjs-t12-pure), `GLib.compute_checksum_for_string(SHA256, ...)`.
- `lib/stillCache.js` — implement `acquirePlaybackAsset(media, geometry, {optimizedPath = null, cancellable})`, `releasePlaybackAsset(asset)`, `ensureStill(asset, geometry, cancellable)`, `publishWallpaper(stillPath, cancellable)` and `clearCache(cancellable)` per the contract (spanned composition is T26).
  - `PlaybackAsset` records stable private `path`, exact `identity`, `geometryBaked`, source metadata and target `geometry`. Acquire by private copy/hard link outside the clear-cache snapshot before load; deletion during acquisition retries or falls back to the original. Never generate a transcode here or during login. `releasePlaybackAsset` releases only the caller-owned reference, including cancelled non-spawn and prefs consumers, without waiting for a player reap. Spawned playback references are released only after their own reap.
  - Cache identity includes source metadata, exact asset identity, raster width/height, scale, fitMode and `transformVersion`. Completed stills are immutable entries under `~/.cache/gink-video-wallpaper/stills/<key>.png`.
  - Extract frame 0 from the acquired asset using low-priority ffmpeg. Normalize SAR/rotation and interpret SDR color metadata consistently with playback; do not hard-code every source as BT.709. Fit originals with `ffmpegScaleFilter`; do not fit `geometryBaked` optimized media twice. Target dimensions are raster geometry, not raw monitor-mode dimensions.
  - Every producer uses its own unique job directory/temp file and atomically publishes a completed entry. Process-local promise deduplication is not a cross-process lock; simultaneous shell/prefs producers must remain safe. Cancellation settles a caller promptly and cleans only its own job/temp, not another caller/process producer or shared publication.
  - `publishWallpaper` first acquires a caller-owned private reference to its cache input. If clear-cache deletes that input during acquisition, retry acquisition or regenerate the still from the exact acquired playback asset; do not publish a partial or stale file. Then atomically publish an immutable PNG via a unique temp under `$XDG_DATA_HOME/gink-video-wallpaper/wallpapers/`; applied URI never points into cache. Release the private input reference after successful publication, failure, or cancellation. Defer publication GC, including after restore.
  - `clearCache` snapshots eligible completed entries only; exclude active private references/jobs and published wallpapers. Return `{removedBytes, preservedActiveBytes, preservedWallpaperBytes}`. Guard all async acquisition/extraction/publication continuations by generation/cancellation; no stale lifecycle may apply settings.
- `tests/cacheKey.test.js`, `tests/stillCache.test.js` (skip if ffmpeg missing).

## Acceptance criteria

- [ ] Still dimensions equal target raster geometry for fill/fit/stretch; optimized geometry-baked FIT/STRETCH are not fitted again.
- [ ] Second call returns cached path without spawning ffmpeg.
- [ ] Changing file mtime or fit mode produces a new key.
- [ ] GIF input produces the first GIF frame.
- [ ] Original/optimized choice, fitMode and transformVersion each affect identity; still extraction uses exactly the acquired asset bytes. Missing/deleted optimized media selects an acquired original and its matching still before handoff.
- [ ] Clear cache during acquisition, active playback, extraction and publication is safe; only snapshot-eligible completed entries disappear, active/private/published paths remain usable. A clear-cache race against `publishWallpaper` retries or regenerates its private input rather than publishing a missing/partial file.
- [ ] Cancelling a non-spawn or prefs consumer releases only its own playback/input reference and temp; another caller's reference, producer and shared publication remain intact.
- [ ] Concurrent shell/prefs same-key producers use distinct temps and publish valid complete files; cancelling one caller leaves the other producer/result intact.
- [ ] Source replacement/deletion and cancellation at each await cannot publish/apply a stale wallpaper; persistent wallpaper remains valid after cache clearing and extension restore.
