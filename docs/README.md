# Gink Video Wallpaper — Planning Docs

Planned GNOME Shell extension that plays SDR videos (MP4, MKV, MOV, WebM, …) and animated GIFs as the desktop wallpaper, per logical monitor, targeting tested perceptual continuity and low login overhead. Mirrored displays share a logical wallpaper; physical monitor selections remain stored independently. Runtime feasibility is gated by M1.

| Document | Contents |
|---|---|
| [requirements.md](requirements.md) | Goals, problems to avoid, decisions, scope |
| [environment.md](environment.md) | Target device and tooling findings |
| [architecture.md](architecture.md) | Components, file layout, runtime design |
| [settings.md](settings.md) | GSettings schema and cache layout |
| [milestones.md](milestones.md) | Implementation plan with acceptance criteria |
| [testing.md](testing.md) | Test strategy, metrics, manual checklist |
| [tasks/](tasks/README.md) | Task board: pick-up-able tasks, conventions, module interfaces |

## Status

Planning complete. Work is tracked in [tasks/README.md](tasks/README.md). Start with T01.
