# T28 — README, packaging, EGO review

- **Milestone:** M7
- **Depends on:** all other tasks
- **Status:** todo
- **Owner:**
- **Skills:** Documentation, GNOME extension review rules

## Goal

Ship a polished release usable by others and acceptable to extensions.gnome.org.

## Deliverables

- Root `README.md`: features, screenshots/GIF, requirements (`mpv`, `ffmpeg`, VA-API drivers), install from source/zip, usage, troubleshooting (missing codecs, NVIDIA notes, Hanabi conflict), uninstall, license.
- `CONTRIBUTING.md` linking to `docs/tasks/`.
- `make zip` output validated with `gnome-extensions install --force` in a clean nested session.
- Review-guideline self-check (document in `docs/release-checklist.md`):
  - No work in constructor; everything undone in `disable()`.
  - No sync subprocess/IO in shell process.
  - No `eval`, no bundled binaries, no minified code.
  - Spawned processes justified in description (mpv, ffmpeg).
  - Monkey-patches (if any) restored on disable.
  - `session-modes` justified.
- Version tag `v1` (`version-name: "1.0"`).

## Acceptance criteria

- [ ] Fresh install from zip works on a clean GNOME 50 user account.
- [ ] Full manual checklist in [../testing.md](../testing.md) passed.
- [ ] Release checklist complete.
