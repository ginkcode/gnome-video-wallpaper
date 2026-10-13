# Release checklist — v1.3 (`version-name` 1.3)

v1.3 replaces the spanned still with a native-size still of the primary monitor's video that stays as the wallpaper after disable (T39), on top of v1.2.

Self-check against the [extensions.gnome.org review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html), plus the packaging and manual checks from T28.

## Review guidelines

- [x] **No work before `enable()`.** `extension.js` has no constructor, and modules only run `Gio._promisify` at import time; settings, players, signals and timers are created in `enable()`. `prefs.js` builds its pages in `fillPreferencesWindow()`.
- [x] **`disable()` undoes everything.** It releases every object created in `enable()` in reverse order, using `Disposables` for signals, sources and timers. The T17, T27, T28 and T31 nested runs check that disabling leaves no player, socket, clone, panel indicator or patched method behind, and that no private process survives.
- [x] **No synchronous I/O or subprocesses in the Shell process.** `extension.js` and `lib/` use `Gio` async calls and `Gio.Subprocess` with `wait_async`/`communicate_utf8_async` only. A grep for `spawn_sync`, `spawn_command_line`, `file_get_contents`, `load_contents(` and `replace_contents(` finds nothing. The only synchronous call is `GLib.find_program_in_path`, a PATH lookup.
- [x] **No `eval`, `new Function`, bundled binaries or minified code.** No grep hits, and no source line is longer than 200 characters. The zip contains only JavaScript sources, `metadata.json`, the schema XML and `LICENSE`.
- [x] **Spawned processes are justified in the description.** The extension runs:
  - `mpv` to play the wallpaper;
  - `ffmpeg` to create still frames and optimized copies, under `nice -n 15`/`ionice -c3`;
  - `ffprobe` to check videos;
  - `mpv --hwdec=help` and `--version`/`-version` for the Diagnostics page.

  The `metadata.json` description names mpv and ffmpeg (ffprobe ships with ffmpeg) and says what they are for.
- [x] **Monkey-patches are restored on disable.** The only one is `WorkspaceGroup.prototype._shouldShowWindow`, patched through `InjectionManager` in `lib/workspaceAnimationFilter.js` and cleared in `disable()`. The T31 nested run checks that the original method is back.
- [x] **`session-modes` is justified.** It is `["user"]` only (see [architecture.md](architecture.md)). On lock, GNOME disables the extension, the players stop, and the lock screen shows the still through the system wallpaper.
- [x] **Shell and prefs are separated.** `extension.js` and `lib/` import no Gtk, Gdk or Adw; `prefs.js` and `prefs/` import no Meta, St, Clutter or `ui/main.js`.
- [x] **Logging is quiet.** Debug messages are gated by the `debug-logging` setting. Only errors and a few one-line status messages (no configured wallpaper, a player retry) are logged by default.
- [x] **`metadata.json` follows the rules.** No `version` field (EGO assigns it), `version-name` is `1.3`, `shell-version` is `["50"]`, and the `url` and `donations` fields are filled in.
- [x] **License.** MIT, which is GPL-compatible; `LICENSE` is included in the zip.

## Packaging

- [x] `make zip` produces `dist/gink-video-wallpaper@ginkcode.github.io.shell-extension.zip`. It ships the schema XML only; `gnome-extensions install` compiles it.
- [x] `python3 -I tests/integration/run-t28-nested.py` builds the zip and installs it with `gnome-extensions install --force` into a fresh private `HOME`/`XDG_*`. It then starts a headless GNOME Shell 50 and checks the following, all of which pass:
  - the compiled schema exists after install;
  - the extension loads from the private directory with the `version-name` from `metadata.json`;
  - the extension becomes ACTIVE and its player is playing;
  - the panel indicator appears;
  - disabling stops the player and removes the indicator;
  - no process survives;
  - no JS error appears.
- [x] `make test` and `make lint` pass.
- [ ] Upload the zip at <https://extensions.gnome.org/upload/> and respond to the review.

## Manual checklist ([testing.md](testing.md))

**Automated** means a unit test or private nested-session run covers the item; see the task file. **Real session** means the item needs real hardware, a real login or real displays and has not been done yet.

| Item | Status | Evidence |
|---|---|---|
| Login: still shown immediately, smooth fade, no SDR jump | Real session | Order and handoff are covered by T14/T15 (unit and nested); the 60 fps login recording is still open (T14, T18). |
| Readiness: listener before spawn, IPC before load, latched events | Automated | T06, T07, T09 |
| Disable during fade/retry/reaping, then re-enable | Automated | T17 |
| Clear cache while media is in use | Automated | T12, T22 |
| Fill/fit/stretch identities; missing optimized file falls back | Automated | T12, T23; a visual match with mpv is open in T14 |
| Mixed-scale, rotated, mirrored monitors | Partly | T25, T26 in nested sessions; mixed 100%/150% sharpness needs real displays |
| HDR source shows a prefs error | Automated | T11, T21 |
| Logout → login 5 times | Real session | |
| Lock → unlock | Partly | T17 nested (resume after delay); flicker check needs the real session |
| Suspend → resume | Real session | Unit-tested with a fake login manager (T17) |
| Maximize/fullscreen pauses, restore resumes | Automated | T19 |
| Overview shows still, leaving resumes | Automated | T20 |
| Battery unplug pauses | Real session | Unit-tested with a fake UPower proxy (T20) |
| Player killed: bounded restart, then still and notification | Automated | T16 |
| Missing, corrupt or unsupported file | Automated | T11, T16, T21 |
| GIF timing and looping | Automated | T10, T23 |
| MP4, MKV, MOV, WebM | Automated | T10 |
| Hotplug, different videos per monitor, mixed scaling | Partly | T25 nested hotplug; real external monitor needed |
| Disable keeps the still wallpaper, leaves no processes | Automated | T13, T17, T28 |
| Blur My Shell and Dash to Dock | Automated | T27 (known issues are documented in [compatibility.md](compatibility.md)) |

Other real-session checks still open in task files:

- idle blanking with a video playing (T27);
- Preferences opening from the top bar (T29);
- long-running playlist rotation (T30);
- touchpad and keyboard workspace switching (T31);
- the login performance measurements in T18 (still `todo`).
