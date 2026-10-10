# T19 — Pause on maximized/fullscreen coverage

- **Milestone:** M4
- **Depends on:** T05, T09
- **Status:** todo
- **Owner:**
- **Skills:** Mutter window management

## Goal

Stop decoding when nobody can see the wallpaper on a monitor.

## Deliverables

- `lib/pauseController.js` — per [interfaces.md](interfaces.md#libpausecontrollerjs-t19-t20-shell), reason `covered`.
- A monitor is covered when, on the **active workspace**, any non-minimized normal window on that monitor is fullscreen or maximized both ways (`get_maximize_flags() === Meta.MaximizeFlags.BOTH` on GNOME 50; verify API name).
- Recompute on (debounced 200 ms):
  - `global.display` `window-created`, `in-fullscreen-changed`, `restacked`
  - `global.workspace_manager` `active-workspace-changed`
  - per window: `notify::maximized-horizontally`, `notify::maximized-vertically`, `notify::fullscreen`, `notify::minimized`, `position-changed`, `unmanaged`
- Ignore our own mpv windows.
- Respect `pause-on-maximized` setting live.

## Acceptance criteria

- [ ] Maximize a window → mpv paused within 300 ms (verify via IPC `pause` property).
- [ ] Unmaximize/minimize/switch workspace → resumes.
- [ ] Fullscreen video in a browser → paused.
- [ ] Multi-monitor: only the covered monitor pauses.
- [ ] mpv CPU near 0 while paused.
- [ ] Coverage reasons are keyed by logical monitor (mirrored connectors share one player); clearing startup or another reason never overrides coverage. Debounced callbacks are cancelled/generation-guarded on disable.
