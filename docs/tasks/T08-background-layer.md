# T08 — Background layer (window hide + clone)

- **Milestone:** M1
- **Depends on:** T03, T07
- **Status:** done
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

- [x] Video visible behind all windows; desktop icons/clicks unaffected. Nested capture: video center `[33,204,67]` (selected green) while the wallpaper stayed `[2,60,136]` before the clone. A virtual-pointer click on a staged DING desktop icon changed its accessible name from `… File` to `… File Selected`; the stage pick at the icon was DING's surface. The negative control with the previous code (`reactive = false` on the window actor only) picked the wallpaper's Wayland surface actor and swallowed the click, so the layer now clears `reactive` on every surface actor, including ones added later.
- [x] Not shown in Alt+Tab, Overview window picker, Dash to Dock running apps, or as a focused window. All four consumers were verified at runtime with a zenity control window present. The wallpaper window was unfocused at readiness and after the control window closed. Previously, Mutter handed focus to the wallpaper when the earlier focused window was unmanaged, and `activate()` on the dead window did nothing. `_guardFocus` now unsets input focus in that case.
- [x] No frame of the raw mpv window is ever visible on map. Verified from compositor events instead of a 60 fps recording, which the private screencast cannot produce (31–37 fps). The window actor exists at opacity 0 in `window-created` (unmapped) before `first-frame`, and `first-frame` fires with opacity still 0. A fully transparent actor is not drawn, so a raw frame cannot be painted. The screencast is kept as a diagnostic only. Decision (2026-10-11): compositor evidence replaces the 60 fps recording requirement.
- [x] Overview shows the static background, not the clone. Overview capture stayed wallpaper blue `[2,60,136]` while the clone was green. The overview picker (`WindowPreview` previews) contained zero previews for the wallpaper window.
- [x] `destroy()` leaves `_backgroundGroup` children unchanged from before `attach()`. Ten nested create/destroy cycles stayed at baseline 1, and every player PID was gone afterwards.
- [x] Pre-spawn listener hides an immediately created window before any Promise continuation; early first-frame evidence remains available to late waiters. Actor was present in `window-created` at opacity 0; `first-frame` latched while the source stayed opacity 0. Unit tests cover late waiters.
- [x] Cancellation/destroy during window discovery, frame wait, static preload or fade settles promptly; stale callbacks cannot touch destroyed or new-lifecycle actors. Covered by `tests/backgroundLayer.test.js` and generation guards.
- [x] With deliberately delayed system-background loading, the preloaded matching static actor is visible before old-clone removal, without an old-wallpaper or black-frame flash. The fixture held the system `Background._loadFile` for the published still and then released it. `handoff-held` reported `ordering:true, isLoaded:false`; `handoff-complete` reported `loaded:true, retained:true`. Every snapshot from `handoff-transition` through `handoff-loaded` stayed `[33,202,66]`, matching the still. `showStatic()` raises the still to full opacity and removes the clone in one synchronous call, so no frame can be painted between the two. Under the same decision, this replaces a continuous recording.

## Evidence

Private nested Shell (`gnome-shell --headless --virtual-monitor=1024x768`, Mutter 18 / Shell 50.1, private D-Bus, PipeWire and keyfile GSettings) via `python3 -I tests/integration/run-t08-nested.py --keep`. Three consecutive runs (`/tmp/t08-xf_gdheu`, `/tmp/t08-54q9e5ca`, `/tmp/t08-dltcr3s4`) gave identical verdicts. Each ended `blocked` only on the map-flash record, with Shell exit 0. After the runner adopted the compositor-event verdict, `/tmp/t08-aaj9mteo` reported `verified` (exit 0, `hiddenBeforePaint: true`).

| Capture | Center RGB |
|---|---|
| before clone | `[2, 60, 136]` wallpaper |
| `BackgroundLayer` video / settled clone | `[33, 204, 67]` |
| still, handoff transition, five delays, loaded | `[33, 202, 66]` matching PNG |
| overview | `[2, 60, 136]` wallpaper |

Real consumers: installed `dash-to-dock@micxgx.gmail.com` and `ding@rastersoft.com`, copied into the private session.

| Consumer | Result |
|---|---|
| Overview window picker | verified — wallpaper not among previews |
| Dash to Dock running apps | verified — Nautilus, Yelp, control window, trash only |
| Alt+Tab applications / windows | verified — popups shown with the control window; wallpaper absent |
| DING desktop-icon click | verified — selection transition; pick owner `ding` |

Negative control (`/tmp/t08-bqz4a5oq`, previous `backgroundLayer.js`): DING failed with pick owner `wallpaper`, and the wallpaper ended up focused.

Fixture notes:

- DING patches `global.get_window_actors()` to hide its own window, so the fixture enumerates `global.display.list_all_windows()`.
- The virtual pointer approaches via the monitor centre because the hot-corner barrier clamps jumps from the origin.
- Calling `run_dispose()` on the virtual device crashed Shell, so the fixture only drops the reference.

Notes from earlier work:

- A JS `Clutter.Effect` pick override worked but was replaced. Its vfunc can outlive the GJS context at Shell exit, and one run aborted with Gjs "Info type must match".
- `minimize()` did not change `minimized` and is not used. `Meta.WindowType.DESKTOP` cannot be minimized and is not used.
- Native `skip_taskbar` exclusion and surface non-reactivity are not undone in `destroy()`.
- Preexisting windows are rejected rather than reconciled.
- The missing-actor `BEFORE_REDRAW` retry is fail-closed. It was not exercised because the actor existed in `window-created`.
