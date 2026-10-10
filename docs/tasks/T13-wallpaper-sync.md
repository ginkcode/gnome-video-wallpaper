# T13 — System wallpaper sync

- **Milestone:** M2
- **Depends on:** T02, T03, T12
- **Status:** todo
- **Owner:**
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

- [ ] Enable → wallpaper becomes still; lock screen shows still.
- [ ] Disable by user → original wallpaper restored exactly (light, dark, options).
- [ ] Shell crash/restart while applied → next enable does not overwrite saved originals.
- [ ] External wallpaper change while applied is preserved on restore.
- [ ] Clear cache while applied, lock/unlock, and restore do not break the published light/dark URI. Published assets are preserved after restore (initial publication GC deferred).
- [ ] Delayed system-background loading does not authorize removal of the matching owned static actor; stale lifecycle work cannot call apply after disable/restore.
