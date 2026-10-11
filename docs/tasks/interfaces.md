# Module Interfaces

Contracts between tasks. Implement exactly these exports; extra private helpers are fine. Signatures are JS with JSDoc-style types. These are planned contracts, not verified runtime behavior; M1 must establish feasibility.

Legend: **[pure]** = no Meta/Main/Gtk imports, unit-testable with `gjs`. **[shell]** = runs inside GNOME Shell. **[prefs]** = runs in prefs process.

## Shared types and ownership

- `PhysicalMonitor`: `{id, connector, vendor, product, serial, displayName, modeWidth, modeHeight}`. Mode dimensions are physical pixels, not desktop rectangles. IDs remain the keys of stored selections.
- `LogicalMonitor`: `{key, connectors, x, y, width, height, scale, transform, primary}`. Rectangle is in logical desktop coordinates after transform; connectors are stably sorted and include mirrored members. Resolve its selection from the first configured connector in sorted order; prefs explains that mirrored members share one wallpaper while retaining independent stored selections. Derive the logical key deterministically from the connector group, not its transient layout index.
- `PlaybackAsset`: `{path, identity, geometryBaked, source, geometry}`. `path` is a stable private playback reference acquired before media load; `source` is probe metadata; `geometry` records target raster size, scale, fitMode and transformation version. `identity` identifies the exact original or optimized bytes and transformation. `geometryBaked` means mpv and still extraction must not apply fitting again.
- `Geometry`: `{width, height, scale, fitMode, transformVersion}`; width/height are target raster pixels, not unlabelled physical mode dimensions. Geometry normalizes sample aspect ratio and rotation before fitting. SDR color metadata is preserved/interpreted consistently; HDR is rejected initially with an actionable prefs error, pending an explicit tone-mapping design.
- Every async continuation (including readiness, paint, fades, retries, settings, probes and publication) checks its lifecycle generation and cancellation before touching shell state. Cancellation settles pending waits promptly and removes only caller-owned work.
- Cache files are disposable, completed immutable entries. Producers use unique job directories/temp files and atomic publication; in-memory promise deduplication is process-local, not a cross-process lock. Consumers acquire private references by copy or hard link before loading; deletion during acquisition retries or falls back. Active references/jobs are outside the eligible clear-cache snapshot. A private reference's lifetime spans from successful acquisition through that player's final reap. A consumer that never spawns releases its reference on cancellation; prefs thumbnail consumers release after extraction completes.
- Applied wallpapers are immutable atomic publications under `$XDG_DATA_HOME/gink-video-wallpaper/wallpapers/` (default `~/.local/share/...`), never cache paths. Initial published-wallpaper GC is deferred, including after restore; prefs reports preserved assets.

## `lib/log.js` (T03) [pure]

```js
export function createLogger(scope)        // -> {debug, info, warn, error}(...args)
export function setDebugEnabled(enabled)
```
Output prefix: `[gink-vw] [<scope>]`.

## `lib/disposables.js` (T03) [pure, GLib/GObject only]

```js
export class Disposables {
    connect(gobject, signal, callback)
    connectAfter(gobject, signal, callback)
    timeout(ms, callback)
    idle(callback)
    add(fn)
    cancellable()
    dispose()                               // synchronous, reverse order, idempotent
}
```
Dispose invalidates/cancels work and disconnects sources synchronously; it does not await process reaping.

## `lib/geometry.js` (T04) [pure]

