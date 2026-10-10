import Gio from 'gi://Gio';

import {monitorId, parseDisplayConfigState} from '../lib/monitorIdentity.js';
import {test, assertDeepEqual, assertEqual, run} from './harness.js';

function loadFixture(name) {
    const file = Gio.File.new_for_path(`tests/fixtures/${name}`);
    const [, bytes] = file.load_contents(null);
    return JSON.parse(new TextDecoder().decode(bytes));
}

test('monitor id includes connector and empty serial', () => {
    assertEqual(monitorId({connector: 'eDP-1', vendor: 'LEN', product: 'Panel', serial: ''}), 'eDP-1:LEN:Panel:');
});

test('device fixture separates physical mode from logical size', () => {
    const parsed = parseDisplayConfigState(loadFixture('display-state-edp1.json'));
    assertDeepEqual(parsed.physicalMonitors[0], {
        id: 'eDP-1:LEN:0x8aaf:0x00000000',
        connector: 'eDP-1',
        vendor: 'LEN',
        product: '0x8aaf',
        serial: '0x00000000',
        displayName: 'Built-in display',
        modeWidth: 3072,
        modeHeight: 1920,
    });
    assertDeepEqual(parsed.logicalMonitors[0], {
        key: 'eDP-1',
        connectors: ['eDP-1'],
        x: 0,
        y: 0,
        width: 2048,
        height: 1280,
        scale: 1.5,
        transform: 0,
        primary: true,
    });
});

test('mixed scale and rotation use logical dimensions', () => {
    const parsed = parseDisplayConfigState(loadFixture('display-state-mixed.json'));
    assertEqual(parsed.physicalMonitors[0].id, 'HDMI-1:DEL:U2723:SN2');
    assertEqual(parsed.physicalMonitors[1].id, 'eDP-1:LEN:Panel:SN1');
    const external = parsed.logicalMonitors.find(monitor => monitor.key === 'HDMI-1');
    assertEqual(external.width, Math.round(1440 / 1.5));
    assertEqual(external.height, Math.round(2560 / 1.5));
    assertEqual(external.transform, 1);
});

test('mirrored connectors share one sorted logical key', () => {
    const parsed = parseDisplayConfigState(loadFixture('display-state-mirrored.json'));
    assertEqual(parsed.logicalMonitors.length, 1);
    assertDeepEqual(parsed.logicalMonitors[0].connectors, ['HDMI-1', 'HDMI-2']);
    assertEqual(parsed.logicalMonitors[0].key, 'HDMI-1|HDMI-2');
});

await run();
