# T08 — Background layer (window hide + clone)

- **Milestone:** M1
- **Depends on:** T03, T07
- **Status:** blocked
- **Owner:** Claude Code
- **Skills:** Mutter, Clutter, GNOME Shell internals

## Goal

Make the mpv window appear as the desktop background for one monitor, invisible everywhere else.

## Deliverables

- `lib/backgroundLayer.js` — per [interfaces.md](interfaces.md#libbackgroundlayerjs-t08-shell).
- `watchWindow(playerProcess, {timeoutMs, cancellable})`: install the `global.display` `window-created` listener synchronously **before spawn**; identify ownership and hide the real window in the creation callback, never in the Promise continuation. Reconcile existing windows and actor availability (`get_compositor_private()`), preserving the before-first-paint hiding requirement; latch the result and reject on timeout/cancellation.
- `attach(metaWindow)`:
  1. Hiding has already happened in the creation callback (`opacity = 0`, `reactive = false`); attach must not be the first opportunity to hide.
  2. `metaWindow.hide_from_window_list()`, `metaWindow.stick()`, `metaWindow.make_below()`; move/resize to monitor geometry (`move_resize_frame`); keep it fullscreen-sized.
  3. Prevent focus: on `focus` / `notify::appears-focused` refocus previous window; set `skip_taskbar` equivalent via hide_from_window_list.
  4. Create `Clutter.Clone({source: windowActor})` sized to monitor, add to `Main.layoutManager._backgroundGroup` above the `Meta.BackgroundActor` for this monitor index, opacity 0.
  5. Keep the clone in sync with monitor geometry changes.
- Exclude the window from the Overview: patch via `Workspace.prototype._isOverviewWindow` / `WindowPreview` filter **or** `global.display` `window-created` + `metaWindow.skip_taskbar`. Use the least invasive working approach; document the chosen one in the file header and restore patches on `destroy()`.
- `waitForFirstFrame({timeoutMs, cancellable})`: latch verified compositor paint evidence, even before a caller waits. A generic paint or mpv event is not automatically proof of the selected paused frame: verify the signal/evidence in M1 separately from IPC content readiness.
- `prepareStatic(publishedPath, {cancellable})`: preload the matching persistent still into an owned actor; `showStatic()` displays it before removing the old video clone. A GSettings write is not a background-load acknowledgment; retain the actor until system-background load is known or keep it under playback.
- `fadeIn(ms = 300, {cancellable} = {})`: cancellable Promise around clone animation; all paint/load/fade continuations check generation and cancellation.
- `destroy()`: synchronously invalidate work, settle pending window/frame/static/fade waits, remove owned actors, disconnect everything and undo patches. Does not kill the process.

## Acceptance criteria

- [ ] Video visible behind all windows; desktop icons/clicks unaffected. Nested capture: layer video center RGB `[33,204,67]`. Desktop-icon click routing is unverified; the private session has no icon extension.
- [ ] Not shown in Alt+Tab, Overview window picker, Dash to Dock running apps, or as a focused window. `hide_from_window_list()` sets `skip_taskbar`, which those consumers filter. Nested focus after `unset_input_focus` was false. Dash to Dock was not installed in the private session.
- [ ] No frame of the raw mpv window is ever visible on map (record screen at 60 fps to verify). Unverified: the environment has no 60 fps capture. Single captures before and after the clone show wallpaper then the selected green frame, which is not equivalent.
- [x] Overview shows the static background, not the clone. Overview capture stayed wallpaper blue `[2,60,136]` while the clone was green. Overview uses separate `BackgroundManager`s.
- [x] `destroy()` leaves `_backgroundGroup` children unchanged from before `attach()`. Ten nested create/destroy cycles stayed at baseline 1.
- [x] Pre-spawn listener hides an immediately created window before any Promise continuation; early first-frame evidence remains available to late waiters. Actor was present in `window-created`; `first-frame` latched while the source stayed opacity 0. Unit tests cover late waiters.
- [x] Cancellation/destroy during window discovery, frame wait, static preload or fade settles promptly; stale callbacks cannot touch destroyed or new-lifecycle actors. Covered by `tests/backgroundLayer.test.js` and generation guards.
- [ ] With deliberately delayed system-background loading, the preloaded matching static actor is visible before old-clone removal, without an old-wallpaper or black-frame flash. The owned still is independent of GSettings. Nested `showStatic()` capture was `[33,202,66]`, matching the published PNG, after the video clone was removed. System-background load delay itself was not simulated.

## Evidence

Private nested Shell (`gnome-shell --headless --virtual-monitor=1024x768`, Mutter 50.1), `tests/integration/run-t08-nested.py`:

| Capture | Center RGB |
|---|---|
| before clone | `[2, 60, 136]` wallpaper |
| settled opacity-0 source clone | `[34, 204, 67]` selected video |
| overview | `[2, 60, 136]` wallpaper |
| `BackgroundLayer` video | `[33, 204, 67]` |
| `BackgroundLayer` still | `[33, 202, 66]` matching PNG |

`minimize()` did not change `minimized` and is not used. `Meta.WindowType.DESKTOP` cannot be minimized and is not used. Native `skip_taskbar` exclusion is not undone in `destroy()`. Preexisting windows are rejected rather than reconciled. Missing-actor `BEFORE_REDRAW` retry is fail-closed and was not exercised because the actor existed in `window-created`.
