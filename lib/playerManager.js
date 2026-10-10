// M1 proof of concept: primary logical monitor only, playing the configured
// file directly. Private asset acquisition and published stills arrive with
// T12-T14; until then GINK_VW_TEST_FILE/GINK_VW_TEST_STILL stage a fixture.
import GLib from 'gi://GLib';

import {BackgroundLayer} from './backgroundLayer.js';
import {readMonitorConfigs} from './config.js';
import {TRANSFORM_VERSION} from './geometry.js';
import {createLogger} from './log.js';
import {getMonitors} from './monitorIdentity.js';
import {monitorIndexForConnector} from './monitors.js';
import {buildMpvArgv} from './mpvArgs.js';
import {MpvIpc} from './mpvIpc.js';
import {PlayerProcess, preparePlayerSocket, releasePlayerSocket} from './playerProcess.js';
import {PlayerManagerLifecycle} from './playerManagerLifecycle.js';

const VIDEO_OUTPUTS = {
    'auto': 'dmabuf-wayland,wlshm',
    'gpu-next': 'gpu-next',
    'dmabuf-wayland': 'dmabuf-wayland',
};

function testSelection() {
    const file = GLib.getenv('GINK_VW_TEST_FILE');
    if (!file || !GLib.path_is_absolute(file))
        return null;
    const still = GLib.getenv('GINK_VW_TEST_STILL');
    return {config: {file, fitMode: null, optimize: null},
        stillPath: still && GLib.path_is_absolute(still) ? still : null};
}

async function resolveTarget(settings, cancellable) {
    const {physicalMonitors, logicalMonitors} = await getMonitors(cancellable);
    const logical = logicalMonitors.find(monitor => monitor.primary) ?? logicalMonitors[0];
    if (!logical)
        return null;
    const configs = readMonitorConfigs(settings);
    const members = logical.connectors.map(connector =>
        physicalMonitors.find(physical => physical.connector === connector)).filter(Boolean);
    let selected = members.find(physical => configs[physical.id]);
    let selection = selected ? {config: configs[selected.id], stillPath: null} : null;
    if (!selection && Object.keys(configs).length === 0) {
        selection = testSelection();
        selected = members[0];
    }
    if (!selection || !selected)
        return null;
    const monitorIndex = monitorIndexForConnector(logical.connectors[0]);
    if (monitorIndex < 0)
        throw new Error(`logical monitor ${logical.key} has no layout index`);
    const fitMode = selection.config.fitMode ?? settings.get_string('default-fit-mode');
    const geometry = {width: logical.width, height: logical.height, scale: logical.scale,
        fitMode, transformVersion: TRANSFORM_VERSION};
    return {
        logicalMonitorKey: logical.key,
        selectedPhysicalMonitorId: selected.id,
        monitorIndex,
        stillPath: selection.stillPath,
        asset: {path: selection.config.file, identity: `${selection.config.file}#${fitMode}`,
            geometryBaked: false, source: null, geometry},
    };
}

export class PlayerManager extends PlayerManagerLifecycle {
    constructor({settings, logger = createLogger('player-manager')}) {
        const vo = () => VIDEO_OUTPUTS[settings.get_string('video-output')] ?? VIDEO_OUTPUTS.auto;
        super({logger, env: {
            resolveTarget: ({cancellable}) => resolveTarget(settings, cancellable),
            createLayer: target => new BackgroundLayer({monitorIndex: target.monitorIndex,
                logger: createLogger('background')}),
            prepareSocket: options => preparePlayerSocket(options),
            releaseSocket: socketPath => releasePlayerSocket(socketPath),
            createProcess: ({socketPath}) => new PlayerProcess({socketPath, logger: createLogger('mpv'),
                argv: buildMpvArgv({mpvPath: 'mpv', socketPath, vo: vo()})}),
            createIpc: socketPath => new MpvIpc(socketPath, createLogger('mpv-ipc')),
        }});
    }
}
