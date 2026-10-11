# Contributing

Thanks for helping with Gink Video Wallpaper.

## Where things are

- [docs/README.md](docs/README.md) indexes the planning documents: requirements, architecture, settings and testing.
- [docs/tasks/README.md](docs/tasks/README.md) is the task board. Pick a task whose dependencies are done.
- [docs/tasks/conventions.md](docs/tasks/conventions.md) has the coding rules, naming and development loop.
- [docs/tasks/interfaces.md](docs/tasks/interfaces.md) has the module contracts.
- [AGENTS.md](AGENTS.md) has the short version of the rules for coding agents.

## Development

You need GNOME Shell 50, `mpv`, `ffmpeg`, `gjs`, `node`/`npm` and `glib-compile-schemas`.

```
npm install
make lint      # ESLint
make test      # gjs unit tests (tests/*.test.js)
make schemas   # compile the GSettings schema
make install   # install to ~/.local/share/gnome-shell/extensions/
make nested    # nested GNOME Shell for manual testing
make zip       # release zip in dist/
make logs      # follow the extension's journal output
```

After `make install`, log out and back in to load the new code in your session.

The integration tests in `tests/integration/` start private headless GNOME Shell sessions. Run them with `python3 -I tests/integration/run-tNN-nested.py`. They never touch your real session or settings.

## Rules

- `extension.js` and `lib/` run inside GNOME Shell: no Gtk/Adw, and no synchronous I/O or subprocess calls.
- `prefs.js` and `prefs/` run in a GTK4/libadwaita process: no Meta/Clutter/St/Main.
- Everything created in `enable()` must be released in `disable()`.
- Add a comment only when the logic is genuinely non-obvious.
- Disable Hanabi when you test in your real session.
- Use one commit per task, with the task ID as the subject prefix. `make test` and `make lint` must pass first.
