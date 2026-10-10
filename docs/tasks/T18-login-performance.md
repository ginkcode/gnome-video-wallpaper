# T18 — Login performance measurement

- **Milestone:** M3
- **Depends on:** T14, T15, T16, T17
- **Status:** todo
- **Owner:**
- **Skills:** Linux performance measurement

## Goal

Prove the extension fixes the slow-login problem with numbers.

## Steps

1. Create `tools/measure-login.sh`: after login, records from the journal the time of `gnome-shell` start, `startup-complete`, first player spawn, fade-in done; and launch times of a fixed app set (e.g. `gnome-text-editor`, `nautilus`, `gnome-terminal`/`ptyxis`, browser) using `systemd-run --user --scope` + window-mapped timestamps or `time` to first window via `gdbus`.
2. Run 5 logout/login cycles each with:
   - no video wallpaper extension,
   - this extension,
   - (optional) Hanabi for reference.
3. Record CPU/GPU/RSS 30 s after login.

## Deliverables

- `tools/measure-login.sh`
- `docs/benchmarks/login-performance.md` with tables (median, min, max) and conclusions.

## Acceptance criteria

- [ ] Median app launch times with this extension within 10% of baseline.
- [ ] Still visible from first frame; video visible within `startup-delay + 2 s` of `startup-complete`.
- [ ] Any regression has a follow-up task filed.
- [ ] Login trace confirms no transcode; optimized cache miss/deletion uses acquired original plus its matching still and preserves the persistent system wallpaper.
- [ ] Measurement includes rapid re-enable and mixed-scale/mirrored layouts: one player per logical monitor, no overlapping reaps/starts or stale readiness work.