```js
export const FitMode = {FILL: 'fill', FIT: 'fit', STRETCH: 'stretch'};
export const TRANSFORM_VERSION = 1;
export function computePlacement(srcW, srcH, dstW, dstH, mode)
// -> {x, y, width, height}; source dimensions already SAR/rotation normalized
export function ffmpegScaleFilter(dstW, dstH, mode)
// -> filter producing exactly dstW x dstH; FIT pads black
export function targetGeometry({width, height, scale}, fitMode)
// -> Geometry for a logical monitor's raster; shared by PlayerManager and the prefs preview
export function computeCanvas(logicalMonitors, rasterScale)
// -> {originX, originY, width, height, rasterScale, rectangles: [{key, x, y, width, height}]}
```
Canvas bounds are the union of logical rectangles. Translate by the minimum x/y and rasterize at one common scale; round shared edges once so adjacent rectangles cannot develop gaps/overlap. Compose each logical rectangle once, including mirrored groups. Transform/rotation and media display geometry are explicit inputs to normalization, not inferred from physical mode width/height. For spanned stills, choose the maximum logical monitor scale as the common `rasterScale` and record that choice in tests; playback target raster size remains each monitor's own geometry.

## `lib/mpvArgs.js` (T07) [pure]

```js
export function buildMpvArgv({mpvPath, socketPath, vo, hwdec = 'vaapi',
                              appId = 'gink-video-wallpaper', lowPriority = true})
// -> string[]; idle=yes, force-window=no, pause=yes, no initial file
export function withParentDeathSignal(argv, parentPid)
// -> string[]; setpriv --pdeathsig KILL, then exec argv only if still parented by parentPid
```
Start with no media window; select load options from PlaybackAsset after IPC is subscribed. T25 disables `auto-window-resize`, `keepaspect-window` and `hidpi-window-scale`: the shell owns the logical window rectangle, while Wayland output scale determines the rendered raster. Video fitting remains controlled separately by IPC. Use identity fitting for geometryBaked assets, configured fit otherwise. `--clipboard-backends=vo` is required: mpv's Wayland clipboard backend otherwise consumes the trusted `WAYLAND_SOCKET`, and the video window then arrives on an untrusted connection that `owns_window()` rejects. `PlayerProcess` applies `withParentDeathSignal` itself.

## `lib/monitorIdentity.js` (T05) [pure]

```js
export function parseDisplayConfigState(stateVariantUnpacked)
// -> {physicalMonitors: PhysicalMonitor[], logicalMonitors: LogicalMonitor[]}
export function monitorId({connector, vendor, product, serial})
// -> 'connector:vendor:product:serial' (serial may be empty)
export async function getMonitors(cancellable)
// -> same structure from org.gnome.Mutter.DisplayConfig.GetCurrentState
```

## `lib/monitors.js` (T05) [shell]

```js
export function monitorIndexForConnector(connector) // -> logical Main.layoutManager index or -1
```
Mirrored connectors map to the same logical monitor index.

## `lib/config.js` (T02) [pure]

```js
export function readMonitorConfigs(settings)          // -> {[physicalMonitorId]: {file, fitMode, optimize}}
export function writeMonitorConfig(settings, id, cfg)
export function removeMonitorConfig(settings, id)
export function selectConfigured(connectors, physicalMonitors, configs) // -> {physical, config}|null; sorted connectors
```

## `lib/mpvIpc.js` (T06) [shell-safe, Gio only]

```js
export class MpvIpc {
    constructor(socketPath, logger)
    async connect({timeoutMs = 5000, cancellable})
    async command(args, {cancellable, assetIdentity} = {})
    async setPause(paused, {cancellable} = {})
    observe(property, callback)               // -> unsubscribe; persistent state callback(value)
    onEvent(name, callback)                   // -> unsubscribe
    async waitForContent({assetIdentity, timeoutMs, cancellable})
    close()                                  // async cleanup; rejects outstanding commands/waits
}
```
Subscribe before `loadfile` of the selected paused asset. Persistent observations are latched and property reads reconcile readiness even if `file-loaded`/`playback-restart` events occurred before the wait; an event alone is not readiness proof. Timeout, cancellation, close and superseding loads reject waits promptly. Commands and waits accept caller cancellation; `close()` invalidates the client synchronously and returns a Promise for socket cleanup.

