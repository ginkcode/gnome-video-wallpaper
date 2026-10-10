# T20 — Pause on Overview and battery

- **Milestone:** M4
- **Depends on:** T19
- **Status:** todo
- **Owner:**
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

- [ ] Opening Overview pauses all players; closing resumes.
- [ ] Unplugging AC pauses (when enabled); replugging resumes.
- [ ] Toggling settings takes effect without restart.
- [ ] Opening Overview or switching to battery during startup/fade leaves playback paused after startup clears; clearing either reason still respects coverage/the other reason. Late UPower replies after disable cannot mutate new players.
