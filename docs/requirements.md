# Requirements

## Goal

Let users set a video or animated GIF as the GNOME desktop wallpaper, with independent selection per monitor.

## Problems to avoid (observed with Hanabi on this device)

1. **Startup flicker** — the static wallpaper shown at login differs from the video, causing a visible jump when the video starts.
2. **Slow login / resource contention** — after logout/login the video takes a long time to appear, and other applications struggle to start meanwhile.
   - Observed: Hanabi's preferred `GstPlay` typelib is missing, so it falls back to `GtkMediaFile`; its renderer was started twice in a single boot.

## Decisions

| Topic | Decision |
|---|---|
| Name | Gink Video Wallpaper |
| UUID | `gink-video-wallpaper@ginkcode.github.io` |
| License | MIT |
| Target | GNOME Shell 50, Wayland only (first) |
| Per-monitor selection | Required |
| External tools | `mpv`, `ffmpeg`, `ffprobe` allowed and used |
| Audio | Always off; no option |
| Overview / workspace thumbnails | Show the static still image, not live video |
| System wallpaper | Extension sets GNOME wallpaper to the video's first frame; restores the original on disable |
| Maximized / fullscreen windows | Pause the video on that monitor |
| Pause on battery | Enabled by default |
| Default fit mode | Fill / crop to cover |
| Lock screen | Players stopped; lock screen shows the still image |
| Distribution | Perfect on this device first; publish to extensions.gnome.org later |

## Supported media

- SDR video containers: MP4, MKV, MOV, WebM, and other supported `mpv` codecs.
- Animated GIF: prepared once as a target-sized SDR H.264 file for hardware decoding; no transcoding during login.
- Support depends on codecs, not file extensions; `ffprobe` validates sample aspect ratio, rotation and color metadata as well as video streams. HDR sources are initially rejected with an actionable preferences error, pending explicit tone-mapping design.
- Playback and still extraction use the exact same acquired asset. Optimized assets include fit mode and a versioned transformation identity; baked geometry is never fitted twice. If a prepared asset is missing, the original and its matching still are selected together.

## Non-goals (for now)

- Playlists / slideshows, online sources, audio playback.
- Spanning one video across multiple monitors.
- X11 and GNOME versions before 50.
- Live video inside the Overview.

## Quality requirements

- Tested SDR perceptual continuity between the login/lock still and the paused first video frame, with consistent geometry and color interpretation—not pixel identity across independent rendering pipelines.
- No heavy work before GNOME reports startup complete; no transcode during login.
- Video playback must never block GNOME Shell's main loop (all I/O and subprocess work is async).
- A crashing player must not affect the shell; restart is bounded.
- Readiness is latched before spawning/loading: immediate window hiding, IPC subscribed before paused media load, persistent-state reconciliation plus events, and independent cancellable compositor/content gates.
- A live selection change may briefly show the preloaded matching still. Old player reaping precedes replacement; there is at most one live player per logical monitor.
- `disable()` synchronously invalidates generations, cancels work, removes actors/signals/timers, and requests forceful termination. Residual reaping owns only its old process/socket. Wallpaper restores on user disable, not lock; stale work cannot affect re-enable. Shell-exit child lifetime handling is a feasibility requirement to verify in M1.
- Applied wallpapers are immutable persistent data files, not disposable cache entries. Clear-cache preserves published wallpapers and active jobs/references; publication GC is deferred initially.
- Physical monitor selections remain independent in storage. Mirrored displays share one logical wallpaper, chosen by first configured connector in stable sorted order and explained in preferences. Logical transformed rectangles, common canvas scale and shared edge rounding define multi-monitor composition.
