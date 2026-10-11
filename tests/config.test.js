import {readMonitorConfigs, removeMonitorConfig, selectConfigured, writeMonitorConfig} from '../lib/config.js';

let failures = 0;

function assertEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        failures++;
        console.error(`FAIL ${label}: expected ${b}, got ${a}`);
    }
}

class FakeSettings {
    constructor(initial = '{}') {
        this.value = initial;
    }

    get_string(_key) {
        return this.value;
    }

    set_string(_key, value) {
        this.value = value;
    }
}

function makeConfig(overrides = {}) {
    return {file: '/tmp/a.mp4', fitMode: null, optimize: null, ...overrides};
}

let s = new FakeSettings();
assertEqual(readMonitorConfigs(s), {}, 'empty reads as {}');

writeMonitorConfig(s, 'eDP-1', makeConfig({fitMode: 'fill'}));
assertEqual(readMonitorConfigs(s), {
    'eDP-1': {file: '/tmp/a.mp4', fitMode: 'fill', optimize: null},
}, 'write/read round-trip');

writeMonitorConfig(s, 'eDP-1', makeConfig({optimize: true}));
assertEqual(readMonitorConfigs(s)['eDP-1'].optimize, true, 'merge preserves file');

writeMonitorConfig(s, 'HDMI-1', makeConfig({file: '/tmp/b.mkv'}));
assertEqual(Object.keys(readMonitorConfigs(s)).length, 2, 'two monitors');

removeMonitorConfig(s, 'eDP-1');
assertEqual(Object.keys(readMonitorConfigs(s)), ['HDMI-1'], 'remove deletes one');

s = new FakeSettings('not json');
assertEqual(readMonitorConfigs(s), {}, 'invalid JSON treated as {}');

s = new FakeSettings('[1,2,3]');
assertEqual(readMonitorConfigs(s), {}, 'array treated as {}');

s = new FakeSettings('{"bad":{"file":"rel/path"},"ok":{"file":"/abs.mp4","fitMode":null,"optimize":null}}');
assertEqual(readMonitorConfigs(s), {
    ok: {file: '/abs.mp4', fitMode: null, optimize: null},
}, 'invalid entries dropped');

const mirrored = [{connector: 'HDMI-1', id: 'HDMI-1:x:y:1'}, {connector: 'DP-1', id: 'DP-1:x:y:2'}];
assertEqual(selectConfigured(['HDMI-1', 'DP-1'], mirrored, {'HDMI-1:x:y:1': makeConfig()})?.physical.connector,
    'HDMI-1', 'mirrored: only configured connector');
assertEqual(selectConfigured(['HDMI-1', 'DP-1'], mirrored, {
    'HDMI-1:x:y:1': makeConfig(), 'DP-1:x:y:2': makeConfig({file: '/tmp/dp.mp4'}),
})?.config.file, '/tmp/dp.mp4', 'mirrored: first configured connector in sorted order');
assertEqual(selectConfigured(['HDMI-1'], mirrored, {'DP-1:x:y:2': makeConfig()}), null, 'other monitor ignored');

if (failures > 0) {
    console.error(`${failures} assertion(s) failed`);
    throw new Error(`${failures} assertion(s) failed`);
} else {
    console.log('config tests passed');
}
