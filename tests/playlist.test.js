import {sleep} from '../lib/async.js';
import {Playlist, nextIndex} from '../lib/playlist.js';
import {assertDeepEqual, assertEqual, assertThrows, run, test} from './harness.js';

const quiet = {debug() {}, info() {}, warn() {}, error() {}};
const FILES = ['/a.mp4', '/b.mp4', '/c.gif'];

class FakeSettings {
    constructor(values = {}) {
        this.values = {'playlist-interval-minutes': 30, 'playlist-order': 'sequential', 'playlist-state': '{}',
            'paused': false, ...values};
        this.handlers = new Map();
        this.nextId = 1;
    }

    connect(signal, callback) {
        const id = this.nextId++;
        this.handlers.set(id, {signal, callback});
        return id;
    }

    disconnect(id) {
        if (!this.handlers.delete(id))
            throw new Error(`unknown handler ${id}`);
    }

    get_string(key) {
        return this.values[key];
    }

    get_uint(key) {
        return this.values[key];
    }

    get_boolean(key) {
        return this.values[key];
    }

    set_string(key, value) {
        this.values[key] = value;
    }

    set(key, value) {
        this.values[key] = value;
        for (const handler of [...this.handlers.values()]) {
            if (handler.signal === `changed::${key}`)
                handler.callback(this, key);
        }
    }
}

function setup(values = {}, options = {}) {
    const settings = new FakeSettings(values);
    const changes = [];
    const playlist = new Playlist({settings, onChange: () => changes.push(true), logger: quiet, ...options});
    return {settings, changes, playlist};
}

test('nextIndex cycles in order and never repeats a random pick', () => {
    assertDeepEqual([0, 1, 2].map(index => nextIndex(index, 3, 'sequential')), [1, 2, 0]);
    assertEqual(nextIndex(0, 1, 'random'), 0, 'single entry');
    for (const value of [0, 0.4, 0.99]) {
        for (let index = 0; index < 3; index++) {
            const next = nextIndex(index, 3, 'random', () => value);
            assertEqual(next !== index && next >= 0 && next < 3, true, `random from ${index} with ${value}`);
        }
    }
});

test('sequential playlists start at the first file and advance in order, persisting positions', () => {
    const {settings, changes, playlist} = setup();
    assertEqual(playlist.fileFor('M', FILES), '/a.mp4');
    assertEqual(playlist.fileFor('S', ['/single.mp4']), '/single.mp4');
    assertEqual(playlist.advance(), true);
    assertEqual(playlist.fileFor('M', FILES), '/b.mp4');
    assertEqual(playlist.fileFor('S', ['/single.mp4']), '/single.mp4', 'single files never rotate');
    assertDeepEqual(JSON.parse(settings.values['playlist-state']), {M: '/b.mp4'});
    playlist.advance();
    playlist.advance();
    assertEqual(playlist.fileFor('M', FILES), '/a.mp4', 'wraps around');
    assertEqual(changes.length, 3);
});

test('a saved position is resumed and kept when the list is edited', () => {
    const {playlist} = setup({'playlist-state': JSON.stringify({M: '/c.gif'})});
    assertEqual(playlist.fileFor('M', FILES), '/c.gif', 'resumed');
    assertEqual(playlist.fileFor('M', ['/new.mp4', ...FILES]), '/c.gif', 'kept after an insertion');
    assertEqual(playlist.fileFor('M', ['/a.mp4', '/b.mp4']), '/a.mp4', 'restarts when the current file is removed');
});

test('every pick is stored so preferences show the playing file', () => {
    const {settings, playlist} = setup({'playlist-order': 'random',
        'playlist-state': JSON.stringify({M: '/stale.mp4', N: '/kept.mp4'})}, {random: () => 0.7});
    assertEqual(playlist.fileFor('M', FILES), '/c.gif');
    assertDeepEqual(JSON.parse(settings.values['playlist-state']), {M: '/c.gif', N: '/kept.mp4'}, 'random start');
    playlist.fileFor('M', ['/a.mp4', '/b.mp4']);
    assertDeepEqual(JSON.parse(settings.values['playlist-state']).M, '/b.mp4', 'random restart after removal');
});

test('random order picks a random start and a different next file', () => {
    const {playlist} = setup({'playlist-order': 'random'}, {random: () => 0.7});
    assertEqual(playlist.fileFor('M', FILES), '/c.gif');
    playlist.advance();
    assertEqual(playlist.fileFor('M', FILES), '/b.mp4');
});

test('advance with no playlist does nothing', () => {
    const {changes, playlist} = setup();
    playlist.fileFor('S', ['/single.mp4']);
    assertEqual(playlist.advance(), false);
    assertEqual(changes.length, 0);
});

test('the timer advances, skips while paused, follows the interval and stops on disable', async () => {
    const {settings, changes, playlist} = setup({'playlist-interval-minutes': 2}, {minuteMs: 10});
    playlist.fileFor('M', FILES);
    playlist.enable();
    assertThrows(() => playlist.enable(), 'double enable');
    await sleep(30);
    assertEqual(changes.length, 1, 'one tick after 20 ms');
    settings.set('paused', true);
    await sleep(30);
    assertEqual(changes.length, 1, 'paused');
    settings.set('paused', false);
    settings.set('playlist-interval-minutes', 5);
    await sleep(30);
    assertEqual(changes.length, 1, 'rescheduled with the longer interval');
    playlist.disable();
    await sleep(60);
    assertEqual(changes.length, 1, 'stopped');
    assertEqual(settings.handlers.size, 0);
});

await run();
