# T33 — Store every playlist pick

- **Milestone:** M7
- **Depends on:** T30, T32
- **Status:** review
- **Owner:** Claude Code
- **Skills:** GSettings

## Goal

"Now playing" in Preferences always names the video on the desktop.

## Findings

`playlist-state` was written only on `advance()`. A shuffled first pick, or a restart after the playing file was removed, played a file that was never stored, so Preferences showed an older position (seen on the device: rainy-night playing, yellow-flowers labelled).

## Deliverables

- `Playlist.fileFor()` stores its pick in `playlist-state` whenever it differs from the stored value.

## Acceptance criteria

- [x] A random start and a restart after removal are stored; other displays' positions are kept.
- [x] T30 nested run still passes.