`command(['loadfile', path], {assetIdentity})` associates that `PlaybackAsset.identity` with the path. The path must be the acquired private playback reference; identity is caller-supplied and is not inferred from the path. `assetIdentity` is valid only for `loadfile` with omitted or `replace` mode and is rejected otherwise. `waitForContent` matches only the latest load bearing that identity. Readiness reconciles the combination of current playlist entry, `path === load path`, `idle-active === false`, `vo-configured === true`, and positive `video-out-params`. This is decoder/VO evidence, not compositor-frame evidence, and the wait never changes `pause`. With `--vo=null`, paused load produces that evidence; a visible Wayland VO remains an M1 integration test.

## `lib/playerProcess.js` (T07) [shell]

```js
export async function preparePlayerSocket({cancellable} = {})
// -> absolute socket path; creates/validates the private runtime directory and
//    allocates a short unique per-instance socket basename before argv construction
export function releasePlayerSocket(socketPath)
// Release an unused allocation without removing any file; cancellation also releases it.
export class PlayerProcess {
    constructor({argv, socketPath, logger})
    start()                                  // spawn via Meta.WaylandClient.new_subprocess
    get waylandClient()
    get pid()
    ownsWindow(metaWindow)
    onExit(callback)                          // -> unsubscribe; latched callback({status, signaled})
    terminateNow()                           // synchronous forceful termination request
    async stop({graceMs = 1000})              // bounded graceful stop, resolves after reap
}
```
Call `preparePlayerSocket` before `buildMpvArgv`, then construct the player with that allocated path. Construction consumes the allocation once and rejects a mismatched or duplicated IPC option. If construction/spawning is abandoned, cancel the preparation's cancellable or call `releasePlayerSocket`; neither removes files. Each instance has a short unique socket basename, not a reusable monitor socket. Cleanup may unlink only that instance's socket after reaping. Exit `status` is the exit code, or `128 + signal` when `signaled` is true; the latched result is immutable. `terminateNow()` cancels any grace timer and initiates forceful termination without awaiting. Residual reaping holds only the old process/socket, never extension state. Shell-exit lifetime handling must be demonstrated in M1 (including abnormal exit); do not assume children die with Shell. Mutter does not ensure this, so the child is spawned through `withParentDeathSignal` (requires util-linux `setpriv`).

## `lib/backgroundLayer.js` (T08) [shell]

```js
export class BackgroundLayer {
    constructor({monitorIndex, logger})
    watchWindow(playerProcess, {timeoutMs, cancellable}) // installs listener synchronously; -> Promise<Meta.Window>
    attach(metaWindow)                       // clone at opacity 0; hiding already done in creation callback
    waitForFirstFrame({timeoutMs, cancellable}) // -> Promise; latched compositor paint evidence
    async prepareStatic(publishedPath, {cancellable}) // preload matching still into owned actor
    showStatic()                             // show prepared actor before removing video clone
    fadeIn(ms = 300, {cancellable} = {})      // -> Promise
    destroy()                                // synchronous; settle pending waits
}
```
Call watchWindow before spawn; the window-creation callback identifies ownership and hides the real window immediately, not in a later Promise continuation. Latch readiness even when callers attach late. Compositor first-frame readiness and mpv content readiness are separate conditions; neither wait may hang on cancellation. A GSettings write is not background-load acknowledgment: preload/display an owned still actor before dropping the old clone, retaining it until the system background is known loaded or continuing to use it underneath playback. T25: the owned container is restacked above the topmost background actor matching its monitor property when backgrounds rebuild. Static and clone ordering/visibility survive reparenting; removed/destroyed containers are rebound before redraw with generation checks, and disable cancels pending rebinding. The hidden source window frame is kept equal to the logical monitor rectangle: on `shown`, position/size and maximize changes and monitor changes it is unmaximized (Mutter auto-maximizes monitor-sized windows below the top bar) and moved with user-op `move_resize_frame`, never fullscreened.

