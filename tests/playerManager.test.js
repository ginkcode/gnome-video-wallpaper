import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {sleep} from '../lib/async.js';
import {PlayerManagerLifecycle, PlayerState, fitCommands, outstandingReapCount}
    from '../lib/playerManagerLifecycle.js';
import {assertDeepEqual, assertEqual, assertThrows, run, test} from './harness.js';

const quiet = {debug() {}, info() {}, warn() {}, error() {}};
const KEY = 'Virtual-1';
const BOUNDARIES = ['gate', 'resolve', 'probe', 'acquire', 'still', 'publish', 'static', 'socket', 'connect', 'load',
    'content', 'frame', 'fade'];

function cancelledError() {
    return new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'cancelled');
}

class Fixture {
    constructor({held = new Set()} = {}) {
        this.held = held;
        this.log = [];
        this.gates = new Map();
        this.processes = [];
        this.layers = [];
        this.pauses = [];
        this.released = [];
        this.acquired = [];
        this.selection = 'video';
        this.keys = [KEY];
        this.staggerMs = 0;
        this.notifications = [];
        this.stops = [];
    }

    gate(name, cancellable, value) {
        this.log.push(name);
        if (!this.held.has(name))
            return Promise.resolve(value);
        return new Promise((resolve, reject) => {
            const gate = {resolve: () => resolve(value), reject};
            this.gates.set(name, gate);
            cancellable?.connect(() => reject(cancelledError()));
        });
    }

    release(name) {
        this.held.delete(name);
        this.gates.get(name)?.resolve();
    }

    async reached(name) {
        for (let i = 0; i < 200 && !this.gates.has(name); i++)
            await sleep(1);
        if (!this.gates.has(name))
            throw new Error(`boundary ${name} never reached; log ${this.log.join(',')}`);
    }

    env() {
        return {
            waitForStartup: ({cancellable}) => this.gate('gate', cancellable),
            staggerMs: () => this.staggerMs,
            maxRetries: () => 3,
            notify: (key, message) => this.notifications.push(`${key}: ${message}`),
            onStop: ({restore}) => this.stops.push(restore),
            resolveTargets: ({cancellable}) => this.gate('resolve', cancellable, this.keys.map(key => ({
                logicalMonitorKey: key, selectedPhysicalMonitorId: `${key}:a:b:`, monitorIndex: 0,
                selectionKey: this.selection, file: `/${this.selection}.mp4`, optimizedPath: null,
                geometry: {fitMode: 'fill'}, systemWallpaper: this.keys.length === 1,
            }))),
            probe: (path, cancellable) => this.gate('probe', cancellable, {path}),
            acquireAsset: (media, geometry, {cancellable}) => {
                const asset = {path: `/refs${media.path}`, identity: `${media.path}#fill`,
                    geometryBaked: false, geometry};
                return this.gate('acquire', cancellable, asset).then(value => {
                    this.acquired.push(value);
                    return value;
                });
            },
            releaseAsset: asset => {
                this.log.push(`release:${asset.path}`);
                this.acquired.splice(this.acquired.indexOf(asset), 1);
                return Promise.resolve();
            },
            ensureStill: (asset, _geometry, cancellable) => this.gate('still', cancellable, `/stills${asset.path}.png`),
            publishWallpaper: (still, cancellable) => this.gate('publish', cancellable, `/wallpapers${still}`),
            applyWallpaper: path => this.log.push(`apply:${path}`),
            createLayer: () => {
                const fixture = this;
                const layer = {
                    destroyed: false,
                    shown: null,
                    prepareStatic: (path, {cancellable}) => fixture.gate('static', cancellable).then(() => {
                        layer.shown ??= path;
                        layer.prepared = path;
                    }),
                    showStatic: () => {
                        fixture.log.push(`show:${layer.prepared}`);
                        layer.shown = layer.prepared;
                    },
                    watchWindow: (process, {cancellable}) => {
                        fixture.log.push(`watch:${process.started}`);
                        return fixture.gate('window', cancellable, 'window');
                    },
                    attach: window => fixture.log.push(`attach:${window}`),
                    waitForFirstFrame: ({cancellable}) => fixture.gate('frame', cancellable),
                    fadeIn: (_ms, {cancellable}) => fixture.gate('fade', cancellable),
                    destroy() {
                        layer.destroyed = true;
                    },
                };
                this.layers.push(layer);
                return layer;
            },
            prepareSocket: ({cancellable}) => this.gate('socket', cancellable, '/run/mpv-1'),
            releaseSocket: path => this.released.push(path),
            createProcess: () => {
                const fixture = this;
                let reap;
                const process = {
                    started: false, terminated: false, exit: null,
                    reaped: new Promise(resolve => {
                        reap = resolve;
                    }),
                    reap: () => {
                        fixture.log.push(`reap:${fixture.processes.indexOf(process)}`);
                        reap();
                    },
                    onExit: callback => {
                        process.exit = callback;
                    },
                    start: () => {
                        this.log.push('spawn');
                        process.started = true;
                    },
                    terminateNow: () => {
                        process.terminated = true;
                    },
                    ownsWindow: window => window === `window:${fixture.processes.indexOf(process)}`,
                    stop: ({graceMs}) => {
                        fixture.log.push(`stop:${graceMs}`);
                        return process.reaped;
                    },
                };
                this.processes.push(process);
                return process;
            },
            createIpc: () => ({
                connect: ({cancellable}) => this.gate('connect', cancellable),
                command: (args, {cancellable} = {}) => this.gate(args[0] === 'loadfile' ? 'load'
                    : `cmd:${args[1]}=${args[2]}`, cancellable),
                waitForContent: ({cancellable}) => this.gate('content', cancellable),
                setPause: paused => {
                    this.pauses.push(paused);
                    return Promise.resolve();
                },
                close: () => Promise.resolve(),
            }),
        };
    }

