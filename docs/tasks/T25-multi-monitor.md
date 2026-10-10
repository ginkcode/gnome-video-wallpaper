# T25 — Multi-monitor reconcile and hotplug

- **Milestone:** M6
- **Depends on:** T05, T24
- **Status:** todo
- **Owner:**
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

- [ ] Plug external monitor with its own config → its video starts; laptop video unaffected.
- [ ] Unplug → its player stops, no orphan process.
- [ ] Change resolution/scale/arrangement in Settings → videos fill correct areas.
- [ ] Suspend with external monitor, resume without it → correct state.
- [ ] Mixed 100%/150% scales render sharp and correctly positioned.
- [ ] Mirrored connectors share one player; unmirroring cleanly reconciles to independent logical players.
- [ ] Rotation and mixed 100%/150%/200% scale changes update target raster geometry and clone positioning without gaps or overlap.
- [ ] Unplugging an external display during active playback reaps its player cleanly without touching the internal display player.
