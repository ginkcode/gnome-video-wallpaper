import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {sleep} from '../lib/async.js';
import {PlayerManagerLifecycle, PlayerState, fitCommands, outstandingReapCount}
    from '../lib/playerManagerLifecycle.js';
import {assertDeepEqual, assertEqual, assertThrows, run, test} from './harness.js';

const quiet = {debug() {}, info() {}, warn() {}, error() {}};
const KEY = 'Virtual-1';
const BOUNDARIES = ['resolve', 'static', 'socket', 'connect', 'load', 'content', 'frame', 'fade'];

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
            resolveTarget: ({cancellable}) => this.gate('resolve', cancellable, {
                logicalMonitorKey: KEY, selectedPhysicalMonitorId: 'Virtual-1:a:b:', monitorIndex: 0,
                stillPath: '/still.png',
                asset: {path: '/video.mp4', identity: 'video#fill', geometryBaked: false,
                    geometry: {fitMode: 'fill'}},
            }),
            createLayer: () => {
                const fixture = this;
                const layer = {
                    destroyed: false,
                    prepareStatic: (_path, {cancellable}) => fixture.gate('static', cancellable),
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
                let reap;
                const process = {
                    started: false, terminated: false, exit: null,
                    reaped: new Promise(resolve => {
                        reap = resolve;
                    }),
                    reap: () => reap(),
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
                    stop: () => process.reaped,
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
    assertDeepEqual(fixture.log, ['resolve', 'static', 'socket', 'watch:false', 'window', 'spawn', 'connect',
        'cmd:keepaspect=true', 'cmd:panscan=1', 'load', 'content', 'attach:window', 'frame', 'fade']);
    assertDeepEqual(fixture.pauses, [false]);
    assertEqual(manager.getState(KEY), PlayerState.PLAYING);
    const player = manager.getPlayer(KEY);
    assertEqual(player.selectedPhysicalMonitorId, 'Virtual-1:a:b:');
    assertEqual(player.asset.identity, 'video#fill');
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
        assertDeepEqual(fixture.log.slice(before), [], 'no work after stop');
        assertEqual(fixture.log.includes('spawn'), spawned, 'no stale spawn');
        assertEqual(manager.getState(KEY), PlayerState.STOPPED);
        assertDeepEqual(fixture.pauses, []);
        await drainReaps(fixture);
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
    assertDeepEqual(fresh.log, [], 'nothing before old reap');
    old.processes[0].reap();
    await starting;
    assertEqual(fresh.log.includes('spawn'), true);
    assertEqual(second.getState(KEY), PlayerState.PLAYING);
    second.stop();
    await drainReaps(fresh);
});

test('unexpected exit during readiness fails and releases the player', async () => {
    const fixture = new Fixture({held: new Set(['frame'])});
    const manager = fixture.manager();
    const starting = manager.start();
    await fixture.reached('frame');
    fixture.processes[0].exit({status: 137, signaled: true});
    assertEqual(manager.getState(KEY), PlayerState.FAILED);
    assertEqual(fixture.layers[0].destroyed, true);
    fixture.gates.get('frame').reject(new Error('layer destroyed'));
    await starting;
    assertEqual(manager.getState(KEY), PlayerState.FAILED);
    manager.stop();
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

await run();
