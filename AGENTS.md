# AGENTS.md

Guidance for coding agents working on **Gink Video Wallpaper**, a GNOME Shell 50 (Wayland) extension that plays videos and GIFs as per-monitor desktop wallpaper using `mpv` and `ffmpeg`.

## Read first

- `docs/README.md` — planning docs index.
- `docs/tasks/README.md` — task board; pick a task whose dependencies are done.
- `docs/tasks/conventions.md` — coding rules, naming, development loop.
- `docs/tasks/interfaces.md` — module contracts; implement exactly these.

## Commands

```
make lint      # ESLint
make test      # gjs unit tests (tests/*.test.js)
make schemas   # glib-compile-schemas --strict schemas/
make install   # install to ~/.local/share/gnome-shell/extensions/<uuid>
make nested    # nested GNOME Shell for manual testing
```

These targets are created by task T01. Until then, there is nothing to lint or test.

## Key rules

- `extension.js` and `lib/` run inside GNOME Shell: no Gtk/Adw, no synchronous I/O or subprocess calls.
- `prefs.js` and `prefs/` run in a GTK4/libadwaita process: no Meta/Clutter/St/Main.
- Everything created in `enable()` must be released in `disable()`.
- No code comments unless the logic is genuinely non-obvious.
- Hanabi must be disabled when testing on the real session.

## Workflow and commits

- **Commit once per task, when the task is finished.** One task = one commit. Do not mix work from different tasks in one commit.
- **Always run `make test` and `make lint` before committing.** Both must pass. Never commit failing code.
- Update the task's status in `docs/tasks/README.md` and the task file in the same commit.
- **Commit messages must be concise and never longer than 5 lines in total.** Use a short subject line prefixed with the task ID, optionally followed by a blank line and a brief body:
  ```
  T04: add geometry fit modes and test harness

  Fill/fit/stretch placement and matching ffmpeg filters.
  ```
- **Never add a `Co-authored-by` trailer** or any other co-author attribution to commit messages.
- Do not push, amend, or force-push unless explicitly asked.