    manager() {
        return new PlayerManagerLifecycle({env: this.env(), logger: quiet, fadeMs: 0});
    }
}

async function drainReaps(fixture) {
    for (const process of fixture.processes)
        process.reap();
    for (let i = 0; i < 50 && outstandingReapCount(); i++)
        await sleep(1);
}

test('fit modes map to mpv properties and baked geometry is identity', () => {
    assertDeepEqual(fitCommands('fill'), [['set_property', 'keepaspect', true], ['set_property', 'panscan', 1]]);
    assertDeepEqual(fitCommands('fit'), [['set_property', 'keepaspect', true], ['set_property', 'panscan', 0]]);
    assertDeepEqual(fitCommands('fill', true), fitCommands('stretch'));
    assertThrows(() => fitCommands('zoom'));
});

test('startup order: still, watch before spawn, subscribe, paused load, both readiness waits, fade, unpause', async () => {
    const fixture = new Fixture();
    const manager = fixture.manager();
    await manager.start();
    assertDeepEqual(fixture.log, ['gate', 'resolve', 'probe', 'acquire', 'still', 'publish',
        'apply:/wallpapers/stills/refs/video.mp4.png', 'static', 'socket', 'watch:false', 'window', 'spawn',
        'connect', 'cmd:keepaspect=true', 'cmd:panscan=1', 'load', 'content', 'attach:window', 'frame', 'fade']);
    assertEqual(fixture.layers[0].shown, '/wallpapers/stills/refs/video.mp4.png', 'published still displayed');
    assertDeepEqual(fixture.pauses, [false]);
    assertEqual(manager.getState(KEY), PlayerState.PLAYING);
    const player = manager.getPlayer(KEY);
    assertEqual(player.selectedPhysicalMonitorId, 'Virtual-1:a:b:');
    assertEqual(player.asset.identity, '/video.mp4#fill');
    assertEqual(player.asset.path, '/refs/video.mp4', 'private reference loaded');
    manager.stop();
    assertEqual(fixture.processes[0].terminated, true);
    assertEqual(fixture.layers[0].destroyed, true);
    assertEqual(manager.getState(KEY), PlayerState.STOPPED);
    await drainReaps(fixture);
});

test('two pause reasons resume only when both are cleared', async () => {
    const fixture = new Fixture();
    const manager = fixture.manager();
    await manager.start();
    manager.setPaused(KEY, 'battery', true);
    manager.setPaused(KEY, 'coverage', true);
    manager.setPaused(KEY, 'battery', false);
    assertEqual(manager.getState(KEY), PlayerState.PAUSED);
    manager.setPaused(KEY, 'coverage', false);
    assertEqual(manager.getState(KEY), PlayerState.PLAYING);
    assertDeepEqual(fixture.pauses, [false, true, true, true, false]);
    manager.stop();
    await drainReaps(fixture);
});

