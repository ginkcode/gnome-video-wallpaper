# T10 — Video output benchmark

Isolated nested-session measurements of mpv `--vo` and `--hwdec` on the development device (GNOME Shell 50.1, AMD Radeon 780M, mpv 0.41.0). These results do not close the T09 real-session gate and do not claim production HDR rejection.

## Method

- Private fixture only (`python3 -I tests/integration/run-t10-benchmark.py`). No real-session install, settings change, extension change, or process termination outside exact fixture PIDs, which are validated against the fixture runtime directory with pidfds before any signal.
- Media generated locally by `tests/integration/t10-media.py` (recipes in [../media/README.md](../media/README.md)): 1080p H.264 MP4, 4K H.265 MKV, 1080p VP9 WebM, MOV, 1080p AV1, animated GIF, plus SAR 4:3, rotation (verified in ffprobe side data), and tagged BT.709 SDR. HDR is a separate negative control; the harness rejects it with an actionable message and the benchmark records that rejection.
- Matrix: `--vo` in `gpu-next`, `gpu`, `dmabuf-wayland`, `wlshm` × `--hwdec` in `vaapi`, `vaapi-copy`, `no`, on all nine formats (108 rows). Each viable pair ran 60 s in three phases: visible, maximized-cover/unpaused, maximized-cover/paused. The control window is a zenity dialog owned by the probe (exact PID), maximized and asserted to contain the primary work area; this is not the T19 automatic coverage controller.
- Readiness was instrumented before enable: paused-content completion and independent compositor first-frame completion were stamped separately and reconciled against the asset identity for every viable row; unsupported startup, invalid clone rendering, and stalls are explicit failures. A static still can never count as playback: separated captures 1.3 s apart must advance loop-aware by ≥0.8 s, and every 5 s IPC interval in a moving phase must advance ≥70% of elapsed.
- Sampling every 5 s: process CPU/RSS (sampled from `/proc/<pid>/stat` at 5 s intervals with parallel `pidstat` streaming logs for the exact Shell and player PIDs), IPC `frame-drop-count`/`vo-delayed-frame-count`/`time-pos`, and sysfs GPU busy/VRAM with baseline. GPU busy is device-wide and includes the real session, so it is contextual, not attributable to the fixture alone.
- Capture validation compares screenshots against time-shifted expected frames, with capture-vs-capture change required to confirm motion. The validator used during the run compared reference frames to themselves, so its stored 0.0 errors are invalid. It is now fixed and regression-tested. See "Clone geometry" below for what a manual re-check of the retained screenshots found.
- Requested versus effective decoder/VO was recorded from IPC. Hardware decode fell back to software on every `wlshm` row that requested `vaapi`, and on every GIF row that requested hardware decode.

## Results

All 108 rows completed (108 = 9 formats × 4 VOs × 3 hwdecs): 54 viable, 54 stalled. Across viable rows, VO frame drops (`frame-drop-count`) were 0 in all 2,106 samples. "Viable" means readiness, IPC advancement and motion checks passed; the stored capture-match result is not evidence (see "Clone geometry"). 107 of 108 rows had zero surviving processes before cleanup (`gif-wlshm-vaapi-copy` had 1 surviving process cleaned up by the harness).

Player (mpv) mean CPU % per phase for viable rows on `dmabuf-wayland`:

| Format | `vaapi` | `vaapi-copy` | `no` (software) | Effective HWDEC on `vaapi` |
|---|---|---|---|---|
| H.264 1080p (MP4/MOV, SAR, rotation, tagged SDR) | 3.1–3.4% | 10.4–11.0% | 15.5–16.0% | `vaapi` |
| H.265 4K | 3.5% | 25.9% | 92.0% | `vaapi` |
| VP9 1080p | 2.9% | 10.0% | 21.6% | `vaapi` |
| AV1 1080p | 2.7% | 8.9% | 25.6% | `vaapi` |
| GIF 1080p | 9.2% | 8.5% | 6.9% | `no` (fallback: no hwdec) |
| Paused (video formats) | 0.07–0.12% | 0.25–0.68% | 0.40–2.89% | — |

GNOME Shell mean CPU during `dmabuf-wayland` playback was 5.8–7.8% (visible/covered) and 0.32–0.73% (paused).

### Hardware decode fallback

12 of the 54 viable rows had `decoderFallback: true` with effective `hwdec=no`:
- All 9 `wlshm` rows with requested `vaapi` fell back to software decode.
- All 3 GIF rows requesting `vaapi` or `vaapi-copy` fell back to software decode (`hwdec=no`). The variation between requested hwdec runs on GIF (6.9–9.2%) represents run-to-run software decode variance.

