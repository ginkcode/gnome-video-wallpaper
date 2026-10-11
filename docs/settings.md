# Settings and Cache

Schema id: `org.gnome.shell.extensions.gink-video-wallpaper`

## Keys

Authoritative definition: [tasks/T02-gsettings-schema.md](tasks/T02-gsettings-schema.md).

| Key | Type | Default | Purpose |
|---|---|---|---|
| `monitor-configs` | `s` (JSON) | `'{}'` | Per-monitor config keyed by monitor identity: `{ file, fitMode, optimize }` |
| `default-fit-mode` | enum `fill` / `fit` / `stretch` | `fill` | Fit mode for monitors without an override |
| `startup-delay-ms` | `u` | `3000` | Delay after `startup-complete` before spawning players |
| `stagger-ms` | `u` | `500` | Delay between starting each monitor's player |
| `pause-on-maximized` | `b` | `true` | Pause when a maximized/fullscreen window covers the monitor |
| `pause-on-overview` | `b` | `true` | Pause while the Overview is visible |
| `pause-on-battery` | `b` | `true` | Pause while on battery power |
| `optimize-videos` | `b` | `false` | Prepare target-sized SDR H.264 in prefs (GIFs always prepared); no login transcode |
| `video-output` | enum `auto` / `gpu-next` / `dmabuf-wayland` | `auto` | mpv VO; `auto` maps to `dmabuf-wayland,wlshm` with `--hwdec=vaapi` on the development device per [T10](benchmarks/vo-benchmark.md), provisional until real-session verification |
| `max-retries` | `u` | `3` | Player restart limit before staying on the still |
| `debug-logging` | `b` | `false` | Enable debug-level logs |
| `wallpaper-applied` | `b` | `false` | Whether the original wallpaper is saved and currently replaced |
| `saved-picture-uri` | `s` | `''` | Original wallpaper (light) for restore |
| `saved-picture-uri-dark` | `s` | `''` | Original wallpaper (dark) for restore |
| `saved-picture-options` | `s` | `''` | Original picture-options for restore |

Audio has no setting; it is always off.

## Monitor identity

`<connector>:<vendor>:<product>:<serial>` from `org.gnome.Mutter.DisplayConfig`; serial may be empty. These physical IDs key stored user selections, not players or canvas rectangles.

Display state separates physical mode dimensions from transformed logical monitor rectangles and scale. Mirrored connectors share one logical monitor/player. Choose the first configured connector in stable sorted order; prefs explains the shared selection and retains all physical selections for unmirrored use.

Spanned wallpaper uses one logical-layout canvas: union of logical rectangles, common raster scale (maximum logical monitor scale), translated origin and shared edge rounding. Compose once per logical rectangle; physical mode dimensions are not desktop offsets.

## Cache layout

```
$XDG_CACHE_HOME/gink-video-wallpaper/     default ~/.cache/gink-video-wallpaper/
  stills/<key>.png          completed exact-asset stills
  spanned/<key>.png         completed logical-layout composites
  media/<key>.mp4           completed optimized / GIF SDR transcodes
  jobs/<pid>-<uuid>/        producer-owned temporary work, never clear-cache eligible
  refs/<pid>-<uuid>/        private acquired playback references, released after reaping
$XDG_DATA_HOME/gink-video-wallpaper/      default ~/.local/share/gink-video-wallpaper/
  wallpapers/<sha256>.png  immutable content-addressed publications used by GNOME wallpaper settings
```

Private references live beside the cache (not in the tmpfs runtime directory) so they can be hard links to cache entries and to sources on the same filesystem; other sources are copied. Clear-cache skips completed entries that still have another hard link (an active reference) and removes `refs/`/`jobs/` directories only when their owning PID is gone.

`<key>` = SHA-256 of source path/size/mtime, exact selected asset identity, target raster width/height, scale, fit mode, transformation version and kind. Spanned identity additionally includes the ordered logical canvas mapping and component still identities. Optimized geometry is baked; still extraction and mpv must not fit it twice. Source sample aspect ratio, rotation and SDR color metadata are normalized/interpreted consistently by the transformation.

Producers use unique temp files and atomic publication. In-memory promise deduplication is process-local. Before media load, consumers copy or hard-link a stable private playback reference whose lifetime runs through that player's final reap; consumers that cancel before spawn release immediately, and prefs thumbnail consumers release after extraction. If deletion races acquisition, retry or select the original and prepare its matching still. Publishing a wallpaper acquires a private input reference first and regenerates/retries if clear-cache raced acquisition. A missing prepared transcode never triggers transcoding at login or an unannounced switch after the still was chosen.

Clear-cache deletes a snapshot of eligible completed cache entries, not active job directories/private references or published wallpaper assets. Cancellation removes only the caller's job/temp files. Published-wallpaper garbage collection is deferred initially, including after restore; prefs reports removed and preserved active/published bytes. Clear-cache can therefore leave active media entries behind.

## Runtime files

Each player owns a short unique socket rather than a reusable per-monitor path. Cleanup may unlink only its own socket after that process is reaped. Replacement/re-enable is serialized with outstanding reaping so no two live players occupy one logical monitor.

```
$XDG_RUNTIME_DIR/gink-video-wallpaper/<short-unique-instance>.sock   mpv IPC sockets
```
