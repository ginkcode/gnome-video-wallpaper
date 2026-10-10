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

- [ ] Video visible behind all windows; desktop icons/clicks unaffected. Nested capture: `BackgroundLayer` video center RGB `[33,204,67]` (selected green) while wallpaper stayed `[2,60,136]` before the clone. Desktop-icon click routing is still unverified: DING staged in the private session but reported no mapped desktop window, so real click-through is not demonstrated.
- [ ] Not shown in Alt+Tab, Overview window picker, Dash to Dock running apps, or as a focused window. Overview picker and installed Dash to Dock are now verified to exclude the window (see Evidence). Alt+Tab remains blocked: the private session has no normal application window to populate either switcher popup. Nested focus after `unset_input_focus` was false.
- [ ] No frame of the raw mpv window is ever visible on map (record screen at 60 fps to verify). Still unverified: `org.gnome.Shell.Screencast` at 60 fps timed out in the private session even with a private PipeWire daemon, so no native recording was produced. Single captures before/after the clone (wallpaper then selected green) are not equivalent to a 60 fps record.
- [x] Overview shows the static background, not the clone. Overview capture stayed wallpaper blue `[2,60,136]` while the clone was green. The overview picker (`WindowPreview` previews) contained zero previews for the wallpaper window.
- [x] `destroy()` leaves `_backgroundGroup` children unchanged from before `attach()`. Ten nested create/destroy cycles stayed at baseline 1.
- [x] Pre-spawn listener hides an immediately created window before any Promise continuation; early first-frame evidence remains available to late waiters. Actor was present in `window-created` at opacity 0; `first-frame` latched while the source stayed opacity 0. Unit tests cover late waiters.
- [x] Cancellation/destroy during window discovery, frame wait, static preload or fade settles promptly; stale callbacks cannot touch destroyed or new-lifecycle actors. Covered by `tests/backgroundLayer.test.js` and generation guards.
- [x] With deliberately delayed system-background loading, the preloaded matching static actor is visible before old-clone removal, without an old-wallpaper or black-frame flash. The fixture monkey-patched the system `Background._loadFile` for the published still, held it across five delay captures, and released it. Every capture from `handoff-transition` through `handoff-loaded` (and `layer-static`) stayed `[33,202,66]`, matching the still; `handoff-held` reported `ordering:true`, `isLoaded:false`; `handoff-complete` reported `loaded:true`, `retained:true`. The no-flash claim is snapshot-based only; a continuous 60 fps record would be required to rule out a transient flash.

## Evidence

Private nested Shell (`gnome-shell --headless --virtual-monitor=1024x768`, Mutter 50.1), `tests/integration/run-t08-nested.py` (retained run `/tmp/t08-q5v7gu25`):

| Capture | Center RGB |
|---|---|
| before clone | `[2, 60, 136]` wallpaper |
| `BackgroundLayer` video | `[33, 204, 67]` |
| `BackgroundLayer` still / handoff transition + delays | `[33, 202, 66]` matching PNG |
| overview | `[2, 60, 136]` wallpaper |

Real-consumer checks (installed `dash-to-dock@micxgx.gmail.com` and `ding@rastersoft.com` staged into the private session):

| Consumer | Result |
|---|---|
| Overview window picker | verified — 0 previews, window excluded |
| Dash to Dock running apps | verified — dock apps were Nautilus/Yelp/trash only, window excluded |
| Alt+Tab (applications and windows) | blocked — no normal app/window in the private session |
| DING desktop-icon click | blocked — DING had no mapped desktop window |

Recording/capture: `org.gnome.Shell.Screencast` (60 fps, private PipeWire) `capture-blocked` with "Timeout was reached"; no `map-flash` recording, so native cadence and pre-reveal green were not measured.

`minimize()` did not change `minimized` and is not used. `Meta.WindowType.DESKTOP` cannot be minimized and is not used. Native `skip_taskbar` exclusion is not undone in `destroy()`. Preexisting windows are rejected rather than reconciled. Missing-actor `BEFORE_REDRAW` retry is fail-closed and was not exercised because the actor existed in `window-created`.
