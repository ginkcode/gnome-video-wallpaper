import Gio from 'gi://Gio';

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

function valueOf(value) {
    return value?.deep_unpack ? value.deep_unpack() : value;
}

function prop(properties, name, fallback = null) {
    return valueOf(properties[name]) ?? fallback;
}

export function monitorId({connector, vendor, product, serial}) {
    return `${connector}:${vendor}:${product}:${serial ?? ''}`;
}

export function parseDisplayConfigState(stateVariantUnpacked) {
    const [, physical, logical, properties] = stateVariantUnpacked;
    const layoutMode = prop(properties, 'layout-mode', 1);
    const physicalMonitors = physical.map(([spec, modes, props]) => {
        const [connector, vendor, product, serial] = spec;
        const mode = modes.find(entry => prop(entry[6], 'is-current', false));
        return {
            id: monitorId({connector, vendor, product, serial}),
            connector,
            vendor,
            product,
            serial,
            displayName: prop(props, 'display-name', connector),
            modeWidth: mode?.[1] ?? 0,
            modeHeight: mode?.[2] ?? 0,
        };
    });
    const byConnector = new Map(physicalMonitors.map(monitor => [monitor.connector, monitor]));
    const logicalMonitors = logical.map(([x, y, scale, transform, primary, specs]) => {
        const connectors = specs.map(spec => spec[0]).sort();
        const monitor = byConnector.get(connectors[0]);
        if (!monitor || monitor.modeWidth === 0 || monitor.modeHeight === 0)
            throw new Error(`no current mode for logical monitor ${connectors.join(',')}`);
        const rotated = transform % 2 === 1;
        const physicalWidth = rotated ? monitor.modeHeight : monitor.modeWidth;
        const physicalHeight = rotated ? monitor.modeWidth : monitor.modeHeight;
        const divisor = layoutMode === 1 ? scale : 1;
        return {
            key: connectors.join('|'),
            connectors,
            x,
            y,
            width: Math.round(physicalWidth / divisor),
            height: Math.round(physicalHeight / divisor),
            scale,
            transform,
            primary,
        };
    });
    return {physicalMonitors, logicalMonitors};
}

export async function getMonitors(cancellable = null) {
    const result = await Gio.DBus.session.call(
        'org.gnome.Mutter.DisplayConfig',
        '/org/gnome/Mutter/DisplayConfig',
        'org.gnome.Mutter.DisplayConfig',
        'GetCurrentState',
        null,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        cancellable
    );
    return parseDisplayConfigState(result.deep_unpack());
}
