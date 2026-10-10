# Target Environment

Findings from the development device (used as the first target).

| Item | Value |
|---|---|
| GNOME Shell | 50.1, Wayland session |
| Mutter API | `Meta-18` (`/usr/lib/x86_64-linux-gnu/mutter-18/`) |
| GPU | AMD Radeon 780M (HawkPoint1), VA-API decoders: H.264, H.265, VP9, AV1 |
| CPU / RAM | 16 threads / 30 GiB |
| Displays | `eDP-1` (internal); external monitors to be tested |
| mpv | 0.41.0 — VOs `gpu-next`, `gpu`, `dmabuf-wayland`, `wlshm`; `--hwdec=vaapi` available |
| ffmpeg / ffprobe | Installed |
| GStreamer | 1.28.2; `va`, `libav`, `matroska`, `isomp4`; **no** `gtk4paintablesink`, **no** `GstPlay` typelib |
| GJS tooling | `gjs`, `glib-compile-schemas`, `meson` |
| Node | 24.x via mise (for ESLint) |
| Process priority | `nice`, `ionice`, `systemd-run` available |

## Relevant Mutter APIs (verified in Meta-18.gir)

- `Meta.WaylandClient.new_subprocess` — spawn a trusted Wayland client.
- `Meta.WaylandClient.owns_window` — reliably identify windows of that client.
- `Meta.Window.hide_from_window_list` — exclude from Alt+Tab / dock.

## Other enabled extensions (interaction risks)

`blur-my-shell`, `dash-to-dock`, `caffeine`, `appindicatorsupport`, `system-monitor-panel`, `kimpanel`, `apps-menu`, `allowlockedremotedesktop`, and `hanabi-extension` (must be disabled while testing).
