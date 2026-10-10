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
export function computeCanvas(logicalMonitors, rasterScale)
// -> {originX, originY, width, height, rasterScale, rectangles: [{key, x, y, width, height}]}
```
Canvas bounds are the union of logical rectangles. Translate by the minimum x/y and rasterize at one common scale; round shared edges once so adjacent rectangles cannot develop gaps/overlap. Compose each logical rectangle once, including mirrored groups. Transform/rotation and media display geometry are explicit inputs to normalization, not inferred from physical mode width/height. For spanned stills, choose the maximum logical monitor scale as the common `rasterScale` and record that choice in tests; playback target raster size remains each monitor's own geometry.

## `lib/mpvArgs.js` (T07) [pure]

```js
export function buildMpvArgv({mpvPath, socketPath, vo, hwdec = 'vaapi',
                              appId = 'gink-video-wallpaper', lowPriority = true})
// -> string[]; idle=yes, force-window=no, pause=yes, no initial file
```
Start with no media window; select load options from PlaybackAsset after IPC is subscribed. Use identity fitting for geometryBaked assets, configured fit otherwise.

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
```

## `lib/mpvIpc.js` (T06) [shell-safe, Gio only]

```js
export class MpvIpc {
    constructor(socketPath, logger)
    async connect({timeoutMs = 5000, cancellable})
    async command(args, {cancellable} = {})
    async setPause(paused, {cancellable} = {})
    observe(property, callback)               // -> unsubscribe; persistent state callback(value)
    onEvent(name, callback)                   // -> unsubscribe
    async waitForContent({assetIdentity, timeoutMs, cancellable})
    close()                                  // rejects outstanding commands/waits
}
```
Subscribe before `loadfile` of the selected paused asset. Read/reconcile persistent properties (loaded path/idle state and video readiness) as well as `file-loaded`/`playback-restart` events; an event alone is not proof of readiness for the current load. `waitForContent` latches and reconciles current-load state so early events cannot be missed, rejects on timeout/close/cancellation, and never resumes playback itself. Exact paused-content evidence is an M1 feasibility test.

## `lib/playerProcess.js` (T07) [shell]

```js
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
Each instance has a short unique socket basename, not a reusable monitor socket. Cleanup may unlink only that instance's socket after reaping. `terminateNow()` cancels any grace timer and initiates forceful termination without awaiting. Residual reaping holds only the old process/socket, never extension state. Shell-exit lifetime handling must be demonstrated in M1 (including abnormal exit); do not assume children die with Shell. A verified external lifetime mechanism is required if the spawning API does not ensure this.

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
Call watchWindow before spawn; the window-creation callback identifies ownership and hides the real window immediately, not in a later Promise continuation. Latch readiness even when callers attach late. Compositor first-frame readiness and mpv content readiness are separate conditions; neither wait may hang on cancellation. A GSettings write is not background-load acknowledgment: preload/display an owned still actor before dropping the old clone, retaining it until the system background is known loaded or continuing to use it underneath playback.

## `lib/mediaProbe.js` (T11) [shell + prefs]

```js
export class ProbeError extends Error {}
export async function probe(path, cancellable)
// -> {path, size, mtime, width, height, sampleAspectRatio, rotation, colorPrimaries,
//     colorTransfer, colorSpace, colorRange, isHdr, durationSec, codec, frameRate, isGif, hasVideo}
```
Validate SDR/display geometry; reject HDR with an actionable error.

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
// -> immutable persistent PNG path, atomically published from a unique producer temp
// acquire a private input reference first; retry/regenerate if clear-cache raced acquisition
export async function composeSpanned(stills /* [{path, key}] */, canvas, cancellable)
// -> completed PNG path using computeCanvas rectangles (T26)
// cache identity includes ordered canvas mapping, component still identities and transformVersion
export async function clearCache(cancellable)
// -> {removedBytes, preservedActiveBytes, preservedWallpaperBytes}
```
If optimized media is absent or disappears during acquisition, choose the original, acquire it, and prepare its matching still before handoff. Never silently change assets after still selection. No transcode during login. Clear-cache deletes a snapshot of eligible completed entries, not working directories, private active references or published wallpapers. Cancellation cleans only the caller's job/temp files, not another process's producer or shared publication.

## `lib/transcoder.js` (T23) [shell + prefs]

```js
export async function ensureOptimized(media, {width, height, scale, fitMode, transformVersion}, {onProgress, cancellable})
// -> completed MP4 path (SDR H.264, VA-API decodable); geometry already baked
```
Include fitMode and versioned transformation in identity; normalize SAR/rotation and preserve consistent SDR interpretation. Unique temps and atomic publication follow cache ownership rules.

## `lib/wallpaperSync.js` (T13) [shell]

```js
export class WallpaperSync {
    constructor(extensionSettings, logger)
    apply(fileUri, pictureOptions = 'zoom') // accepts only persistent published wallpaper URI
    restore()
    get isApplied()
}
```
Save originals once and set both light/dark URIs. Applying does not prove background readiness.

## `lib/playerManager.js` (T09, extended by T14–T25) [shell]

```js
export class PlayerManager {
    constructor({settings, logger})
    async start()
    stop()                                  // synchronous invalidate/cleanup/terminateNow; no awaited shell work
    async reconcile()
    setPaused(logicalMonitorKey, reason, paused) // reasons combine with OR
}
```
One live player per logical monitor, including replacements. Startup: acquire selected asset + matching published still; prepare static; install window listener; spawn idle; connect/subscribe IPC; load paused asset; await both latched readiness conditions; fade; remove only `startup` pause reason. Battery/coverage/overview reasons remain authoritative.

Replacement: prepare and display replacement still over old video → remove old clone → stop/reap old player → spawn/fade replacement. Bounded graceful stop is permitted for live replacement; serialize all starts with outstanding reaping, including rapid disable/re-enable. Disable synchronously increments generation, cancels waits/fades/retries, destroys actors/disconnects signals and immediately requests forceful termination. No grace timer may later touch extension state; residual reap owns only its old process/socket. Generation checks prevent stale work from spawning, publishing settings or touching a new lifecycle.

## `lib/pauseController.js` (T19, T20) [shell]

```js
export class PauseController {
    constructor({playerManager, settings, logger})
    enable()
    disable()
}
```

## `lib/startupGate.js` (T15) [shell]

```js
export function waitForStartup({delayMs, cancellable}) // latched startup-complete + delay; cancellation rejects
```

## Visual acceptance boundary

The still and paused first frame must use the same PlaybackAsset, display geometry and SDR interpretation. Promise tested SDR perceptual continuity, not pixel identity across ffmpeg/mpv/compositor color pipelines. Record visual results for fill/fit/stretch, anamorphic SAR, rotation and tagged SDR sources. HDR remains unsupported until tone mapping has an explicit tested design.
