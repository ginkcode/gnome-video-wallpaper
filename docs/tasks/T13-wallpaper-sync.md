# T13 — System wallpaper sync

- **Milestone:** M2
- **Depends on:** T02, T03, T12
- **Status:** review
- **Owner:** Claude Code
- **Skills:** GSettings

## Goal

Make GNOME's own wallpaper (desktop, Overview, lock screen, login) show the video's still frame, and restore the user's original wallpaper when the extension is turned off.

## Deliverables

- `lib/wallpaperSync.js` — per [interfaces.md](interfaces.md#libwallpapersyncjs-t13-shell).
  - Target schema `org.gnome.desktop.background`: `picture-uri`, `picture-uri-dark`, `picture-options`.
  - `apply(fileUri, pictureOptions = 'zoom')` accepts only immutable persistent published wallpaper URIs from T12, never disposable cache paths. If `wallpaper-applied` is false, copy current values into `saved-*` keys and set `wallpaper-applied=true`; then write the new URI to both light and dark plus options. A write is not background-load acknowledgment: T08/T14 must keep a preloaded owned matching static actor during handoff.
  - Skip writes if values already equal (avoid redundant background reloads).
  - `restore()`: write `saved-*` back, clear them, set `wallpaper-applied=false`.
  - If the user changes the wallpaper externally while applied (detect via `changed` signal where the new value is not ours), treat the new value as the new "original" and save it.
- Also sync `org.gnome.desktop.screensaver` `picture-uri` if the lock screen uses it on GNOME 50 (verify; document finding).

## Acceptance criteria

- [ ] Enable → wallpaper becomes still; lock screen shows still. Module ready and unit-tested; wiring into enable is T14, and live lock-screen verification belongs to the real-session gate.
- [x] Disable by user → original wallpaper restored exactly (light, dark, options).
- [x] Shell crash/restart while applied → next enable does not overwrite saved originals.
- [x] External wallpaper change while applied is preserved on restore.
- [x] Clear cache while applied, lock/unlock, and restore do not break the published light/dark URI. Published assets are preserved after restore (initial publication GC deferred).
- [ ] Delayed system-background loading does not authorize removal of the matching owned static actor; stale lifecycle work cannot call apply after disable/restore. The second half is done: `apply()` returns `false` after `restore()`/`destroy()`. `apply()` is a synchronous settings write with no readiness signal; actor retention is T14.

## Notes

- GNOME Shell 50.1 source (`ui/unlockDialog.js`) creates the lock screen background with a default `BackgroundManager`, which uses `org.gnome.desktop.background` (blurred). `org.gnome.desktop.screensaver picture-uri` exists on this Ubuntu build but is not read by the Shell, so it is not synced. The GDM login screen uses the `gdm` user's settings, so it does not show the user's wallpaper.
- Ownership is decided by `isPublishedUri` (a SHA-256-named PNG directly under the publication directory) rather than an in-memory flag, so a restarted Shell recognises its own earlier writes.
- Tests use the GSettings memory backend and a temporary compiled schema; the real `org.gnome.desktop.background` is never touched.
