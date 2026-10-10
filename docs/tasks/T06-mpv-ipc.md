# T06 — mpv IPC client

- **Milestone:** M1
- **Depends on:** T03
- **Status:** todo
- **Owner:**
- **Skills:** Gio sockets, async JS

## Goal

Non-blocking control of mpv over its JSON IPC unix socket.

Reference: https://mpv.io/manual/stable/#json-ipc

## Deliverables

- `lib/mpvIpc.js` — per [interfaces.md](interfaces.md#libmpvipcjs-t06-shell-safe-gio-only).
  - Connect with `Gio.SocketClient.connect_async(Gio.UnixSocketAddress)`; retry every 100 ms until `timeoutMs` (mpv creates the socket after start).
  - Line-delimited JSON read loop with `Gio.DataInputStream.read_line_async`.
  - Each command gets a `request_id`; promise resolves on matching reply, rejects on `error != "success"` or close.
  - `observe(property, cb)` uses `observe_property` and returns unsubscribe; maintain persistent state and reconcile observations with property reads.
  - `onEvent(name, cb)` dispatches `{"event": name}` messages and returns unsubscribe.
  - Subscribe before loading the selected paused `PlaybackAsset` into idle mpv. `waitForContent({assetIdentity, timeoutMs, cancellable})` latches and reconciles current-load evidence: loaded path/idle state and video readiness as well as `file-loaded`/`playback-restart`. An event alone is not readiness proof, and an old load must not satisfy a new asset's wait.
  - Content readiness is separate from T08 compositor-frame readiness; neither resumes playback. Establish exact paused-content evidence with T09 in M1, not by assuming a particular event works while paused.
  - `connect`, commands, `setPause` and content waits accept caller cancellation. Guard asynchronous callbacks by lifecycle generation/cancellation; timeout, cancellation and close settle waits promptly and release their subscriptions/sources.
  - `close()` cancels reads, rejects pending requests and readiness waits, closes the connection; idempotent.
- `tests/mpvIpc.test.js` — run a real `mpv --idle=yes --no-video --input-ipc-server=<tmp>` (skip if mpv missing), test `get_property mpv-version`, `set_property pause`, close.

## Acceptance criteria

- [ ] No synchronous socket calls.
- [ ] Commands resolve/reject correctly; closing rejects pending ones.
- [ ] Killing mpv triggers `shutdown`/close handling without exceptions.
- [ ] Tests pass.
- [ ] Early readiness before wait registration is latched; stale previous-load events cannot satisfy the selected asset, and persistent property reconciliation works even when an event is missed.
- [ ] Timeout, cancellation during connect/load/readiness, and close reject promptly without outstanding requests or subscriptions. Paused-load evidence is recorded in the M1 integration test.
