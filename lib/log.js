const LEVELS = {
    debug: console.debug,
    info: console.log,
    warn: console.warn,
    error: console.error,
};

let debugEnabled = false;

export function setDebugEnabled(enabled) {
    debugEnabled = Boolean(enabled);
}

export function createLogger(scope) {
    const write = (level, args) => {
        if (level === 'debug' && !debugEnabled)
            return;
        LEVELS[level](`[gink-vw] [${scope}]`, ...args);
    };
    return {
        debug: (...args) => write('debug', args),
        info: (...args) => write('info', args),
        warn: (...args) => write('warn', args),
        error: (...args) => write('error', args),
    };
}