test('clearing startup preserves reasons set while starting', async () => {
    const fixture = new Fixture({held: new Set(['content'])});
    const manager = fixture.manager();
    const starting = manager.start();
    await fixture.reached('content');
    manager.setPaused(KEY, 'overview', true);
    assertDeepEqual(fixture.pauses, []);
    fixture.release('content');
    await starting;
    assertDeepEqual(fixture.pauses, [true]);
    assertEqual(manager.getState(KEY), PlayerState.PAUSED);
    manager.stop();
    await drainReaps(fixture);
});

for (const boundary of BOUNDARIES) {
    test(`stop at ${boundary} is synchronous and stale completion touches nothing`, async () => {
        const fixture = new Fixture({held: new Set([boundary])});
        const manager = fixture.manager();
        const starting = manager.start();
        await fixture.reached(boundary);
        const before = fixture.log.length;
        manager.stop();
        const spawned = fixture.log.includes('spawn');
        assertEqual(fixture.processes.every(process => process.terminated), true, 'terminated');
        assertEqual(fixture.layers.every(layer => layer.destroyed), true, 'layers destroyed');
        fixture.gates.get(boundary).resolve();
        await starting;
        await sleep(5);
        assertDeepEqual(fixture.log.slice(before).filter(entry => !/^(stop|release):/.test(entry)), [],
            'no work after stop');
        assertEqual(fixture.log.includes('spawn'), spawned, 'no stale spawn');
        assertEqual(manager.getState(KEY), PlayerState.STOPPED);
        assertDeepEqual(fixture.pauses, []);
        await drainReaps(fixture);
        await sleep(1);
        assertDeepEqual(fixture.acquired, [], 'acquired asset released');
    });
}

test('socket allocated after stop is released and never consumed', async () => {
    const fixture = new Fixture();
    const env = fixture.env();
    let resolveSocket;
    env.prepareSocket = () => new Promise(resolve => {
        resolveSocket = resolve;
    });
    const manager = new PlayerManagerLifecycle({env, logger: quiet, fadeMs: 0});
    const starting = manager.start();
    for (let i = 0; i < 50 && !resolveSocket; i++)
        await sleep(1);
    manager.stop();
    resolveSocket('/run/mpv-2');
    await starting;
    assertDeepEqual(fixture.released, ['/run/mpv-2']);
    assertEqual(fixture.processes.length, 0);
});

test('re-enable waits for the previous reap before spawning', async () => {
    const old = new Fixture();
    const first = old.manager();
    await first.start();
    first.stop();
    const fresh = new Fixture();
    const second = fresh.manager();
    const starting = second.start();
    await sleep(10);
    assertDeepEqual(fresh.log, ['gate'], 'nothing but the gate before old reap');
    old.processes[0].reap();
    await starting;
    assertEqual(fresh.log.includes('spawn'), true);
    assertEqual(second.getState(KEY), PlayerState.PLAYING);
    second.stop();
    await drainReaps(fresh);
});

test('unexpected exit during readiness fails and leaves the still visible', async () => {
    const fixture = new Fixture({held: new Set(['frame'])});
    const manager = fixture.manager();
    const starting = manager.start();
    await fixture.reached('frame');
    fixture.processes[0].exit({status: 137, signaled: true});
    assertEqual(manager.getState(KEY), PlayerState.FAILED);
    assertEqual(fixture.layers[0].destroyed, false, 'still layer kept');
    assertEqual(fixture.log.at(-2), 'show:/wallpapers/stills/refs/video.mp4.png', 'still shown over the clone');
    fixture.gates.get('frame').reject(new Error('layer destroyed'));
    await starting;
    assertEqual(manager.getState(KEY), PlayerState.FAILED);
    manager.stop();
    assertEqual(fixture.layers[0].destroyed, true, 'disable removes the still layer');
    await drainReaps(fixture);
});

