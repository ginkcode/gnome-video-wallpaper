# T03 — Logger and lifecycle utilities

- **Milestone:** M1
- **Depends on:** T01
- **Status:** done
- **Owner:** haith
- **Skills:** GJS, GLib main loop

## Goal

Shared helpers that make leak-free `enable()/disable()` easy and logging consistent.

## Deliverables

- `lib/log.js` — per [interfaces.md](interfaces.md#liblogjs-t03-pure).
- `lib/disposables.js` — per [interfaces.md](interfaces.md#libdisposablesjs-t03-pure-glibgobject-only).
  - `timeout()`/`idle()` wrap the callback so the source id is forgotten when it returns `GLib.SOURCE_REMOVE`.
  - `dispose()` swallows and logs individual cleanup errors, continues with the rest.
  - Safe to call `dispose()` multiple times.
- `lib/async.js` [pure]
  - `spawnAsync(argv, {cancellable, stdout = true, stderr = true})` → `{status, stdout, stderr}` using `Gio.Subprocess` + `communicate_utf8_async`.
  - `sleep(ms, cancellable)` → Promise, rejects with `Gio.IOErrorEnum.CANCELLED` when cancelled.
  - `Gio._promisify` calls for the async methods used project-wide (subprocess `communicate_utf8_async`, `wait_async`, `File.query_info_async`, `File.make_directory_async`, `DBusProxy.call`).
- Tests: `tests/disposables.test.js`, `tests/async.test.js` (run a GLib main loop inside the test).

## Acceptance criteria

- [x] Disposing runs all cleanups synchronously in reverse order, disconnects signals, removes pending sources, and cancels cancellables without awaiting process reaping.
- [x] Safe to call `dispose()` multiple times (idempotent).
- [x] `sleep` and `spawnAsync` reject promptly on cancellation, and cancellation removes or kills only caller-owned work.
- [x] `spawnAsync(['true'])` resolves status 0; `spawnAsync(['false'])` status 1; cancellation kills the child.
- [x] `make test`, `make lint` pass.
