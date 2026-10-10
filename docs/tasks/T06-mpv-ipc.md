# T06 — mpv IPC client

- **Milestone:** M1
- **Depends on:** T03
- **Status:** done
- **Owner:** Claude Code
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
- `tests/mpvIpc.test.js` — run a real `mpv --idle=yes --pause=yes --force-window=no --vo=null --ao=null --input-ipc-server=<tmp>` (skip if mpv missing), test `get_property mpv-version`, `set_property pause`, close, plus kill-while-connected shutdown.

## Acceptance criteria

- [x] No synchronous socket calls.
- [x] Commands resolve/reject correctly; closing rejects pending ones.
- [x] Killing mpv triggers `shutdown`/close handling without exceptions.
- [x] Tests pass.
- [x] Early readiness before wait registration is latched; stale previous-load events cannot satisfy the selected asset, and persistent property reconciliation works even when an event is missed.
- [x] Timeout, cancellation during connect/load/readiness, and close reject promptly without outstanding requests or subscriptions. Null-VO paused-load evidence is tested here; visible Wayland VO and compositor evidence remain the T09 M1 integration gate.

## Verification

Real mpv tests cover paused generated H.264 media, early property readiness, different-path and same-path replacement, cancellation, timeout, explicit close and peer-process exit. The readiness check uses the current playlist entry ID and real mpv properties; it does not resume playback. `make test` and `make lint` pass. No nested Shell lifecycle or visible Wayland VO test was run in T06; those remain M1 integration work, not verified behavior.
