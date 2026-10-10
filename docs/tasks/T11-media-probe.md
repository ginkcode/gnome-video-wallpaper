# T11 — Media probe (ffprobe)

- **Milestone:** M2
- **Depends on:** T03
- **Status:** todo
- **Owner:**
- **Skills:** ffprobe, async GJS

## Goal

Validate a user-selected file and extract metadata, asynchronously.

## Deliverables

- `lib/mediaProbe.js` — per [interfaces.md](interfaces.md#libmediaprobejs-t11-shell--prefs).
  - `Gio.File.query_info_async` for `size`, `mtime` (`time::modified`), existence, regular file.
  - `ffprobe -v error -print_format json -show_streams -show_format -select_streams v:0 <path>` via `spawnAsync`.
  - `isGif`: `format_name` contains `gif`.
  - Return the contract fields, including `sampleAspectRatio`, rotation (including side-data), `colorPrimaries`, `colorTransfer`, `colorSpace`, `colorRange`, and `isHdr`, alongside coded width/height and existing metadata. Validate normalized display geometry and SDR interpretation; reject HDR with an actionable `ProbeError` explaining that tone mapping is unsupported and suggesting an SDR source.
  - `ProbeError` with `code`: `NOT_FOUND`, `NOT_REGULAR`, `NO_VIDEO_STREAM`, `FFPROBE_MISSING`, `FFPROBE_FAILED`, plus explicit unsupported-HDR/invalid-display-geometry errors.
  - Simple process-local in-memory cache keyed by `path|size|mtime`. Caller cancellation must not kill another caller's shared work; guard stale results by generation/cancellation and settle cancelled waits promptly.
- `lib/deps.js` — `findProgram(name)` via `GLib.find_program_in_path`; `checkDependencies()` → `{mpv, ffmpeg, ffprobe, vaapi}` (vaapi: `mpv --hwdec=help` contains `vaapi`, async).
- Tests with sample files (skip if ffprobe missing): MP4, MKV, MOV, WebM, GIF, a text file, missing file.

## Acceptance criteria

- [ ] Correct metadata for each sample.
- [ ] Each error case maps to the right `ProbeError.code`.
- [ ] Never blocks the main loop.
- [ ] Anamorphic SAR, 90°/270° rotation and tagged SDR samples expose correct display/color metadata; HDR rejection explains the supported alternative.
- [ ] Cancel a probe or change selection while probing: no stale settings/preview update and no other caller's work is removed.
