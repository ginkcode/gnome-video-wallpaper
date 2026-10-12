# T37 — Pause while shared or remote; show auto-pause reasons

- **Milestone:** M7
- **Depends on:** T20, T29
- **Status:** review
- **Owner:** Claude Code
- **Skills:** GNOME Shell, Mutter, logind

## Goal

Stop spending GPU and bandwidth on the video while someone else is looking at the screen, and tell the user why playback paused on its own.

## Deliverables

- `pause-on-remote` setting (default on) with a switch in General → Pause.
- `SessionPauseController` adds the `remote` reason while a Mutter remote access handle (screen cast, remote desktop) is active, or while the logind session is remote. Recordings made with the Shell's own recorder are ignored.
- `PlayerManagerLifecycle.pauseReasons()` and `onPauseChanged()`.
- The top bar menu shows "Paused automatically: …" under Play/Pause while an automatic reason applies.

## Acceptance criteria

- [x] Unit tests cover remote handles, recordings, remote sessions, the live setting, late replies and cleanup.
- [x] Unit tests cover reason reporting and change notification in the manager, and the status text.
- [x] T29 nested run shows the Overview reason in the menu and hides it on resume; T20 and T22 nested runs pass.
- [ ] Verified with a real RDP or screen sharing session.

## Notes

- Mutter only announces new handles, so a session already running when the extension is enabled is not seen until the next one starts.
- Sharing a single window also pauses.
