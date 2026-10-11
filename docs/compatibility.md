# Compatibility with other extensions

These results come from private headless GNOME Shell 50.1 sessions (mutter 18, mpv 0.41). Each session used a `1920x1080` virtual monitor, an isolated `HOME`/`XDG_*` and the keyfile GSettings backend. Each extension was a copy of the one installed on the target device; the Ubuntu system extensions were loaded from `/usr/share/gnome-shell/extensions`. The real session and real settings were never touched.

Reproduce with:

```
python3 -I tests/integration/run-t27-nested.py [--only device-last,hanabi] [--keep] [--debug]
```

## Scenarios

| Scenario | Mode | Enabled (in order) | Exercised |
|---|---|---|---|
| `device-last` | ubuntu | dash-to-dock, caffeine, kimpanel, appindicator, apps-menu, allowlockedremotedesktop, system-monitor-panel, blur-my-shell, **ours** | device settings (dock at the bottom, intellihide `FOCUS_APPLICATION_WINDOWS`, panel and dash blur); idle inhibit with a control mpv; Caffeine on/off; lock/unlock; 3 disable/enable cycles of ours; each other extension disabled and re-enabled |
| `device-first` | ubuntu | **ours**, then the same set | device settings; lock/unlock; 3 cycles; dash-to-dock and blur-my-shell toggled |
| `ubuntu-system` | ubuntu | Ubuntu defaults (ubuntu-dock, DING, tiling-assistant, appindicators, search providers, snapd-prompting) + **ours** | 2 cycles; ubuntu-dock, DING, tiling-assistant and appindicators toggled |
| `blur-aggressive` | user | blur-my-shell, dash-to-dock, **ours** | BMS application blur with `enable-all=true`; dock intellihide `ALL_WINDOWS` |
| `hanabi` | user | **ours**, Hanabi | shell warning, live prefs banner, banner's "Disable Hanabi" button, re-enable |

Every scenario checks the following:

- Ours is ACTIVE with exactly one mpv, and that mpv is playing.
- mpv's argv contains `--stop-screensaver=no`.
- The background clone is mapped and the captured screen shows the video.
- The mpv window is hidden (opacity 0, unfocused), has skip-taskbar set, is not a running app and has no dock icon, not even briefly.
- No mpv window outlives its process.
- Disabling ours leaves no player, socket or clone behind.
- No process from the private session survives.
- The shell log contains no JS error or critical from our extension.

All five scenarios pass.

## Results

