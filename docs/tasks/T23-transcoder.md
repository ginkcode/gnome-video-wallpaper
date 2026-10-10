# T23 — GIF and optimized-video transcoder

- **Milestone:** M5
- **Depends on:** T04, T11, T12
- **Status:** todo
- **Owner:**
- **Skills:** ffmpeg, VA-API encoding

## Goal

Convert GIFs (always) and videos (when `optimize-videos`/per-monitor `optimize`) to a monitor-sized, hardware-decodable H.264 file so playback is cheap.

## Deliverables

- `lib/transcoder.js` — per [interfaces.md](interfaces.md#libtranscoderjs-t23-shell--prefs):
  - `ensureOptimized(media, {width, height, scale, fitMode, transformVersion}, {onProgress, cancellable})`: completed MP4 path (SDR H.264, VA-API decodable), geometry already baked. Target dimensions are target raster size, not raw unlabelled mode dimensions. Normalize SAR and rotation; preserve consistent SDR color metadata.
  - Key/identity incorporates source metadata, fitMode, versioned transformation (`TRANSFORM_VERSION = 1`) and raster dimensions. Output under `~/.cache/gink-video-wallpaper/media/<key>.mp4`, no audio, `yuv420p`, `-movflags +faststart`, keyframe interval ~2 s.
  - Unique job directories/temps and atomic publication; process-local promise deduplication is not a cross-process lock. Cancellation kills only caller-owned ffmpeg and deletes its own temp.
  - Encoder: try `h264_vaapi` (`-vaapi_device /dev/dri/renderD128`), fall back to `libx264 -preset veryfast -crf 20`.
  - GIF: preserve timing (`-fps_mode passthrough` or `-vf fps=<source fps>`), loop handled by mpv; low priority (`nice -n 15 ionice -c3`).
- Integration:
  - Prefs (T21): when a GIF is selected or optimize enabled, start transcode with progress bar; save config after success.
  - Shell: if a config requests an optimized file that is missing or deleted during acquisition, fall back to the acquired original and request no transcode during login/startup. Prefs shows transcode status/hints.
- Still extraction (T12) matches the acquired `PlaybackAsset`: if optimized is used, extract from optimized (with baked geometry, no second fitting); if original fallback is used, extract and fit from original. Still and playback must share the exact same asset.

## Acceptance criteria

- [ ] GIF plays at correct speed and loops seamlessly.
- [ ] Optimized 4K→1080p file uses noticeably less CPU/GPU than the original (record numbers).
- [ ] Cancelling mid-transcode leaves no temp files.
- [ ] Optimized identity changes with fitMode and transformVersion; SAR/rotation are normalized into the baked geometry.
- [ ] Concurrent transcode requests for the same media/geometry from shell/prefs or cancellation of one caller do not corrupt publication or delete the other caller's work.
- [ ] Optimized cache deletion does not change running playback: its private optimized reference remains usable. A future acquisition with missing optimized media falls back to an acquired original plus its matching still before handoff, without login transcode.
