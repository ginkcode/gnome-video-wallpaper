# T31 — Workspace switching with open windows

- **Milestone:** M7
- **Depends on:** T08, T27
- **Status:** review
- **Owner:** Claude Code
- **Skills:** GNOME Shell internals, Mutter focus

## Goal

Switching workspaces with open windows works exactly as it does without the extension, and reinstalling the extension cannot crash a running Shell.

## Findings

- The player window is sticky, so Shell's switch animation cloned it at full opacity in the sticky group, above every workspace: the raw video covered all windows while switching.
- A sticky window whose eligibility changes during a switch (for example through the workspace's showing-desktop state) has no clone record, and Shell's `_syncStacking` throws `record is undefined`.
- When Mutter gave default focus to the player on a workspace, the focus guard called `activate()` on the previous window from another workspace, which only flagged it as demanding attention.
- `make install` overwrote the installed `gschemas.compiled` in place. The running Shell maps that file, so changed contents made `get_boolean()` miss keys and abort Shell with signal 6 (a forced logout).

## Deliverables

- `lib/workspaceAnimationFilter.js`: excludes player windows from `WorkspaceGroup` through `InjectionManager`, restored on disable.
- `BackgroundLayer` focus guard: restore the previous window only if it is on the active workspace; otherwise unset input focus.
- `make install` stages the extension next to the target and swaps it in by rename.

## Acceptance criteria

- [x] With a focused window on workspace 1, switching to workspace 2 and back works, and focus returns to the window.
- [x] No player window is cloned into the switch animation.
- [x] Focus given to the player on another workspace is dropped without flagging the old window.
- [x] Disabling restores Shell's original method.
- [x] `make install` replaces the directory by rename rather than overwriting files.
- [ ] Touchpad and keyboard switching in the real session (real session).

## Notes

- `python3 -I tests/integration/run-t31-nested.py` runs with the device's other extensions (dash-to-dock, blur-my-shell, …) copied into a private session. Before the fix, `playerNotAnimated` and `stolenFocusStays` failed; after it, every check passes.
- Code already loaded by a running Shell is not reloaded by `make install`; log out and back in after installing.
- T08 and T30 nested runners still pass.
