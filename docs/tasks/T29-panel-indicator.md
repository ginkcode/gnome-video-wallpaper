# T29 — Top bar indicator

- **Milestone:** M7
- **Depends on:** T20, T22
- **Status:** review
- **Owner:** Claude Code
- **Skills:** GNOME Shell panel menus

## Goal

A top bar menu with Play/Pause for every player and a Preferences item that opens the extension settings.

## Deliverables

- Schema keys `paused` (b, default false) and `show-panel-indicator` (b, default true).
- `lib/userPauseController.js` [pure, injected]: sets the `user` pause reason on every target from `paused`. The reason is reapplied on each `onTargets()` resolution, like T20.
- `lib/panelIndicator.js` [shell]: `PanelMenu.Button` added with `Main.panel.addToStatusArea(uuid, …)`. The toggle item flips `paused` and shows Pause or Play. Preferences calls `Extension.openPreferences()`. Follows `show-panel-indicator` live; destroyed in `disable()`.
- Preferences: General → Top Bar → Show menu.

## Acceptance criteria

- [x] The indicator appears in the top bar with Pause and Preferences items.
- [x] Pause pauses mpv (`pause` true, state `paused`); Play resumes. The user reason composes with overview/battery/coverage reasons (unit tests).
- [x] A user pause survives disable/enable and restarts: the player starts paused.
- [x] Turning `show-panel-indicator` off removes the indicator live; turning it on restores it.
- [x] Disable removes the indicator and leaves no signal connections.
- [ ] Preferences opens the settings window. Not exercised headless; needs the real session.

## Notes

- Nested verification: `python3 -I tests/integration/run-t29-nested.py`. All checks passed: toggles took effect, there was at most one mpv at a time, no survivors and no `JS ERROR`.
- The pause is persisted in GSettings, so it can also be set with `gsettings set org.gnome.shell.extensions.gink-video-wallpaper paused true`.
