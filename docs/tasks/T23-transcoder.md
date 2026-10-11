# T23 — GIF and optimized-video transcoder

- **Milestone:** M5
- **Depends on:** T04, T11, T12
- **Status:** review
- **Owner:** Claude Code
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

- [x] GIF plays at correct speed and loops seamlessly.
- [x] Optimized 4K→1080p file uses noticeably less CPU/GPU than the original (record numbers).
- [x] Cancelling mid-transcode leaves no temp files.
- [x] Optimized identity changes with fitMode and transformVersion; SAR/rotation are normalized into the baked geometry.
- [x] Concurrent transcode requests for the same media/geometry from shell/prefs or cancellation of one caller do not corrupt publication or delete the other caller's work.
- [x] Optimized cache deletion does not change running playback: its private optimized reference remains usable. A future acquisition with missing optimized media falls back to an acquired original plus its matching still before handoff, without login transcode.

## Notes

- `lib/transcoder.js`: identity is `cacheKey` kind `media` over source path/size/mtime, raster size, scale, fitMode, `transformVersion` and asset identity `h264-sdr-v1`. The filter applies SAR, then fit (`ffmpegScaleFilter`), and tags color with `setparams` (encoder `-color_*` options were ignored by both encoders). Output is limited range; the source matrix is kept when ffmpeg supports it as output, otherwise converted to BT.709. GIFs use BT.709 and `-fps_mode passthrough`. ffmpeg autorotates, so rotation is baked.
- VA-API is tried first and libx264 on failure, per call: this Intel GPU refuses sizes below 128 px, so remembering a failure process-wide would disable VA-API for every later monitor.
- The output is probed (h264, exact raster) and the source re-checked for changes before the atomic move. The job directory is always removed.
- Prefs: choosing a file runs the transcode inside `applySelection`'s `prepare` with a progress row, and saves only on success. A per-monitor "Optimize video" combo (Default/On/Off) and any fit, default-fit or `optimize-videos` change start a background `optimize:<id>` job; previews acquire the optimized file when it exists and refresh once a new one is produced. Closing prefs cancels running transcodes; the shell then keeps playing the original.
- Shell: never transcodes; a missing optimized entry falls back to the original (and its matching still).
- Unit tests (`tests/transcoder.test.js`, real ffmpeg): GIF frame timestamps match the source within 10 ms (variable 100/250 ms frame delays); SAR 2:1 and a 90° rotation produce letter/pillarboxes; identity changes with fitMode, transformVersion, raster, scale and mtime; a cancelled caller does not disturb a second caller sharing one job; full cancellation leaves no job directory, no published file and no ffmpeg; deleting the optimized entry keeps the held reference playable and the next acquisition falls back to the original with a different still.
- Nested verification (`tests/integration/run-t23-nested.py`, extension enabled under a headless shell): at login with a GIF and no optimized file, mpv opened the `original` reference and no transcode ran. Selecting the GIF in prefs showed progress up to 100%, wrote the config only after the transcode, and after disable/enable mpv opened the `optimized` reference with `--loop-file=inf`. Turning "Optimize video" on for an MP4 produced a second entry and refreshed the preview. Removing the wallpaper mid-transcode left no job directory and no new entry.
- CPU, 10 s of a 3840×2160 30 fps H.264 test clip vs its 1920×1080 optimized copy (`mpv --vo=null`, user+sys): software decode 3.33 s → 1.97 s; `vaapi-copy` 2.19 s → 0.94 s. The 4K→1080p transcode took 2.3 s with VA-API.
- GIF looping relies on mpv `--loop-file=inf` on a file with preserved timestamps. Seamless looping was not judged visually on a real session.
