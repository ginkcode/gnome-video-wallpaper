# T02 — GSettings schema and config helpers

- **Milestone:** M1
- **Depends on:** T01
- **Status:** done
- **Owner:** haith
- **Skills:** GSettings XML, GJS

## Goal

Define all settings from [../settings.md](../settings.md) and provide pure helpers for the per-monitor config.

## Deliverables

- `schemas/org.gnome.shell.extensions.gink-video-wallpaper.gschema.xml`
  - Path: `/org/gnome/shell/extensions/gink-video-wallpaper/`
  - Enum `org.gnome.shell.extensions.gink-video-wallpaper.FitMode`: `fill`, `fit`, `stretch`
  - Enum `...VideoOutput`: `auto`, `gpu-next`, `dmabuf-wayland`
  - Keys (with summary + description each):

| Key | Type | Default |
|---|---|---|
| `monitor-configs` | `s` (JSON) | `'{}'` |
| `default-fit-mode` | enum FitMode | `'fill'` |
| `startup-delay-ms` | `u` (range 0–60000) | `3000` |
| `stagger-ms` | `u` (range 0–10000) | `500` |
| `pause-on-maximized` | `b` | `true` |
| `pause-on-overview` | `b` | `true` |
| `pause-on-battery` | `b` | `true` |
| `optimize-videos` | `b` | `false` |
| `video-output` | enum VideoOutput | `'auto'` |
| `max-retries` | `u` (range 0–10) | `3` |
| `debug-logging` | `b` | `false` |
| `saved-picture-uri` | `s` | `''` |
| `saved-picture-uri-dark` | `s` | `''` |
| `saved-picture-options` | `s` | `''` |
| `wallpaper-applied` | `b` | `false` |

- `lib/config.js` [pure] — per [interfaces.md](interfaces.md#libconfigjs-t02-pure).
  - `monitor-configs` JSON shape: `{"<monitorId>": {"file": "/abs/path", "fitMode": "fill"|null, "optimize": bool|null}}`. `null` means use global default.
  - Invalid JSON → treat as `{}` and log a warning, never throw.
- `tests/config.test.js` — uses an in-memory fake settings object (`get_string`/`set_string`).

## Acceptance criteria

- [x] `glib-compile-schemas --strict schemas/` passes.
- [x] `gsettings --schemadir schemas list-recursively org.gnome.shell.extensions.gink-video-wallpaper` shows all keys.
- [x] `make test` passes config tests (read empty, write/merge, remove, invalid JSON).