| Extension | Result | Notes |
|---|---|---|
| Blur My Shell | Works, with one known issue | Panel blur shows a blurred, tinted video, and the dash blur works. The default app-blur settings and the device's settings do not affect us. With `applications/enable-all=true`, BMS dims our window's surface to its opacity setting (default 215), so the video looks darker (see Known issues). Toggling BMS restarts our player once, and the player resumes. |
| Dash to Dock / Ubuntu Dock | Works, with one known issue | mpv never shows up as a running app or dock icon, even briefly during startup. The dock renders above the video. Intellihide treats our hidden full-monitor window as overlapping (see Known issues). The Ubuntu Dock in fixed mode is unaffected. |
| Caffeine | Works | Caffeine's inhibitor (`caffeine-gnome-extension`, flag 8) comes from the shell and has no effect on our pause logic; the video keeps playing while it is active. Our mpv makes no `Inhibit` calls and owns no MPRIS name. Our window is not reported as fullscreen, so Caffeine's fullscreen detection is unaffected. |
| AppIndicator, system-monitor-panel, kimpanel, apps-menu | Works | Works with ours first and last. Disabling and re-enabling each one, and 3 cycles of ours, produced no errors. |
| allowlockedremotedesktop | Works | On lock, the mode is `unlock-dialog` and our player stops; it resumes on unlock. allowlockedremotedesktop stays ACTIVE while locked. |
| Ubuntu defaults (DING, tiling-assistant, appindicators) | Works | No errors on enable/disable. DING needs `~/Desktop` to exist (that is DING's own requirement). |
| Hanabi | Detected | The shell logs `[compat] Hanabi (…) is enabled and also draws a video wallpaper; disable it with: gnome-extensions disable hanabi-extension@jeffshee.github.io` every time Hanabi becomes active. The prefs window shows an `Adw.Banner` on every page; the banner updates live and its "Disable Hanabi" button disables Hanabi over D-Bus. Our player keeps playing while Hanabi is active. |

### Enable order

- **Ours first or last makes no difference to the results.**
- **Disabling or enabling any extension restarts our player.** GNOME Shell's extension manager does this to every extension that comes later in the enable order. Our player stops cleanly and resumes, and stills cover the gap.

### Idle and screen blanking

- **mpv runs with `--stop-screensaver=no`.** A control mpv started with `--stop-screensaver=yes` caused mutter to call `org.freedesktop.ScreenSaver.Inhibit("mutter", "idle-inhibit")` and released it on exit. Our mpv caused no such call, so playback does not hold off idle.
- **Real-hardware blanking still needs a manual check.** Leave the real session idle with a video playing and confirm that the screen blanks and locks after the configured delay. This has not been done; headless shells have no real idle monitor or display power management.

## Known issues and workarounds

### Dash to Dock intellihide hides the dock on an empty desktop

**Cause.** Dash to Dock's intellihide checks for overlap against every `NORMAL` window. Our mpv window is a hidden but real monitor-sized `NORMAL` window, so the dock counts it as overlapping.

**Effect by intellihide mode.**

- `FOCUS_APPLICATION_WINDOWS` (the device setting): the dock stays hidden on an empty desktop until the pointer reaches the edge. The runner records dock state 2 / no overlap without ours and 0 / overlap with ours.
- `ALL_WINDOWS`: the dock is always hidden.
- `MAXIMIZED_WINDOWS`: unaffected.
- Fixed dock (intellihide off) and Ubuntu Dock's default fixed mode: unaffected.

**Workaround.** Set Dash to Dock to *Intelligent autohide → Only maximized windows*, or turn off intellihide.

**Why it is not fixed.** Dash to Dock ignores only DING windows, which it identifies by application id. A real fix would need one of these:

- a `DESKTOP` window type, which T08 rejected;
- impersonating DING's application id;
- an upstream change to Dash to Dock.

This is still an open design issue.

### Blur My Shell application blur with `enable-all`

**Cause.** When application blur is enabled for all windows, BMS adds a blur actor to our window actor and sets the surface's opacity to its `opacity` setting. Our background clone copies the whole window actor, so the video is drawn at reduced opacity (about 86% at the default setting of 215).

**Scope.** It only happens with `applications/blur=true` together with `enable-all=true`.

**Workaround.** Add `gink-video-wallpaper` to BMS → Applications → blacklist (whitelist mode is unaffected).

### Issues in other extensions seen during the runs (not caused by ours)

- **Dash to Dock:** `Clutter-CRITICAL clutter_actor_iter_next: assertion … age` right after each time Dash to Dock is enabled, even when ours is disabled.
- **Hanabi:**
  - `GstPlay`/`GstAudio` typelibs are missing, so it falls back to `GtkMediaFile`.
  - `Gtk-CRITICAL … stream != NULL`.
  - An unhandled rejection from its renderer launcher.
  - It opens its preferences window when no video is configured.
- **Headless-only noise:** pixman `Invalid rectangle` messages and a GJS "sweeping phase of GC" message at shell shutdown.

## Fixed during T27

**Stale mpv windows after a restart.** `Meta.WaylandClient.new_subprocess` passes mpv its Wayland socket through the `Gio.SubprocessLauncher`, and the launcher keeps its copy of that socket open until JS garbage collection.

- **Effect:** after mpv exited, mutter kept its window managed for several seconds. During that time no layer guarded the window. DING focuses the top-most window whenever any window closes, so it focused this dead window.
- **How it showed up:** the `ubuntu-system` scenario failed `windowHidden` in 3 of 3 runs. The old window was still present with its process already reaped.
- **Fix:** `lib/playerProcess.js` now calls `launcher.close()` right after spawning, so the window goes away as soon as mpv exits.
- **Regression check:** the runner's `noStaleWindows` check.

**`readLine` returned `Uint8Array` inside the shell.** GNOME Shell promisifies `Gio.DataInputStream.read_line_async` with the bytes finisher before extensions load, and `Gio._promisify` does not re-wrap a method. As a result, the mpv IPC reader and `spawnLines` (used for transcoder progress) received bytes instead of strings inside the shell. `lib/async.js` now exports `readLine()`, which decodes bytes. `tests/readLine.test.js` reproduces the shell's promisify order.

## Not tested

- Real-hardware idle blanking and DPMS (manual check above).
- Multi-monitor combinations with other extensions: every T27 run used one virtual monitor.
- Visual quality of blur and dock rendering on real GPUs. The headless shells used software rendering.
- Hanabi actually rendering video: its GStreamer typelibs were missing in the fixture.
