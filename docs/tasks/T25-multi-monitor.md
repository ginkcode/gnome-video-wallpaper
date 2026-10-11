# T25 — Multi-monitor reconcile and hotplug

- **Milestone:** M6
- **Depends on:** T05, T24
- **Status:** review
- **Owner:** Claude Code
- **Skills:** Mutter monitors; needs an external display for testing

## Goal

Correct per-monitor videos with any monitor arrangement, scale, and hotplug sequence.

## Deliverables

- Track logical monitors vs physical IDs: one player per logical monitor, resolving the first configured connector in stable sorted order. Mirrored connectors share playback.
- Listen to `Main.layoutManager` `monitors-changed` (and backend monitor changes); debounce 1 s; call `reconcile()`. Derived logical dimensions use scale and transform explicitly, not raw mode dimensions.
- Hotplug/reconfiguration: serialize restarts with old process reaping; each player uses a unique socket; release old assets after reap.
- `BackgroundLayer` must re-find its background actor after the shell rebuilds backgrounds on monitor changes (`Main.layoutManager._bgManagers` are recreated) and re-insert both the clone and owned prepared matching static actor, preserving their visibility/stacking order and rejecting stale generation work.
- Player window geometry follows monitor geometry changes (resolution, scale, position).
- Fractional scaling: clone size uses transformed logical dimensions; mpv renders at explicitly derived target raster geometry (logical size and scale), never at blindly reused physical mode width/height. Check generation/cancellation in monitor-query, debounce and actor-rebuild callbacks.
- Monitors without config show the normal still/original wallpaper.

## Acceptance criteria

- [x] Plug external monitor with its own config → its video starts; laptop video unaffected.
- [x] Unplug → its player stops, no orphan process.
- [x] Change resolution/scale/arrangement in Settings → videos fill correct areas.
- [ ] Suspend with external monitor, resume without it → correct state.
- [ ] Mixed 100%/150% scales render sharp and correctly positioned.
- [x] Mirrored connectors share one player; unmirroring cleanly reconciles to independent logical players.
- [x] Rotation and mixed 100%/150%/200% scale changes update target raster geometry and clone positioning without gaps or overlap.
- [x] Unplugging an external display during active playback reaps its player cleanly without touching the internal display player.

## Verification — 2026-10-11

- `make test` and `make lint` pass. New unit tests cover topology planning (order, placement, unconfigured/unindexed, mirror precedence, identity), the debounced monitor watcher, background anchor/restacking, window geometry correction (panel clamp, misplacement, aspect snap, auto-maximize) and lifecycle cases: removing the external config keeps the internal player, mirror/unmirror, resume with the external monitor gone.
- `python3 -I tests/integration/run-t25-nested.py`: all 23 checks pass in a private headless GNOME Shell 50.1 with two virtual monitors. Layouts are changed through DisplayConfig `ApplyMonitorsConfig`; screenshots sample each logical monitor and mpv reports its render size over IPC. Verified: one player per logical monitor, config removal/re-addition, mirroring by sorted connector with fallback, unmirroring, 200%/150% scales and rotation (window frame equals the logical rectangle, render size = logical × scale), stacked arrangement, background rebuild and container destruction, disabling/re-enabling the external monitor reaps/starts only its player, clean disable, no survivors or shell errors.
- `python3 -I tests/integration/run-t24-nested.py` still passes.
- Defect found by the smoke and fixed: mpv resized its own window (`auto-window-resize`, `keepaspect-window`) and Mutter clamped/auto-maximized the monitor-sized window below the top bar. mpv window sizing is now disabled and BackgroundLayer re-enforces the frame.

Limits: virtual monitors have one mode, so resolution changes are covered by scale/rotation; unplug is simulated by disabling the monitor through DisplayConfig. Physical hotplug, suspend/resume and perceptual sharpness on real mixed-scale hardware are not tested; those two criteria stay open as manual checks.
