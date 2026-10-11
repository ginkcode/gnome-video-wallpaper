# T10 — Video output benchmark (spike)

- **Milestone:** M1
- **Depends on:** T09
- **Status:** review
- **Owner:** Claude Code
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

- [x] Decision documented with numbers in [../benchmarks/vo-benchmark.md](../benchmarks/vo-benchmark.md): 108 rows (9 formats × 4 VOs × 3 hwdecs), 54 viable / 54 stalled, zero VO frame drops. `dmabuf-wayland+vaapi` is 2.7–3.5% player CPU on H.264/H.265/VP9/AV1/SAR/rotation/SDR and ~0.1% paused, versus 15.5–92% software decode and 48.9–150% for `wlshm`.
- [ ] Chosen default (`auto` → `dmabuf-wayland,wlshm`, `--hwdec=vaapi`) plays every sample SDR format as moving wallpaper in the isolated nested session (readiness, loop-aware advancement, screenshots show correct moving content). Not fully met: 16:9 sources render as a full-frame stretch instead of the requested `fill` crop (see benchmark "Clone geometry"). Nested-session evidence only; the real-session gate remains T09.
- [x] Each viable row recorded separate paused-content and compositor first-frame readiness stamps reconciled against the asset identity, plus a maximized coverage window (exact PID, work-area containment) pausing only via the `t10-coverage` reason and resuming on uncover. `gpu` and `gpu-next` stalled at preflight on all 54 of their rows and are recorded as unsupported on this device rather than counted as playback.
- [x] Samples include SAR 4:3, rotation (verified in ffprobe side data) and tagged BT.709 SDR, all viable on the chosen default. The HDR negative control is rejected by the harness with an actionable message (`hdr-negative-control.json`); this is a harness negative control, not production HDR rejection, which is T11.

## Notes

- No production change: measurements support the existing default, so `lib/mpvArgs.js` and `lib/playerManager.js` are unchanged. VO/hwdec were injected only into the private staged copy of `playerManager.js`; the source anchor is asserted and the staged diff/hash recorded per row.
- `wlshm` is viable but a CPU-copy path and stays in `auto` only as fallback. On `wlshm`, requested `vaapi` always fell back to software decode (`hwdec=no`). GIF decode is software-only regardless of requested hwdec (mpv/vaapi has no GIF hardware decoder), so all GIF rows ran software decode.
- Raw evidence is retained in the private fixture (`checkpoint.json`, per-row `result.json`, `shell.log`, `pidstat-*.log`, captures, staged patch). GPU busy is contextual and device-wide, not attributable to the fixture.
