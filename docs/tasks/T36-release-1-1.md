# T36 — Release 1.1

- **Milestone:** M7
- **Depends on:** T28, T34, T35
- **Status:** review
- **Owner:** Claude Code
- **Skills:** Packaging

## Goal

Publish T34 and T35 to extensions.gnome.org as `version-name` 1.1.

## Deliverables

- `metadata.json` `version-name` is `1.1`; EGO assigns the numeric version.
- The T28 nested run reads the expected `version-name` from `metadata.json`.
- The release checklist is updated for 1.1.

## Acceptance criteria

- [x] `make zip` builds the zip, and the T28 nested run passes every check with `version-name` 1.1.
- [ ] Zip uploaded to EGO and the review answered.
