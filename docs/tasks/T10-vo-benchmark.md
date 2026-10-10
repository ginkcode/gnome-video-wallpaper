# T10 — Video output benchmark (spike)

- **Milestone:** M1
- **Depends on:** T09
- **Status:** todo
- **Owner:**
- **Skills:** Linux performance tools, mpv

## Goal

Choose the default mpv `--vo` and `--hwdec` for this device with data.

## Steps

1. Test files (commit small samples or document sources under `tests/media/README.md`): 1080p H.264 MP4, 4K H.265 MKV, 1080p VP9 WebM, MOV (ProRes or H.264), 1080p AV1, animated GIF.
2. For each `--vo` in `gpu-next`, `gpu`, `dmabuf-wayland` and `--hwdec` in `vaapi`, `vaapi-copy`, `no`:
   - Run as wallpaper via the PoC for 60 s.
   - Record mpv CPU % (`pidstat -p <pid> 5`), gnome-shell CPU %, GPU busy (`amdgpu_top` or `radeontop`), RSS, dropped frames (`ipc get_property frame-drop-count`).
   - Confirm `Clutter.Clone` renders correctly (some VOs may not clone well).
3. Repeat with a maximized window on top (paused and unpaused).

## Deliverables

- `docs/benchmarks/vo-benchmark.md` with table of results and the decision.
- Update `auto` mapping in `lib/mpvArgs.js` and [../settings.md](../settings.md).

## Acceptance criteria

- [ ] Decision documented with numbers.
- [ ] Chosen default plays every sample format correctly as wallpaper.
- [ ] Each viable VO demonstrates paused-asset content and independent compositor readiness through the subscribe-before-load flow; record any unsupported VO instead of treating playback alone as readiness proof.
- [ ] Samples include SAR/rotation and tagged SDR; unsupported HDR is rejected with an actionable message, not benchmarked as silently misinterpreted SDR.