Mutter 50 has no `make_below()` or `unset_initiator()`. Verified hiding is `windowActor.opacity = 0`, `windowActor.reactive = false`, `Meta.Window.hide_from_window_list()`, `lower()`, and `stick()`, with `Main.wm.skipNextEffect()`. `set_type(DESKTOP)` and `minimize()` are not part of the verified path: desktop windows cannot be minimized, and minimization was a no-op on the tested normal window. A permanently transparent source still paints into `Clutter.Clone` after `first-frame`. `skip_taskbar` is what Alt+Tab, Overview, workspace thumbnails, and Ubuntu Dock filter on. Native exclusion stays for the window lifetime because releasing it on layer teardown can expose a live player. Preexisting owned windows are rejected: connecting `first-frame` after they have painted does not prove before-first-paint hiding.

## `lib/mediaProbe.js` (T11) [shell + prefs]

```js
export class ProbeError extends Error {}
export async function probe(path, cancellable)
// -> {path, size, mtime, width, height, sampleAspectRatio, rotation, colorPrimaries,
//     colorTransfer, colorSpace, colorRange, isHdr, durationSec, codec, frameRate, isGif, hasVideo,
//     codedWidth, codedHeight}
export function clearProbeCache()
```
Validate SDR/display geometry; reject HDR with an actionable error.
`width`/`height` are display dimensions (SAR applied, then 90°/270° rotation swapped); `codedWidth`/`codedHeight` are the raw stream size. `rotation` is clockwise degrees in {0, 90, 180, 270}; `sampleAspectRatio` is `"N:D"` (`"1:1"` when unset); `mtime` is microseconds since the epoch; untagged color fields are `null`. `ProbeError.code` is one of `NOT_FOUND`, `NOT_REGULAR`, `NO_VIDEO_STREAM`, `FFPROBE_MISSING`, `FFPROBE_FAILED`, `UNSUPPORTED_HDR`, `INVALID_GEOMETRY`. Results are cached in-process by `path|size|mtime`; concurrent callers share one ffprobe run, which is cancelled only when every caller has cancelled.

## `lib/deps.js` (T11) [shell + prefs]

```js
export function findProgram(name)             // -> absolute path or null
export async function checkDependencies(cancellable)
// -> {mpv, ffmpeg, ffprobe, vaapi} booleans; vaapi from `mpv --hwdec=help`
export async function describeDependencies(cancellable)
// -> {mpv, ffmpeg, ffprobe, vaapi}: {found, version|null} (T22)
export function parseVersion(text)            // first-line version of `--version`/`-version` output
```

## `lib/cacheKey.js` (T12) [pure]

```js
export function cacheKey({path, size, mtime, width, height, scale, fitMode, transformVersion, kind, assetIdentity})
// -> hex SHA-256; includes transformation and exact selected asset identity
```

## `lib/stillCache.js` (T12) [shell + prefs]

```js
export async function acquirePlaybackAsset(media, geometry, {optimizedPath = null, cancellable})
// -> PlaybackAsset; private reference, never generates a transcode
export function releasePlaybackAsset(asset)   // only caller-owned reference, after player reap
export async function ensureStill(asset, geometry, cancellable)
// -> completed PNG path from that exact asset; do not fit twice
export async function publishWallpaper(stillPath, cancellable)
// -> immutable persistent PNG path (content-addressed), atomically published from a unique producer temp
// acquire a private input reference first; retry/regenerate if clear-cache raced acquisition
export async function composeSpanned(stills /* [{path, key}] */, canvas, cancellable)
// -> completed PNG path using computeCanvas rectangles (T26)
// cache identity includes ordered canvas mapping, component still identities and transformVersion
export async function clearCache(cancellable)
// -> {removedBytes, preservedActiveBytes, preservedWallpaperBytes}
export async function cacheSize()            // -> bytes under the cache root; hard links counted once (T22)
```
`ensureStill` and `releasePlaybackAsset` accept only assets returned by `acquirePlaybackAsset` in the same process. `CacheError.code` is one of `SOURCE_CHANGED`, `SOURCE_MISSING`, `NOT_ACQUIRED`, `STILL_MISSING`, `FFMPEG_MISSING`, `FFMPEG_FAILED`, `INVALID_STILL`, `INVALID_GEOMETRY`. `releasePlaybackAsset` returns a Promise that callers may ignore. `asset.identity` is `<original|optimized>:<path>|<size>|<mtime>|<WxH@scale>|<fitMode>|v<transformVersion>`.
If optimized media is absent or disappears during acquisition, choose the original, acquire it, and prepare its matching still before handoff. Never silently change assets after still selection. No transcode during login. Clear-cache deletes a snapshot of eligible completed entries, not working directories, private active references or published wallpapers. Cancellation cleans only the caller's job/temp files, not another process's producer or shared publication.

