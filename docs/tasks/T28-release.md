# T28 — README, packaging, EGO review

- **Milestone:** M7
- **Depends on:** all other tasks
- **Status:** review
- **Owner:** Claude Code
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

- [x] Fresh install from zip works on a clean GNOME 50 user account. `python3 -I tests/integration/run-t28-nested.py` runs `make zip`, then `gnome-extensions install --force` into a fresh private `HOME`/`XDG_*`, then a headless GNOME Shell 50.1. The schema is compiled on install, the extension reports `version-name` 1.0, becomes ACTIVE, plays, and shows its indicator. Disable cleans up, no process survives, and no JS error appears. A real second user account has not been tried.
- [ ] Full manual checklist in [../testing.md](../testing.md) passed. [../release-checklist.md](../release-checklist.md) maps each item to automated evidence; the items marked *Real session*, and T18, still need a person on real hardware.
- [x] Release checklist complete. The review-guideline self-check and packaging items pass; only the EGO upload remains.

## Notes

- Root `README.md`, `CONTRIBUTING.md` and `docs/release-checklist.md` added; `metadata.json` has `version-name` 1.0, an updated description and a donation link.
- The zip now includes `LICENSE` and no longer ships `prefs/.gitkeep`. A stray tracked `.pyc` was removed and `__pycache__/` ignored.
- The `v1` tag is left for the maintainer to create once the real-session checks pass.