For all 8 video formats on `dmabuf-wayland`, requested `vaapi` operated without fallback with effective `hwdec=vaapi`.

### Software & fallback VO comparison

- **H.265 4K**: `vaapi-copy` CPU (25.9%) was 7.4× `vaapi` (3.5%); software decode (92.0%) was 26.2× `vaapi`.
- **wlshm**: viable as a software fallback, but high CPU overhead: 48.9–81.4% mpv CPU on 1080p video, 131–150% on 4K/GIF, with gnome-shell CPU increasing to 8.8–11.0%. Across formats, `wlshm` required 14.3–42.6× the mpv CPU of `dmabuf-wayland+vaapi`. Paused CPU on `wlshm` averaged 1.3–6.6% (single-sample spikes up to 79%). It remains in `auto` only as a fallback.

### Clone geometry

A re-check of 3 screenshots per viable row (preflight, visible, uncovered) against corrected references found:

- The clone shows the correct, moving content on every viable row, for every VO and decoder.
- Landscape 16:9 sources (H.264, H.265, VP9, AV1, MOV, SAR) are shown as the **whole frame stretched** to the 1024×768 monitor, not the requested `fill` crop. They differ from the fill reference by ~55 mean RGB and from a full-frame stretch by 8–12. A re-run with `panscan=0` rendered identically, so `panscan` had no visible effect on this path.
- Rotation matches its autorotated fill reference (~8–9). GIF and tagged SDR match within 0.1–6.
- `uncovered-a` captures still include the coverage dialog, which had not finished closing, so they cannot match any reference.

This does not change the VO/hwdec decision. Fit-mode fidelity under the hidden-window + clone path is an open issue for T14/T24.

### Stall pattern

Stalls are tied to the VO, not the decoder: `gpu-next` and `gpu` stalled on **all 9 formats × all 3 hwdecs** (27 rows each, 54 total). mpv 0.41's `gpu`/`gpu-next` VOs stall during preflight with the hidden source window + clone path on this device, independent of hardware decode — matching the T09 PoC observation. The stall is a compositor/VO clone-rendering path issue, not a decode issue.

### Per-phase behavior

Raw rows are recorded in the fixture `checkpoint.json` (each row has `result.json`, `shell.log`, `pidstat-*.log`, captures, staged patch, and aggregates).
- Paused phase asserts stationary `time-pos`; all viable rows froze under the maximized coverage window with the `t10-coverage` pause reason.
- Uncover resumed playback (IPC `time-pos` advanced ≥0.8 s over 1.3 s).

## Decision

The measured default on this device is `--vo=dmabuf-wayland` with `--hwdec=vaapi`, which the T09 provisional `auto` mapping (`dmabuf-wayland,wlshm`) already selects; **the existing default is retained**. Supporting numbers: `dmabuf-wayland+vaapi` uses 2.7–3.5% player CPU on all video formats (including 4K H.265) and ~0.1% while paused, ~7.4× cheaper than `vaapi-copy` on 4K H.265, ~26.2× cheaper than software decode on 4K, and 14–43× cheaper than `wlshm`.

No production code changes were required: `lib/mpvArgs.js` already defaults to `--hwdec=vaapi`, and `lib/playerManager.js` already maps `auto` to `dmabuf-wayland,wlshm`.

## Limitations & Telemetry notes

- **Nested headless Shell**: not the real session. Real-session verification remains the user's T09 gate, which T10 does not close.
- **Frame drops**: `frame-drop-count` (VO frame drops) was 0 across all samples; `decoder-frame-drop-count` was not exposed in mpv IPC. `vo-delayed-frame-count` was nonzero in 109 viable row-phases (up to 7 frames delayed).
- **GPU telemetry is contextual**: sysfs metrics (`gpu_busy_percent`, `mem_info_vram_used`) are device-wide and include the host session. Baseline GPU busy varied from 0% to 48% across runs depending on host activity; GPU deltas were within noise margins (~1–4%). No per-process GPU attribution was available.
- **Stalled rows**: `gpu` and `gpu-next` stalled during preflight before steady-state 5 s metrics were collected (0 samples recorded for those rows).
- **HDR rejection**: HDR rejection in this test is a harness negative control over generated HEVC Main10 PQ BT.2020 media, not a production probe; production HDR rejection is T11.
- **Sampling methodology**: CPU and RSS aggregates are computed from 5 s `/proc/<pid>/stat` sampling (first sample is null delta); parallel `pidstat` processes recorded raw text logs to the fixture directory.
- **Resume migration**: Checkpoints recorded a harness migration note ("harness sources changed; assets and configuration identical") when resuming across matrix runs; content asset hashes were verified identical.