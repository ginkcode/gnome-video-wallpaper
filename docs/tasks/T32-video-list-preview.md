# T32 — Video list preview selection

- **Milestone:** M7
- **Depends on:** T30
- **Status:** review
- **Owner:** Claude Code
- **Skills:** libadwaita

## Goal

The Videos list on the Wallpapers page is clear: it is open by default, any video can be previewed by clicking it, and the playing video is labelled.

## Deliverables

- The Videos expander starts expanded, and expands again when the first video is added.
- Each row of a multi-video list has a radio prefix. Clicking the row selects it and shows its preview.
- The playing video has the subtitle "Now playing" instead of a ▶ icon that looked like a preview marker.
- The preview follows the playing video again when the playlist advances or the previewed file is removed.

## Acceptance criteria

- [x] The list is expanded when the page opens.
- [x] Clicking a video name shows that video's preview without changing what plays.
- [x] The playing video is labelled "Now playing".
- [x] Single-video lists show no radio button.

## Notes

- `python3 -I tests/integration/run-t21-nested.py` covers the default expansion, picking a row and the "Now playing" subtitle.
