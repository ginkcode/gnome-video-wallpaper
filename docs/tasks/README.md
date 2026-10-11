# Task Board

Each task is a self-contained unit of work in its own file. Pick any task whose dependencies are **done**, set yourself as owner, and follow the file.

Read first:
- [conventions.md](conventions.md) — coding rules, workflow, how to claim a task.
- [interfaces.md](interfaces.md) — module contracts shared between tasks. **Code against these so tasks can run in parallel.**
- [../architecture.md](../architecture.md) — overall design.

## Status legend

`todo` · `in-progress` · `review` · `done` · `blocked`

## Tasks

| ID | Title | Milestone | Depends on | Status | Owner |
|---|---|---|---|---|---|
| [T01](T01-project-scaffold.md) | Project scaffold and tooling | M1 | — | done | haith |
| [T02](T02-gsettings-schema.md) | GSettings schema | M1 | T01 | done | haith |
| [T03](T03-core-utilities.md) | Logger and lifecycle utilities | M1 | T01 | done | haith |
| [T04](T04-geometry.md) | Geometry (fit modes) + unit test runner | M1 | T01 | done | haith |
| [T05](T05-monitor-identity.md) | Monitor identity | M1 | T01 | done | haith |
| [T06](T06-mpv-ipc.md) | mpv IPC client | M1 | T03 | done | Claude Code |
| [T07](T07-player-process.md) | mpv player process | M1 | T03, T04 | done | Claude Code |
| [T08](T08-background-layer.md) | Background layer (window hide + clone) | M1 | T03, T07 | done | Claude Code |
| [T09](T09-player-manager-poc.md) | PlayerManager proof of concept | M1 | T02, T05, T06, T07, T08 | review | Claude Code |
| [T10](T10-vo-benchmark.md) | Video output benchmark (spike) | M1 | T09 | review | Claude Code |
| [T11](T11-media-probe.md) | Media probe (ffprobe) | M2 | T03 | review | Claude Code |
| [T12](T12-still-cache.md) | Still frame cache (ffmpeg) | M2 | T04, T11 | review | Claude Code |
| [T13](T13-wallpaper-sync.md) | System wallpaper sync | M2 | T02, T03, T12 | review | Claude Code |
| [T14](T14-flicker-free-handoff.md) | Flicker-free still → video handoff | M2 | T09, T12, T13 | review | Claude Code |
| [T15](T15-startup-gate.md) | Startup gating and staggered start | M3 | T09 | review | Claude Code |
| [T16](T16-player-supervisor.md) | Bounded retries and failure notification | M3 | T09, T14 | review | Claude Code |
| [T17](T17-lock-and-disable.md) | Lock/unlock and disable semantics | M3 | T13, T14, T15 | review | Claude Code |
| [T18](T18-login-performance.md) | Login performance measurement | M3 | T14, T15, T16, T17 | todo | |
| [T19](T19-pause-coverage.md) | Pause on maximized/fullscreen coverage | M4 | T05, T09 | todo | |
| [T20](T20-pause-overview-battery.md) | Pause on Overview and battery | M4 | T19 | todo | |
| [T21](T21-prefs-monitors.md) | Preferences: per-monitor page | M5 | T02, T05, T11, T12 | todo | |
| [T22](T22-prefs-general-diagnostics.md) | Preferences: general, diagnostics, cache | M5 | T02, T11, T12 | todo | |
| [T23](T23-transcoder.md) | GIF and optimized-video transcoder | M5 | T04, T11, T12 | todo | |
| [T24](T24-live-settings.md) | Apply settings live | M5 | T02, T09, T12, T13 | todo | |
| [T25](T25-multi-monitor.md) | Multi-monitor reconcile and hotplug | M6 | T05, T24 | todo | |
| [T26](T26-spanned-wallpaper.md) | Spanned multi-monitor still | M6 | T12, T13, T25 | todo | |
| [T27](T27-compatibility.md) | Compatibility with other extensions | M7 | T14, T19, T25 | todo | |
| [T28](T28-release.md) | README, packaging, EGO review | M7 | all | todo | |

## Parallel tracks

Tasks on different tracks can be worked on at the same time once their dependencies are met.

- **Foundation:** T01 unlocks T02/T03/T04/T05; T03 unlocks T06/T11; T03+T04 unlock T07; T03+T07 unlock T08.
- **Player / M1 feasibility:** T02+T05+T06+T07+T08 unlock T09, then T10. T09 uses staged contract-compatible asset/still fixtures until T12/T13 are implemented; paused-content, compositor-frame and Shell-exit lifetime evidence must be verified in M1, not deferred to handoff.
- **Assets / handoff:** T04+T11 unlock T12; T02+T03+T12 unlock T13; T09+T12+T13 unlock T14.
- **Startup / reliability:** T09 unlocks T15; T09+T14 unlock T16; T13+T14+T15 unlock T17; T14+T15+T16+T17 unlock T18.
- **Pause:** T05+T09 unlock T19, then T20.
- **Prefs (GTK only):** T02+T05+T11+T12 unlock T21; T02+T11+T12 unlock T22. T04+T11+T12 unlock T23; its prefs integration builds on T21 or a contract stub.
- **Live / monitors:** T02+T09+T12+T13 unlock T24; T05+T24 unlock T25; T12+T13+T25 unlock T26.
- **Release:** T14+T19+T25 unlock T27; all tasks must complete before T28.

Good first tasks: **T01**, then **T02 / T03 / T04 / T05** in parallel.
Prefs tasks (T21, T22) need no GNOME Shell knowledge and can proceed alongside the player track once their probe/cache dependencies are met (or use interface stubs per conventions). Task IDs, milestones, status and owners are unchanged; dependency completion and M1 feasibility are not assumed.
