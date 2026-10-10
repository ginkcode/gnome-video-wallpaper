# T08 — Background layer (window hide + clone)

- **Milestone:** M1
- **Depends on:** T03, T07
- **Status:** todo
- **Owner:**
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

- [ ] Video visible behind all windows; desktop icons/clicks unaffected.
- [ ] Not shown in Alt+Tab, Overview window picker, Dash to Dock running apps, or as a focused window.
- [ ] No frame of the raw mpv window is ever visible on map (record screen at 60 fps to verify).
- [ ] Overview shows the static background, not the clone.
- [ ] `destroy()` leaves `_backgroundGroup` children unchanged from before `attach()`.
- [ ] Pre-spawn listener hides an immediately created window before any Promise continuation; early first-frame evidence remains available to late waiters.
- [ ] Cancellation/destroy during window discovery, frame wait, static preload or fade settles promptly; stale callbacks cannot touch destroyed or new-lifecycle actors.
- [ ] With deliberately delayed system-background loading, the preloaded matching static actor is visible before old-clone removal, without an old-wallpaper or black-frame flash.
