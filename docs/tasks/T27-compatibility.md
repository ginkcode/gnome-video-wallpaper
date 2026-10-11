# T27 — Compatibility with other extensions

- **Milestone:** M7
- **Depends on:** T14, T19, T25
- **Status:** review
- **Owner:** Claude Code
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

- [x] Every row tested with enable-order variations (ours first / last).
- [x] No journal errors from our extension in any combination.
- [ ] Screen still blanks/locks on idle with video playing.

## Verification — 2026-10-11

- **Unit tests and lint pass** (`make test`, 189 tests; `make lint`). New tests:
  - `tests/compat.test.js` covers Hanabi state detection.
  - `tests/mpvArgs.test.js` asserts `--stop-screensaver=no`.
  - `tests/readLine.test.js` reproduces GNOME Shell's bytes-returning `read_line_async` promisify. It failed before the `lib/async.js` `readLine` fix.
- **The T27 matrix passes all five scenarios** (`python3 -I tests/integration/run-t27-nested.py`). Each scenario runs in a private headless GNOME Shell 50 with copies of the device's extensions:
  - `device-last` and `device-first`: the device's 8 extensions with ours last or first, including lock/unlock, Caffeine, an idle-inhibit control and enable/disable cycling.
  - `ubuntu-system`: the Ubuntu default extensions.
  - `blur-aggressive`: Blur My Shell application blur with `enable-all`.
  - `hanabi`: Hanabi enabled alongside ours.
  - Results, known issues and workarounds are in `docs/compatibility.md`.
- **Stale-window fix:** `ubuntu-system` first failed `windowHidden` 3 of 3 times. After mpv exited, mutter kept its window because `Gio.SubprocessLauncher` held the Wayland socket open until GC, and DING focused that window. `lib/playerProcess.js` now closes the launcher after spawning; after the fix the scenario passed in every run, and the runner checks `noStaleWindows`.
- **Regression:** `python3 -I tests/integration/run-t25-nested.py --quick` passes.

Open issues, documented with workarounds:

- Dash to Dock intellihide (`FOCUS_APPLICATION_WINDOWS`/`ALL_WINDOWS`) treats the hidden mpv window as overlapping, so the dock hides on an empty desktop.
- Blur My Shell application blur with `enable-all` dims the video.

Limitations:

- The idle-blanking criterion is only verified indirectly: mpv makes no inhibit call, while a `--stop-screensaver=yes` control does. Real-hardware idle blanking/locking with a video playing is still a manual check.
- Not tested: multi-monitor combinations with other extensions, or any real-session install.
