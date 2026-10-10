# Conventions

## Claiming a task

1. Check every task in **Depends on** is `done` (or code against [interfaces.md](interfaces.md) with a stub if only the interface is needed).
2. In [README.md](README.md) set **Status** to `in-progress` and fill **Owner**; do the same in the task file header.
3. Create a branch `task/TNN-short-name`.
4. When finished, verify every acceptance criterion, set status `review`, open a PR referencing the task ID.
5. If an interface must change, update [interfaces.md](interfaces.md) in the same PR and mention it in the PR description.

## Platform

- GNOME Shell 50, Wayland, GJS ESM modules (`import ... from 'gi://...'`).
- `extension.js` + `lib/*.js` run **inside GNOME Shell** (Clutter/St/Meta). Never import Gtk/Adw there.
- `prefs.js` + `prefs/*.js` run **in a separate GTK4/libadwaita process**. Never import Meta/Clutter/St/Main there.
- Pure modules (no `Meta`/`Main`/`Gtk`) must be importable from both and from unit tests: `lib/geometry.js`, `lib/cacheKey.js`, `lib/mpvArgs.js`, `lib/monitorIdentity.js` parsing, `lib/config.js`.

## Code rules

- No code comments unless the logic is genuinely non-obvious.
- No synchronous I/O or blocking subprocess calls in the shell process. Use `Gio.Subprocess` async, `Gio.File` async, `Gio.DBusProxy` async.
- `disable()` synchronously invalidates the lifecycle generation, cancels waits/sources, disconnects signals/file monitors, destroys actors, and requests forceful process termination. Use T03 `Disposables`; do not await reaping or leave grace timers touching extension state. Residual reaping owns only the old process/socket; starts are serialized behind it. Every async continuation checks generation before touching shell state.
- Never construct `Gio.Settings`, connect signals, or create actors in constructors of the `Extension` class.
- Use `console.debug/log/warn/error` only through the logger from T03 (tag `[gink-vw]`).
- Follow [GNOME extension review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html).
- Formatting: ESLint config from T01 (`npm run lint` must pass).

## Naming

| Thing | Value |
|---|---|
| UUID | `gink-video-wallpaper@ginkcode.github.io` |
| Schema id | `org.gnome.shell.extensions.gink-video-wallpaper` |
| mpv Wayland app id | `gink-video-wallpaper` |
| Cache dir | `~/.cache/gink-video-wallpaper/` |
| Runtime dir | `$XDG_RUNTIME_DIR/gink-video-wallpaper/` |
| Log tag | `[gink-vw]` |

## Development loop

```
make install        # copy to ~/.local/share/gnome-shell/extensions/<uuid>
make nested         # dbus-run-session gnome-shell --devkit --wayland
make lint
make test
journalctl --user -f -o cat | grep gink-vw
```

Disable Hanabi before testing on the real session:
`gnome-extensions disable hanabi-extension@jeffshee.github.io`

## Commits

- One commit per finished task; never mix tasks in a commit.
- Run `make test` and `make lint` before every commit; both must pass.
- Message: concise, at most 5 lines total, subject prefixed with the task ID (e.g. `T04: add geometry fit modes`).
- Never include `Co-authored-by` or any co-author attribution.
- Include the task status update (`docs/tasks/README.md` + task file) in the same commit.

## Definition of done

- Acceptance criteria in the task file all checked.
- `make lint` and `make test` pass.
- Enable/disable 10× in nested shell: no errors in the journal, no leftover `mpv`/`ffmpeg` processes.
- Docs updated if behavior or interfaces changed.
