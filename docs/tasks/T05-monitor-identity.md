# T05 — Monitor identity

- **Milestone:** M1
- **Depends on:** T01
- **Status:** done
- **Owner:** haith
- **Skills:** D-Bus, GVariant, Mutter

## Goal

Stable per-monitor IDs that survive reboots, reordering, and hotplug, usable from both shell and prefs.

## Deliverables

- `lib/monitorIdentity.js` [pure] — per [interfaces.md](interfaces.md#libmonitoridentityjs-t05-pure).
  - Call `org.gnome.Mutter.DisplayConfig.GetCurrentState` on the session bus (`/org/gnome/Mutter/DisplayConfig`).
  - Return `{physicalMonitors, logicalMonitors}` exactly as the shared types specify. Physical IDs remain stored-selection keys; current mode dimensions are `modeWidth`/`modeHeight` in physical pixels, never desktop rectangles.
  - Logical monitors expose `{key, connectors, x, y, width, height, scale, transform, primary}`; rectangles are logical desktop coordinates after transform. Derive dimensions using scale and transform explicitly, not by substituting raw mode dimensions.
  - Stably sort connectors, including mirrored members; consumers resolve the first configured connector in that order, with one player per logical monitor.
  - `displayName` from the `display-name` property. D-Bus calls accept cancellation and stale replies must not mutate a newer lifecycle.
- `lib/monitors.js` [shell] — `monitorIndexForConnector(connector)` returns the logical `Main.layoutManager` index or -1; verify the monitor-manager API mapping instead of assuming a physical index is a logical index. Mirrored connectors return the same logical index.
- `tests/monitorIdentity.test.js` — feed a captured `GetCurrentState` fixture (save real output from this device to `tests/fixtures/display-state-edp1.json`, plus hand-made mixed-scale, rotated and mirrored fixtures).

## Acceptance criteria

- [x] On this device returns one monitor `eDP-1:...` with correct size and scale.
- [x] Same monitor yields the same ID across reboots.
- [x] Two identical-model monitors get distinct IDs (serial or connector).
- [x] Tests pass.
- [x] Mixed-scale and rotated fixtures distinguish physical mode pixels from transformed logical rectangles; mirrored connectors share an index/key and resolve the first configured sorted connector regardless of input ordering.
