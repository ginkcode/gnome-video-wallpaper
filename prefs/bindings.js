function bindTwoWay(settings, key, target, property, toTarget, toSettings) {
    let pulling = false;
    const pull = () => {
        pulling = true;
        try {
            target[property] = toTarget();
        } finally {
            pulling = false;
        }
    };
    const settingsId = settings.connect(`changed::${key}`, pull);
    const targetId = target.connect(`notify::${property}`, () => {
        if (!pulling)
            toSettings(target[property]);
    });
    pull();
    return () => {
        settings.disconnect(settingsId);
        target.disconnect(targetId);
    };
}

export function bindScaled(settings, key, target, property, factor) {
    return bindTwoWay(settings, key, target, property, () => settings.get_uint(key) / factor, value => {
        const scaled = Math.round(value * factor);
        if (scaled !== settings.get_uint(key))
            settings.set_uint(key, scaled);
    });
}

export function bindChoice(settings, key, target, nicks) {
    return bindTwoWay(settings, key, target, 'selected', () => Math.max(0, nicks.indexOf(settings.get_string(key))),
        index => {
            const nick = nicks[index];
            if (nick && nick !== settings.get_string(key))
                settings.set_string(key, nick);
        });
}
