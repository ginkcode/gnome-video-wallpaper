# T19 — Pause on maximized/fullscreen coverage

- **Milestone:** M4
- **Depends on:** T05, T09
- **Status:** review
- **Owner:** Claude Code
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

- [x] Maximize a window → mpv paused within 300 ms (verify via IPC `pause` property). Nested run: about 203 ms, IPC `pause` true.
- [x] Unmaximize/minimize/switch workspace → resumes.
- [x] Fullscreen video in a browser → paused. Verified with a fullscreen foreign mpv window; a browser is left to the real-session gate.
- [ ] Multi-monitor: only the covered monitor pauses. Unit-tested; players exist only on the primary monitor until T25.
- [x] mpv CPU near 0 while paused. Nested run: 0 ticks over 3 s paused, 8 ticks playing.
- [x] Coverage reasons are keyed by logical monitor (mirrored connectors share one player); clearing startup or another reason never overrides coverage. Debounced callbacks are cancelled/generation-guarded on disable.

## Notes

- `lib/coverageController.js` holds the logic with injected display, workspace manager, settings and Meta constants. `lib/pauseController.js` supplies the globals. Coverage is applied per logical monitor key via the `covered` reason.
- GNOME 50 API: `Meta.Window.get_maximize_flags() === Meta.MaximizeFlags.BOTH`; `maximize()` takes no arguments.
- A window covers only when it is NORMAL type, not minimized, `located_on_workspace(active)`, and fullscreen or maximized both ways. Player windows are excluded with `PlayerManager.ownsWindow()`, which includes players still being reaped.
- Per-window signals also include `workspace-changed`, so moving a window to another workspace updates coverage.
- `PlayerManager.onTargets()` fires after every target resolution. The controller reapplies coverage then, because `stop()` clears pause reasons (sleep/resume), and the reason must be set before the startup fade ends.
- Disable leaves the `covered` reason set; the manager is stopped right after, so clearing it would only unpause briefly.
- Nested verification: `tests/integration/run-t19-nested.py` uses a foreign mpv window for maximize, minimize, workspace switch, setting toggle, fullscreen and close.
