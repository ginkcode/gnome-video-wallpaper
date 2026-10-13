# Testing

## Automated

- **Lint:** ESLint with GNOME Shell extension config (`npm run lint`).
- **Unit tests (gjs):** `lib/geometry.js` fit math and logical canvas mapping, cache key generation including fit/transformation identity, physical/logical monitor parsing, settings migration, and playback-asset fallback selection.
- **Schema:** `glib-compile-schemas --strict schemas/`.

## Planned regression matrix

These are future implementation tests, not results from the planning repository. Runtime tests are not applicable to this docs-only revision.

| Area | Stimulus | Required evidence |
|---|---|---|
| Missed events | Window/content events arrive before a Promise continuation; content waiter attaches late | Pre-spawn listener hides in creation callback; persistent reconciliation and latches still complete the two distinct gates |
| Readiness cancellation | Cancel before spawn, during IPC connect/load, compositor paint, or fade | Every wait rejects/settles promptly; no later callback changes actors or resumes a stopped player |
| Pause race | Battery/coverage/Overview reason arrives during startup fade | Fade removes only startup reason; other reasons keep playback paused |
| Replacement | Rapid file/fit changes; new still load delayed | Prepared still displayed before old clone removal; old process reaped before new spawn; one live player per logical monitor |
| Disable/re-enable | Disable during probe, publish, delay, fade, retry, graceful stop; immediately enable | Generation guards reject stale shell work; synchronous resource revocation and forceful termination request; isolated old process/socket reap |
| Shell lifetime (M1) | Normal and abnormal Shell exit in an isolated test session | Record child fate; verify external lifetime mechanism if needed, rather than assuming automatic child death |
| Cache acquisition | Clear-cache/deletion between lookup and private reference acquisition | Retry or original fallback; acquire matching still before load; no path switch under a different still |
| Concurrent producers | Shell and prefs request same asset; cancel one; clear while jobs run | Unique temps and atomic publication; process-local dedup only; cancellation removes caller-owned work, not another producer |
| Cache clear/publication | Clear while media plays and while wallpaper is applied; then restart/login | Snapshot excludes active work/references and persistent publications; published wallpaper still readable; prefs reports preserved bytes |
| Transform identity | Optimize same source for fill/fit/stretch and a new transformation version | Different keys/outputs; geometryBaked prevents double fitting; still uses exact selected asset |
| SDR continuity | Compare published still and paused first frame using fill/fit/stretch, anamorphic SAR, rotation, tagged SDR | Record side-by-side/captured visual assessment, geometry and color interpretation; no perceptible SDR jump, not a byte/pixel equality claim |
| HDR rejection | PQ/HLG and other detected HDR inputs | Actionable unsupported-source error, no accidental SDR interpretation/tone mapping |
| Logical layout | Mixed/fractional scales, rotation, negative origins, mirrored groups, hotplug/unmirror | Physical modes separate from logical rectangles; one common raster scale and shared rounded edges; one composition/player per logical rectangle; sorted connector selection and retained physical configs |

For SDR visual acceptance, record the source metadata, selected asset identity, VO, display scale/transform and observed result. A mismatch blocks the relevant milestone; do not claim perceptual continuity solely from matching fit formulas.

## Nested shell

```
dbus-run-session gnome-shell --devkit --wayland
```

Used for enable/disable cycles, window hiding, and crash recovery without logging out.

## Metrics to record

| Metric | How |
|---|---|
| Time to still visible | Journal timestamps from login |
| Time to first video frame | Extension log on fade-in start |
| App launch time during login | Fixed app set, compared with extension disabled |
| CPU / GPU during playback | `top`, `radeontop` / `amdgpu_top`, per VO |
| CPU / GPU while paused | Same, with a maximized window |
| Memory per player | `ps -o rss` |

## Manual checklist

- [ ] Login: persistent still shown immediately, smooth fade to the same asset, no perceptible SDR jump.
- [ ] Readiness: listener installed before spawn; IPC subscribed before paused load; an event emitted before the waiter attaches is still observed through latched/reconciled state.
- [ ] Disable during fade, retry, or reaping, then immediate re-enable: no stale continuation, overlapping player, actor, signal, or grace timer.
- [ ] Clear cache while media is in use: active jobs/private references and published wallpapers survive; only the eligible completed snapshot is removed.
- [ ] Fill, fit, and stretch produce distinct optimized identities; a missing optimized file falls back to its original and matching still without login transcoding.
- [ ] Mixed-scale, rotated, and mirrored monitors: one logical player per mirrored group, stable selection explained in preferences, and the primary monitor's still as the system wallpaper.
- [ ] HDR source: actionable preferences error; SDR sources remain supported.
- [ ] Logout → login repeated 5 times: no slowdown, no duplicate players.
- [ ] Lock → unlock: still on lock screen, video resumes.
- [ ] Suspend → resume.
- [ ] Maximize / fullscreen window pauses; restore resumes.
- [ ] Overview shows still; leaving Overview resumes.
- [ ] Battery unplug pauses (when enabled).
- [ ] Player killed manually: bounded restart, then still with notification.
- [ ] Missing file, corrupt file, unsupported codec: still/original wallpaper kept, error shown in prefs.
- [ ] GIF plays with correct timing and loops.
- [ ] MP4, MKV, MOV, WebM files play.
- [ ] External monitor hotplug, different videos per monitor, mixed scaling.
- [ ] Extension disable keeps the still as the wallpaper and leaves no processes.
- [ ] Works alongside Blur My Shell and Dash to Dock.
