# T34 — VA-API driver notice and runtime fixes

- **Milestone:** M7
- **Depends on:** T16, T29, T33
- **Status:** review
- **Owner:** Claude Code
- **Skills:** GNOME Shell, mpv IPC

## Goal

Tell users when hardware decoding is missing, and fix small errors seen on a real Intel session.

## Findings

On an Intel UHD 770 without `intel-media-va-driver`, mpv decoded in software and `dmabuf-wayland` failed to upload frames ("Could not initialize video chain"). The window vanished and the player gave up after 3 retries. Installing the driver fixed playback, so `auto` stays unchanged.

The journal also showed: "already disposed" criticals when disconnecting from destroyed window actors, an unhandled promise from the top bar Preferences item, debug logging only applying after re-enable, and a stale playlist position for a single-file display.

## Deliverables

- After the first player starts, `hwdec-current` is read once; software decoding raises a notification naming the VA-API driver to install.
- The "stopped" notification mentions the VA-API driver.
- `Disposables` forgets handlers on objects that emit `destroy`.
- `debug-logging` applies live; Preferences open failures are logged.
- A display with one file drops its stored playlist position.

## Acceptance criteria

- [x] Unit tests cover the decoder check, destroyed-object cleanup and position removal.
- [x] On the device, with the driver installed, mpv reports `hwdec-current=vaapi` on `dmabuf-wayland`.
