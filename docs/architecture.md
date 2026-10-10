# Architecture

## Overview

```
GNOME Shell process                               Separate processes
┌──────────────────────────────────────┐          ┌──────────────────────┐
│ extension.js                         │ spawn    │ mpv (monitor A)      │
│  ├─ PlayerManager ───────────────────┼─────────►│  Wayland window      │
│  │    └─ MpvIpc (unix socket, async) │◄────────►│  --input-ipc-server  │
│  ├─ BackgroundLayer (Clutter.Clone)  │          └──────────────────────┘
│  ├─ MonitorWatcher                   │          ┌──────────────────────┐
│  ├─ StillCache ──────────────────────┼─────────►│ ffmpeg / ffprobe     │
│  └─ WallpaperSync (GSettings)        │          │ (one-shot jobs)      │
└──────────────────────────────────────┘          └──────────────────────┘
prefs.js (GTK4 / libadwaita, separate process) ── GSettings ── extension.js
```

Decoding happens in `mpv`, outside the shell. The extension only manages processes, windows, and actors, so player crashes or stalls cannot freeze the desktop.

## File layout

```
metadata.json            uuid, shell-version ["50"], settings-schema
extension.js             enable/disable, wiring, startup gating
lib/playerManager.js     per-logical-monitor mpv lifecycle, fade-in, bounded retries
lib/mpvIpc.js            async JSON IPC: pause/resume, events, persistent state reconciliation
lib/backgroundLayer.js   hide player window, clone into per-monitor background, still handoff
lib/monitorWatcher.js    physical/logical monitor identity, hotplug, maximize/fullscreen coverage
lib/stillCache.js        playback-asset acquisition, still frames, published wallpapers
lib/transcoder.js        SDR optimized/GIF transcodes with baked geometry identity
lib/wallpaperSync.js     save, set, and restore org.gnome.desktop.background (persistent publications)
lib/geometry.js          fill / fit / stretch + logical canvas mapping (pure, unit-tested)
prefs.js                 libadwaita preferences, per-monitor sections
schemas/org.gnome.shell.extensions.gink-video-wallpaper.gschema.xml
tests/                   gjs unit tests
eslint.config.js, package.json, Makefile, LICENSE, README.md
```

## Runtime design

### 1. Player processes

- One `mpv` per logical monitor with an assigned file, spawned via `Meta.WaylandClient.new_subprocess` so windows can be identified with `owns_window`. Mirrored displays form one logical monitor and share its player.
- Command: `nice -n 10 ionice -c3 mpv` with options:
  - `--no-audio --loop-file=inf --hwdec=vaapi --cache=no`
  - `--osc=no --input-default-bindings=no --no-input-cursor`
  - `--force-window=no --idle=yes --pause=yes` at startup, with no initial file
  - `--wayland-app-id=gink-video-wallpaper --input-ipc-server=$XDG_RUNTIME_DIR/gink-video-wallpaper/<instance>.sock`
- Each player instance owns a short unique socket. Cleanup may unlink only that instance's socket, and only after that process is reaped.
- Fit arguments are applied only when the selected playback asset does not already have geometry baked in. A baked asset uses identity fitting.
- Video output (`--vo=gpu-next` vs `--vo=dmabuf-wayland`) is decided in Milestone 1 by measured CPU/GPU usage.

### 2. Background placement

- Before spawning, the extension installs the window-creation listener. Its callback immediately identifies the owned window and makes it fully transparent, non-reactive, skipped from Alt+Tab / Overview / dock (`hide_from_window_list`), and present on all workspaces. Hiding is not deferred to a later Promise continuation.
- A `Clutter.Clone` of its `MetaWindowActor` is inserted into the logical monitor's background actor in `Main.layoutManager._backgroundGroup`, above the static background.
- The Overview and workspace thumbnails keep the static background (no clone), which is free.

### 3. Flicker-free handoff

