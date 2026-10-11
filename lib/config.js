const FIT_MODES = new Set(['fill', 'fit', 'stretch']);

function warn(message) {
    console.warn(`[gink-vw] [config] ${message}`);
}

function normalizeConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const files = value.files ?? (value.file === undefined ? undefined : [value.file]);
    if (!Array.isArray(files) || files.length === 0 ||
        !files.every(file => typeof file === 'string' && file.startsWith('/')))
        return null;
    const unique = [...new Set(files)];
    if (value.fitMode !== null && !FIT_MODES.has(value.fitMode))
        return null;
    if (value.optimize !== null && typeof value.optimize !== 'boolean')
        return null;
    return {
        file: unique[0],
        files: unique,
        fitMode: value.fitMode,
        optimize: value.optimize,
    };
}

export function readMonitorConfigs(settings) {
    const raw = settings.get_string('monitor-configs');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        warn(`invalid monitor-configs JSON: ${error.message}`);
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        warn('monitor-configs is not an object; treating as empty');
        return {};
    }

    const configs = {};
    for (const [id, value] of Object.entries(parsed)) {
        const config = normalizeConfig(value);
        if (config)
            Object.defineProperty(configs, id, {
                value: config, enumerable: true, writable: true, configurable: true,
            });
        else
            warn(`dropping invalid monitor config for ${id}`);
    }
    return configs;
}

export function writeMonitorConfig(settings, id, cfg) {
    if (typeof id !== 'string' || !id)
        throw new Error('monitor id is required');
    const config = normalizeConfig(cfg);
    if (!config)
        throw new Error('invalid monitor config');
    const configs = readMonitorConfigs(settings);
    Object.defineProperty(configs, id, {
        value: config, enumerable: true, writable: true, configurable: true,
    });
    settings.set_string('monitor-configs', JSON.stringify(configs));
}

export function removeMonitorConfig(settings, id) {
    const configs = readMonitorConfigs(settings);
    delete configs[id];
    settings.set_string('monitor-configs', JSON.stringify(configs));
}

export function selectConfigured(connectors, physicalMonitors, configs) {
    for (const connector of [...connectors].sort()) {
        const physical = physicalMonitors.find(monitor => monitor.connector === connector);
        if (physical && Object.hasOwn(configs, physical.id))
            return {physical, config: configs[physical.id]};
    }
    return null;
}
