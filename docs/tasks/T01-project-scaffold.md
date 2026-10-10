# T01 — Project scaffold and tooling

- **Milestone:** M1
- **Depends on:** —
- **Status:** todo
- **Owner:**
- **Skills:** GJS basics, npm, Make

## Goal

Create a loadable empty extension plus build, lint, test, and nested-shell tooling every other task relies on.

## Deliverables

- `metadata.json`
  - `uuid`: `gink-video-wallpaper@ginkcode.github.io`
  - `name`: `Gink Video Wallpaper`
  - `description`, `url` (repo URL), `shell-version: ["50"]`
  - `settings-schema`: `org.gnome.shell.extensions.gink-video-wallpaper`
  - `session-modes: ["user"]`
- `extension.js` — `export default class GinkVideoWallpaper extends Extension` with empty `enable()`/`disable()` logging via `console.log`.
- `prefs.js` — `ExtensionPreferences` subclass with an empty `Adw.PreferencesPage`.
- `lib/`, `prefs/`, `schemas/`, `tests/` directories (with `.gitkeep` where empty).
- `LICENSE` — MIT, copyright `ginkcode`.
- `.gitignore` — `node_modules/`, `dist/`, `schemas/gschemas.compiled`.
- `package.json` — devDependencies: `eslint`, `@eslint/js`, `globals`; scripts `lint`, `lint:fix`.
- `eslint.config.js` — flat config, ES2022 modules, globals for GJS (`imports`, `console`, `log`, `print`, `TextEncoder`, `TextDecoder`, `ARGV`, `globalThis`), ignores `dist/`, `node_modules/`.
- `Makefile` targets:
  - `schemas` — `glib-compile-schemas --strict schemas/`
  - `install` — copy runtime files to `~/.local/share/gnome-shell/extensions/<uuid>/` (after `schemas`)
  - `uninstall`
  - `zip` — `gnome-extensions pack` into `dist/` with `--extra-source=lib --extra-source=prefs`
  - `lint` — `npm run lint`
  - `test` — runs every `tests/*.test.js` with `gjs -m`, non-zero exit on failure
  - `nested` — `dbus-run-session gnome-shell --devkit --wayland` (fallback `--nested` if `--devkit` unsupported)
  - `logs` — `journalctl --user -f -o cat | grep --line-buffered gink-vw`

## Steps

1. Create files above.
2. `npm install`, `make lint`.
3. `make install`, run `make nested`, inside nested shell run `gnome-extensions enable gink-video-wallpaper@ginkcode.github.io`.

## Acceptance criteria

- [ ] `make lint` passes.
- [ ] `make test` exits 0 with no tests.
- [ ] Extension appears in `gnome-extensions list` and enables without errors in the nested shell.
- [ ] `gnome-extensions prefs <uuid>` opens an empty preferences window.
- [ ] `make zip` produces an installable zip.