## `lib/transcoder.js` (T23) [shell + prefs]

```js
export async function ensureOptimized(media, {width, height, scale, fitMode, transformVersion}, {onProgress, cancellable})
// -> completed MP4 path (SDR H.264, VA-API decodable); geometry already baked
export function optimizedDir()                             // <cacheRoot>/media
export function optimizedPath(media, geometry)              // <cacheRoot>/media/<cacheKey kind 'media'>.mp4
export function shouldOptimize(media, config, optimizeVideos) // GIF always, else config.optimize ?? optimizeVideos
export function canOptimize(geometry)                       // even raster width/height (H.264 4:2:0)
```
Include fitMode and versioned transformation in identity; normalize SAR/rotation and preserve consistent SDR interpretation. Unique temps and atomic publication follow cache ownership rules. `onProgress(fraction)` is called only while ffmpeg runs, not for an existing entry. Odd rasters throw `CacheError('INVALID_GEOMETRY')`; other failures throw `TRANSCODE_FAILED`, `SOURCE_CHANGED` or `FFMPEG_MISSING`. VA-API failures fall back to libx264 per call. `lib/async.js` gains `spawnLines(argv, {cancellable, onLine})` (stdout and stderr merged; resolves to the exit status, 128+signal when killed).

The shell never transcodes. Targets carry `optimize` (`config.optimize ?? optimize-videos`, part of `selectionKey`); the `acquireAsset` env hook passes `optimizedPath(media, geometry)` when `shouldOptimize` and `canOptimize` hold, so a missing entry falls back to the original.

## `lib/wallpaperSync.js` (T13) [shell]

```js
export class WallpaperSync {
    constructor(extensionSettings, logger, backgroundSettings = new Gio.Settings(org.gnome.desktop.background))
    apply(fileUri, pictureOptions = 'zoom') // accepts only persistent published wallpaper URI; -> false after restore/destroy
    restore()                                // also refuses later apply() on this instance
    destroy()                                // disconnects; does not restore
    get isApplied()
}
export function isPublishedUri(uri)          // file URI of <wallpaperDir>/<sha256>.png
```
Save originals once and set both light/dark URIs. Applying does not prove background readiness. Writes are batched and skipped when values already match. While applied, a background change to a non-published URI (or to options other than ours) is saved as the new original. GNOME Shell 50's lock screen reads `org.gnome.desktop.background`; `org.gnome.desktop.screensaver picture-uri` is not used and is not synced.

## `lib/playerManager.js` (T09, extended by T14–T25) [shell]

```js
export class PlayerManager {
    constructor({settings, logger})
    async start()
    stop({restore = false} = {})            // synchronous invalidate/cleanup/terminateNow; no awaited shell work
    async reconcile()
    get started()                            // false while stopped/sleeping
    setPaused(logicalMonitorKey, reason, paused) // reasons combine with OR
    get targets()                            // last resolved targets; [] after stop()
    onTargets(callback)                      // -> unsubscribe; callback(targets) after each resolution
    ownsWindow(metaWindow)                   // any live or still-reaping player window
}
```
One live player per logical monitor, including replacements. Startup: acquire selected asset + matching published still; prepare static; install window listener; spawn idle; connect/subscribe IPC; load paused asset; await both latched readiness conditions; fade; remove only `startup` pause reason. Battery/coverage/overview reasons remain authoritative.