test('a failed step leaves the still and releases the asset only after reap', async () => {
    const fixture = new Fixture();
    const env = fixture.env();
    env.createIpc = () => ({
        connect: () => Promise.reject(new Error('socket timeout')),
        close: () => Promise.resolve(),
    });
    const manager = new PlayerManagerLifecycle({env, logger: quiet, fadeMs: 0});
    await manager.start();
    assertEqual(manager.getState(KEY), PlayerState.FAILED);
    assertEqual(fixture.layers[0].destroyed, false, 'still kept');
    assertEqual(fixture.processes[0].terminated, true, 'player terminated');
    await sleep(5);
    assertEqual(fixture.acquired.length, 1, 'asset held until reap');
    await drainReaps(fixture);
    await sleep(1);
    assertDeepEqual(fixture.acquired, [], 'asset released after reap');
    manager.stop();
});

test('probe failure before any still keeps the system wallpaper and holds nothing', async () => {
    const fixture = new Fixture();
    const env = fixture.env();
    env.probe = () => Promise.reject(new Error('HDR video is not supported'));
    const manager = new PlayerManagerLifecycle({env, logger: quiet, fadeMs: 0});
    await manager.start();
    assertEqual(fixture.layers.length, 0, 'no layer');
    assertEqual(fixture.log.some(entry => entry.startsWith('apply:')), false, 'system wallpaper untouched');
    manager.stop();
});

test('replacement shows the new still, removes the old clone, reaps, then starts the new player', async () => {
    const fixture = new Fixture();
    const manager = fixture.manager();
    await manager.start();
    manager.setPaused(KEY, 'battery', true);
    fixture.selection = 'next';
    const before = fixture.log.length;
    const replacing = manager.reconcile();
    for (let i = 0; i < 50 && !fixture.log.includes('stop:1000'); i++)
        await sleep(1);
    await sleep(5);
    assertEqual(fixture.processes.length, 1, 'no overlapping player before reap');
    assertEqual(fixture.processes[0].terminated, false, 'graceful stop');
    assertEqual(fixture.layers[0].shown, '/wallpapers/stills/refs/next.mp4.png', 'replacement still over old video');
    fixture.processes[0].reap();
    await replacing;
    const NEXT = '/wallpapers/stills/refs/next.mp4.png';
    assertDeepEqual(fixture.log.slice(before, before + 14), ['resolve', 'probe', 'acquire', 'still', 'publish',
        `apply:${NEXT}`, 'static', `show:${NEXT}`, 'stop:1000', 'reap:0', 'release:/refs/video.mp4', 'static',
        'socket', 'watch:false']);
    assertEqual(fixture.layers[0].destroyed, true, 'old layer removed after the new still is prepared');
    assertEqual(fixture.layers[1].shown, NEXT, 'new layer starts from the same still');
    assertEqual(manager.getPlayer(KEY).asset.path, '/refs/next.mp4');
    assertEqual(manager.getState(KEY), PlayerState.PAUSED, 'battery reason survives replacement');
    assertDeepEqual(fixture.acquired.map(asset => asset.path), ['/refs/next.mp4']);
    manager.stop();
    await drainReaps(fixture);
});

test('reconcile with an unchanged selection keeps the running player', async () => {
    const fixture = new Fixture();
    const manager = fixture.manager();
    await manager.start();
    const before = fixture.log.length;
    await manager.reconcile();
    assertDeepEqual(fixture.log.slice(before), ['resolve']);
    assertEqual(manager.getState(KEY), PlayerState.PLAYING);
    manager.stop();
    await drainReaps(fixture);
});

test('disable during graceful replacement terminates and removes everything', async () => {
    const fixture = new Fixture();
    const manager = fixture.manager();
    await manager.start();
    fixture.selection = 'next';
    const replacing = manager.reconcile();
    for (let i = 0; i < 50 && !fixture.log.includes('stop:1000'); i++)
        await sleep(1);
    manager.stop();
    assertEqual(fixture.processes[0].terminated, true, 'forceful termination requested');
    assertEqual(fixture.layers.every(layer => layer.destroyed), true, 'layers destroyed');
    await drainReaps(fixture);
    await replacing;
    await sleep(5);
    assertEqual(fixture.processes.length, 1, 'no stale spawn');
    assertDeepEqual(fixture.acquired, [], 'both assets released');
});

