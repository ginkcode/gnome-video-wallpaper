# T27 — Compatibility with other extensions

- **Milestone:** M7
- **Depends on:** T14, T19, T25
- **Status:** todo
- **Owner:**
- **Skills:** GNOME Shell extensions debugging

## Goal

Work alongside the extensions installed on the target device.

## Test matrix

| Extension | Things to check |
|---|---|
| Blur My Shell | Panel/overview blur uses still or clone correctly; app-blur does not make mpv window semi-transparent; dash blur |
| Dash to Dock | mpv not listed as running app; intellihide unaffected; dock over video renders |
| Caffeine | No interaction with pause logic; mpv does not inhibit idle (`--stop-screensaver=no`) |
| AppIndicator, system-monitor-panel, kimpanel, apps-menu | No errors on enable/disable ordering |
| allowlockedremotedesktop | Lock-screen behavior still correct |
| Hanabi | Detect if enabled → log warning and show prefs banner "Disable Hanabi" |

## Deliverables

- Fixes or documented workarounds for each issue found.
- `docs/compatibility.md` with results.
- Ensure `--stop-screensaver=no` in mpv args (video wallpaper must not prevent screen blanking).

## Acceptance criteria

- [ ] Every row tested with enable-order variations (ours first / last).
- [ ] No journal errors from our extension in any combination.
- [ ] Screen still blanks/locks on idle with video playing.