1. The still image is a persistent published wallpaper, so the login/lock screen and the first shell frame already show it. A GSettings write alone does not prove the background has loaded.
2. mpv starts idle and paused without a media window. IPC connects and subscribes before the selected playback asset is loaded paused.
3. The window listener and readiness state are latched before the events they observe. The clone starts at opacity 0.
4. Compositor first-frame readiness and mpv content readiness are separate latched conditions. Persistent mpv state is reconciled with one-shot events so an early event cannot be missed. Both waits settle promptly on cancellation.
5. Only after both conditions are ready does the clone fade to opacity 255 over ~300 ms. Fade completion removes only the startup pause reason; battery, coverage, and Overview pauses remain in force.
6. The still is extracted from the exact playback asset. Baked geometry is not fitted again. The target is tested SDR perceptual continuity, including sample aspect ratio, rotation, color metadata, and geometry—not pixel identity. HDR is initially unsupported.
7. If playback fails, the still remains visible.
8. A live file change prepares and displays the replacement still before removing the old clone, then stops and reaps the old player before starting the replacement. Two video players are never live for one logical monitor.

### 4. Startup gating

- Nothing is spawned until `startup-complete` is latched, plus a configurable delay (default 3 s). If already fired (e.g. on unlock or re-enable), only the delay remains.
- Players start one at a time, ~500 ms apart.
- All file checks and ffmpeg work use async `Gio.Subprocess` / `Gio.File` APIs.
- Retries: max 3 with exponential backoff; afterwards stay on the still and send one notification.

### 5. Monitors

- Stored selections use physical monitor identity (connector + vendor/product/serial), not a desktop index. Display state separately exposes physical mode dimensions and transformed logical rectangles.
- A mirrored logical-monitor group has one player. Its selection is the first configured connector in stable sorted order; preferences explains the shared selection, while each physical monitor keeps its stored selection for later unmirrored use.
- `monitors-changed` events are debounced (~1 s) before reconciling players.
- Spanned stills are composed once per logical rectangle onto one canvas. The canvas uses the logical-layout union, a common raster scale (maximum logical monitor scale), and shared edge rounding so adjacent rectangles do not gap or overlap. The wallpaper uses `picture-options='spanned'`.

### 6. Pause policy

Pause a logical monitor's player via IPC when:
- a maximized or fullscreen window covers that logical monitor (on the active workspace),
- the Overview is visible,
- running on battery (setting, default on).

Mirrored connectors form one logical monitor and pause as a single unit. The last frame stays visible while paused. Fade completion clears only the `startup` pause reason; active battery, coverage, or Overview reasons remain in force.

### 7. Lock and session modes

- `session-modes`: `["user"]` only. On lock, GNOME disables the extension: shell resources are revoked synchronously, process termination is requested immediately, and the lock screen shows the still.
- On unlock, players restart after the startup delay.
- Disable increments the lifecycle generation, cancels waits, destroys actors, disconnects signals, and calls forceful termination without leaving a grace timer that can touch extension state. Every async continuation checks its generation. A replacement may use a bounded graceful stop, but starting the next player is serialized behind reaping.
- Whether mpv children die when Shell exits must be verified during M1, including abnormal exit. If the spawning API does not guarantee it, a verified external lifetime mechanism is required; automatic cleanup is not assumed.

### 8. Cache

- Disposable cache: `~/.cache/gink-video-wallpaper/`.
- Persistent publications: `$XDG_DATA_HOME/gink-video-wallpaper/wallpapers/` (normally `~/.local/share/...`). Applied wallpapers live only here.
- Cache key: hash of source identity, exact playback-asset identity, target raster width/height, scale, fit mode, transformation version, and entry kind (`still` vs `media`). Spanned identity additionally includes the ordered logical canvas mapping and component still identities.
- Contents: completed still frames (PNG) and optimized SDR H.264 transcodes (GIFs always; videos optional). A missing prepared transcode falls back to the original and its matching still; no transcode runs during login.
- Producers write unique temporary files and publish atomically. Consumers acquire a stable private playback reference before loading and retry or fall back if the source disappears during acquisition. The reference lifetime runs through final reap; consumers that cancel before spawn release immediately, and prefs thumbnail consumers release after extraction. Publishing wallpaper acquires a private input reference first and regenerates/retries if clear-cache raced acquisition. Promise deduplication is process-local.
- "Clear cache" removes a snapshot of eligible completed cache entries. It does not remove active working directories, private playback references, or published wallpapers. Cancellation removes only the caller's job and temporary files. Published-wallpaper garbage collection is deferred initially; preferences reports preserved assets.

### 9. Wallpaper sync

- On first enable, save the original `picture-uri`, `picture-uri-dark`, and `picture-options` into extension settings.
- Set them to the persistent published still (or spanned composite), never to a disposable cache path.
- Restore originals when the extension is disabled by the user (not on lock, to keep the still on the lock screen). Restored publications remain until a future garbage-collection design.