test('players start sequentially with the stagger between them', async () => {
    const fixture = new Fixture();
    fixture.keys = ['A', 'B'];
    fixture.staggerMs = 40;
    const spawns = [];
    const env = fixture.env();
    const createProcess = env.createProcess;
    env.createProcess = options => {
        const process = createProcess(options);
        const start = process.start;
        process.start = () => {
            spawns.push(GLib.get_monotonic_time());
            start();
        };
        return process;
    };
    const manager = new PlayerManagerLifecycle({env, logger: quiet, fadeMs: 0});
    await manager.start();
    assertEqual(fixture.log.indexOf('fade') < fixture.log.lastIndexOf('probe'), true, 'second after first fade');
    assertEqual((spawns[1] - spawns[0]) / 1000 >= 39, true, 'staggered spawn');
    assertEqual(fixture.log.some(entry => entry.startsWith('apply:')), false, 'no single-monitor apply');
    assertEqual(manager.getState('A'), PlayerState.PLAYING);
    assertEqual(manager.getState('B'), PlayerState.PLAYING);
    manager.stop();
    await drainReaps(fixture);
});

test('disable during the stagger cancels promptly without a second spawn', async () => {
    const fixture = new Fixture();
    fixture.keys = ['A', 'B'];
    fixture.staggerMs = 5000;
    const manager = fixture.manager();
    const starting = manager.start();
    for (let i = 0; i < 50 && !fixture.log.includes('fade'); i++)
        await sleep(1);
    manager.stop();
    const begin = GLib.get_monotonic_time();
    await starting;
    assertEqual((GLib.get_monotonic_time() - begin) / 1000 < 100, true, 'prompt');
    assertEqual(fixture.processes.length, 1, 'one spawn only');
    await drainReaps(fixture);
});

test('stale gate completion cannot spawn after re-enable', async () => {
    const old = new Fixture({held: new Set(['gate'])});
    const first = old.manager();
    const starting = first.start();
    await old.reached('gate');
    first.stop();
    const fresh = new Fixture({held: new Set(['gate'])});
    const second = fresh.manager();
    const restarting = second.start();
    await fresh.reached('gate');
    old.gates.get('gate').resolve();
    await starting;
    assertDeepEqual(old.log, ['gate'], 'old lifecycle did nothing');
    fresh.release('gate');
    await restarting;
    assertEqual(fresh.processes.length, 1, 'only the new lifecycle spawns');
    second.stop();
    await drainReaps(fresh);
});

function supervised(fixture, env = fixture.env()) {
    return new PlayerManagerLifecycle({env, logger: quiet, fadeMs: 0, backoffMs: [10, 30, 60],
        healthyMs: 40});
}

async function until(predicate, ms = 500) {
    for (let i = 0; i < ms && !predicate(); i++)
        await sleep(1);
    if (!predicate())
        throw new Error('condition not reached');
}

async function crash(fixture, index) {
    const process = fixture.processes[index];
    process.exit({status: 137, signaled: true});
    process.reap();
    await sleep(1);
}

test('crashes retry with backoff, then stop on the still with one notification', async () => {
    const fixture = new Fixture();
    const manager = supervised(fixture);
    await manager.start();
    const spawned = [GLib.get_monotonic_time()];
    for (const index of [0, 1]) {
        await crash(fixture, index);
        assertEqual(manager.getState(KEY), PlayerState.FAILED, `failed after crash ${index}`);
        await until(() => manager.getState(KEY) === PlayerState.PLAYING);
        spawned.push(GLib.get_monotonic_time());
    }
    assertEqual((spawned[1] - spawned[0]) / 1000 >= 10, true, 'first backoff');
    assertEqual((spawned[2] - spawned[1]) / 1000 >= 30, true, 'second backoff');
    await crash(fixture, 2);
    await sleep(120);
    assertEqual(fixture.processes.length, 3, 'no fourth spawn');
    assertEqual(fixture.notifications.length, 1, 'one notification');
    assertEqual(manager.getState(KEY), PlayerState.FAILED);
    assertEqual(fixture.layers.at(-1).destroyed, false, 'still kept');
    assertEqual(fixture.layers.slice(0, -1).every(layer => layer.destroyed), true, 'one layer per monitor');
    await manager.reconcile();
    assertEqual(fixture.processes.length, 3, 'blocked until the selection changes');
    fixture.selection = 'other';
    await manager.reconcile();
    assertEqual(fixture.processes.length, 4, 'settings change unblocks');
    manager.stop();
    await drainReaps(fixture);
});

