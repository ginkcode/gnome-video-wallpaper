# T20 — Pause on Overview and battery

- **Milestone:** M4
- **Depends on:** T19
- **Status:** review
- **Owner:** Claude Code
- **Skills:** GNOME Shell overview, UPower D-Bus

## Goal

Additional pause reasons: `overview` and `battery`.

## Deliverables

- In `PauseController`:
  - `overview`: `Main.overview` `showing` → pause all; `hidden` → clear. The Overview shows the static still (T08), so pausing is invisible.
  - `battery`: async proxy to `org.freedesktop.UPower` `/org/freedesktop/UPower`, property `OnBattery`; listen to `g-properties-changed`.
  - Both respect `pause-on-overview` / `pause-on-battery` live.
- When returning from Overview, the clone shows the paused frame then resumes only if no other reason remains. Seed current Overview/UPower state before startup clears its reason; generation-guard async proxy replies and disconnect/cancel work on disable.

## Acceptance criteria

- [x] Opening Overview pauses all players; closing resumes.
- [ ] Unplugging AC pauses (when enabled); replugging resumes. Unit-tested with a fake UPower proxy; the nested session cannot change the real system-bus `OnBattery`, so this is left to the real-session gate.
- [x] Toggling settings takes effect without restart. Nested run for `pause-on-overview`; unit tests for both.
- [x] Opening Overview or switching to battery during startup/fade leaves playback paused after startup clears; clearing either reason still respects coverage/the other reason. Late UPower replies after disable cannot mutate new players.

## Notes

- `lib/sessionPauseController.js` holds the logic with an injected overview, settings and battery-proxy factory. `lib/pauseController.js` composes it with the T19 coverage controller. It uses `Main.overview` and an async `Gio.DBusProxy.new_for_bus` on the system bus with `DO_NOT_AUTO_START`.
- The Overview state is read from `Main.overview.visible`, which is true from `showing` until `hidden`. This is exactly when the Shell hides the window group.
- Reasons are reapplied on every `onTargets()` resolution, so they are set before startup clears its own reason. A UPower reply after disable is dropped: its cancellable is cancelled and the late proxy is never connected. Without UPower, only the battery reason is lost (a warning is logged).
- **T16 finding resolved:** the player's first-frame wait now starts only when the stage can paint it. This uses the env hook `waitForPaintable`, which waits for `Main.overview` `hidden` (`waitUntil` in `lib/async.js`). Discovery and mpv content readiness still use the normal timeouts. Nested run: a start inside the startup Overview stayed `starting` for 13 s with one spawn and no failure, then played 580 ms after the Overview closed.
- Nested verification: `tests/integration/run-t20-nested.py`.
