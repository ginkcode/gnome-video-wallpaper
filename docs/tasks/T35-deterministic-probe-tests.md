# T35 — Deterministic probe cancellation tests

- **Milestone:** M7
- **Depends on:** T11
- **Status:** review
- **Owner:** Claude Code
- **Skills:** gjs tests

## Goal

The probe cancellation tests pass on any machine speed.

## Findings

Both tests cancelled 20 ms after starting a probe. On a fast Intel machine ffprobe finished first, so the probe resolved instead of being cancelled.

## Deliverables

- The two cancellation tests run with a `PATH` wrapper that delays ffprobe by 300 ms, so the probe is still running when it is cancelled.

## Acceptance criteria

- [x] `make test` passes repeatedly on the fast device.