test('missing or unreadable media fails without retries and notifies once', async () => {
    const fixture = new Fixture();
    const env = fixture.env();
    env.probe = () => Promise.reject(new Error('Video file not found'));
    env.classify = () => 'permanent';
    const manager = supervised(fixture, env);
    await manager.start();
    await sleep(50);
    assertDeepEqual(fixture.notifications, [`${KEY}: Video file not found`]);
    assertEqual(fixture.log.filter(entry => entry === 'resolve').length, 1, 'no retry');
    await manager.reconcile();
    assertEqual(fixture.notifications.length, 1, 'no repeated notification');
    manager.stop();
});

test('sixty seconds of healthy playback resets the failure count', async () => {
    const fixture = new Fixture();
    const manager = supervised(fixture);
    await manager.start();
    for (const index of [0, 1, 2]) {
        await crash(fixture, index);
        await until(() => manager.getState(KEY) === PlayerState.PLAYING);
        await sleep(60);
    }
    assertEqual(fixture.processes.length, 4, 'kept retrying');
    assertDeepEqual(fixture.notifications, []);
    manager.stop();
    await drainReaps(fixture);
});

test('disable during backoff or before the healthy reset leaves no stale retry or notification', async () => {
    const fixture = new Fixture();
    const manager = supervised(fixture);
    await manager.start();
    await crash(fixture, 0);
    manager.stop();
    await sleep(80);
    assertEqual(fixture.processes.length, 1, 'no retry after disable');
    const again = supervised(fixture);
    await again.start();
    again.stop();
    await sleep(80);
    assertEqual(fixture.processes.length, 2, 'no retry after healthy timer cancel');
    assertDeepEqual(fixture.notifications, []);
    await drainReaps(fixture);
});

test('start twice without stop is rejected; setPaused validates arguments', async () => {
    const fixture = new Fixture();
    const manager = fixture.manager();
    await manager.start();
    let rejected = false;
    await manager.start().catch(() => {
        rejected = true;
    });
    assertEqual(rejected, true);
    assertThrows(() => manager.setPaused('', 'battery', true));
    manager.stop();
    await drainReaps(fixture);
});

test('stop forwards the restore choice; repeated sleep/resume keeps one live player', async () => {
    const fixture = new Fixture();
    const manager = fixture.manager();
    await manager.start();
    for (let i = 0; i < 5; i++) {
        manager.stop();
        const resumed = manager.start();
        await sleep(5);
        assertEqual(fixture.processes.filter(process => process.started).length, i + 1,
            'no spawn before the previous reap');
        fixture.processes[i].reap();
        await resumed;
        assertEqual(fixture.processes.filter(process => !process.terminated).length, 1, 'one live player');
        assertEqual(manager.getState(KEY), PlayerState.PLAYING);
    }
    manager.stop({restore: true});
    assertDeepEqual(fixture.stops, [false, false, false, false, false, true]);
    await drainReaps(fixture);
});

test('resolved targets are published and live player windows are recognised until reaped', async () => {
    const fixture = new Fixture();
    const manager = fixture.manager();
    const seen = [];
    const unsubscribe = manager.onTargets(targets => seen.push(targets.map(target => target.logicalMonitorKey)));
    await manager.start();
    assertDeepEqual(seen, [[KEY]]);
    assertEqual(manager.targets[0].monitorIndex, 0);
    assertEqual(manager.ownsWindow('window:0'), true, 'live window');
    assertEqual(manager.ownsWindow('window:1'), false, 'foreign window');
    manager.stop();
    assertDeepEqual(manager.targets, [], 'targets cleared on stop');
    assertEqual(manager.ownsWindow('window:0'), true, 'still owned while reaping');
    await drainReaps(fixture);
    assertEqual(manager.ownsWindow('window:0'), false, 'released after reap');
    unsubscribe();
    await manager.start();
    assertEqual(seen.length, 1, 'unsubscribed');
    manager.stop();
    await drainReaps(fixture);
});

await run();