Replacement: prepare and display replacement still over old video → remove old clone → stop/reap old player → spawn/fade replacement. Bounded graceful stop is permitted for live replacement; serialize all starts with outstanding reaping, including rapid disable/re-enable. Disable synchronously increments generation, cancels waits/fades/retries, destroys actors/disconnects signals and immediately requests forceful termination. No grace timer may later touch extension state; residual reap owns only its old process/socket. Generation checks prevent stale work from spawning, publishing settings or touching a new lifecycle.

T14: starts and reconciles are serialized, and a reconcile with an unchanged selection is a no-op. A failed or timed-out start terminates the player but keeps the layer showing the still; T16 supervises retries. The system wallpaper is applied only with one logical monitor until T26. Disable does not restore the wallpaper until T17.

T16 supervision: a crash or transient failure triggers a retry after `2s, 8s, 30s`. Failures within 10 minutes count toward `max-retries`; reaching it blocks the monitor. Errors classified as permanent (`ProbeError`, or `CacheError` other than `SOURCE_CHANGED`/`STILL_MISSING`) block at once. A blocked monitor keeps its still and gets one notification, and stays blocked until its selection changes or the extension is re-enabled. 60 s of healthy playback clears the failure count. Optional constructor overrides: `backoffMs`, `failureWindowMs`, `healthyMs`. Optional env hooks: `classify(error)`, `maxRetries()`, `notify(key, message)`. `PlayerManager` accepts `openPreferences` for the notification action.

T17: `stop({restore: true})` also restores the saved system wallpaper; `disable()` passes it unless the session is locked. The env hook `onStop({restore})` performs it.

T25: targets cover every configured logical monitor, sorted by logical key. Placement (`x/y/width/height/scale/transform`) and the current layout index join the selection identity so topology changes replace affected players. Physical configs survive disconnection and mirrored groups resolve the first configured connector. Unchanged remaining players are retained; a transition to one logical monitor applies that player's existing published still without restarting it.

T24: `selectionKey` includes source/optimized size and mtime, target geometry, physical ID, optimization choice and captured VO. A running player retains its exact acquired asset through reap. Queued reconciles coalesce to the latest request; an in-flight handoff completes before the next begins. Removal displays the prepared still, reaps/releases the player, restores only when the stored config map is empty, then removes the layer. `restoreWallpaper()` may return a settling delay in milliseconds; the shell uses 1500 ms to cover the system-background transition.

## `lib/monitorTopology.js` (T25) [pure, GLib]

```js
export function planTargets(topology, configs, {defaultFitMode, optimizeVideos, vo, monitorIndexFor, logger})
// -> targets with physical selection, placement, raster geometry and single-monitor wallpaper policy
export function selectionKey(plan, asset) // selected bytes/geometry/VO plus placement and layout index
export class MonitorWatcher {
    constructor({sources, onChange, debounceMs = 1000, logger})
    enable()
    disable()
}
```
The shell watches both `Main.layoutManager` and `global.backend.get_monitor_manager()` `monitors-changed` signals. A generation-guarded one-second debounce requests serialized reconciliation; disable disconnects signals and cancels the timer. Temporarily unindexed logical monitors are skipped until layout settles.

## `lib/liveSettings.js` (T24) [shell-safe, Gio/GLib]

```js
export const LIVE_KEYS // monitor-configs, default-fit-mode, video-output, optimize-videos
export class LiveSettings {
    constructor({settings, onChange, debounceMs = 300, directories = [], logger})
    enable()
    disable()
}
```
Settings bursts and newly published optimized media request one debounced reconcile. Watched directories are created asynchronously; disable cancels that work, disconnects settings and cancels monitors/timers. Completed-media deletion is ignored so clearing cache does not interrupt private active playback references. The shell never transcodes, including on live settings changes; it switches from an original fallback after prefs atomically publishes the optimized entry.

## `lib/sessionLifecycle.js` (T17) [pure]

```js
export function isLockedSession(sessionMode)      // isLocked || currentMode === 'unlock-dialog'
export function watchSleep(loginManager, {onSleep, onResume}) // 'prepare-for-sleep' pairs; -> unwatch()
```

## `lib/pauseController.js` (T19, T20) [shell]

```js
export class PauseController {
    constructor({playerManager, settings, logger})
    enable()
    disable()
}
```

T19: the shell wrapper delegates to `lib/coverageController.js` [pure, injected]: `coveredMonitors(windows, {workspace, isOwn, normalType, maximizeBoth})` and `CoverageController({playerManager, settings, display, workspaceManager, normalType, maximizeBoth, debounceMs = 200})` with `enable()`/`disable()`. It sets the `covered` reason per target key and recomputes, debounced, on display, workspace, window and `pause-on-maximized` changes.

T20: `lib/sessionPauseController.js` [pure, injected] `SessionPauseController({playerManager, settings, overview, createBatteryProxy})` sets the `overview` reason (`pause-on-overview` and `overview.visible`) and the `battery` reason (`pause-on-battery` and UPower `OnBattery`) for every target key. `PlayerManager` env hook `waitForPaintable({cancellable})` delays the first-frame wait while the Overview hides the window group. `lib/async.js` gains `waitUntil(object, signal, isReady, cancellable)`.

## `lib/startupGate.js` (T15) [shell]

```js
export function waitForStartup({delayMs, cancellable}) // latched startup-complete + delay; cancellation rejects
```
The testable core is `lib/startupLifecycle.js` `waitForStartupOn(layoutManager, {delayMs, cancellable, onComplete})`. Only `PlayerManager.start()` is gated; logical-monitor players then start sequentially, with `stagger-ms` between them.

## `prefs/monitorModel.js`, `prefs/latestJobs.js`, `prefs/monitorsPage.js` (T21) [prefs]

```js
export function buildMonitorModel({physicalMonitors, logicalMonitors}, configs)
// -> {groups: [{logical, mirrored, effectiveId, members: [{physical, config, effective}]}], others: [{id, config, connector, title, serial}]}
export function modelLayout(model) // topology signature; config-only changes update rows in place
export async function applySelection({file, logical, defaultFitMode, probe, readConfig, writeConfig, prepare, cancellable})
export async function loadPreview({file, geometry, probe, acquire, ensureStill, release, optimizedPathFor, cancellable}) // releases the asset
export class LatestJobs { run(key, task) /* -> {value}|{error}|{cancelled: true} */; cancel(key); close(); get pending() }
export const MonitorsPage // Adw.PreferencesPage({settings, toast}); close() cancels jobs and disconnects
```
`applySelection` writes only after a successful probe, a valid target raster and an uncancelled job; it keeps the stored fit mode and optimize flag. T23: `prepare(media, geometry, config, cancellable)` runs before the write (the page transcodes there, so a GIF is saved only after its optimized file exists). Previews use `targetGeometry`, so they pre-warm the extension's still cache.

## `prefs/generalPage.js`, `prefs/diagnosticsPage.js`, `prefs/bindings.js`, `prefs/diagnostics.js` (T22) [prefs]

```js
export function bindScaled(settings, key, target, property, factor) // uint key <-> scaled double; returns unbind
export function bindChoice(settings, key, target, nicks)            // enum nick <-> `selected`; returns unbind
export function installCommands(osRelease, missing)                  // -> ['sudo apt install mpv ffmpeg', ...]
export function clearReport({removedBytes, preservedActiveBytes, preservedWallpaperBytes}, formatSize)
export const GeneralPage     // Adw.PreferencesPage({settings}); close() unbinds
export const DiagnosticsPage // Adw.PreferencesPage({toast}); refreshDependencies(), refreshSize(), clear(), close()
```

## Visual acceptance boundary

The still and paused first frame must use the same PlaybackAsset, display geometry and SDR interpretation. Promise tested SDR perceptual continuity, not pixel identity across ffmpeg/mpv/compositor color pipelines. Record visual results for fill/fit/stretch, anamorphic SAR, rotation and tagged SDR sources. HDR remains unsupported until tone mapping has an explicit tested design.
