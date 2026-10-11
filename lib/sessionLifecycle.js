export function isLockedSession(sessionMode) {
    return Boolean(sessionMode?.isLocked) || sessionMode?.currentMode === 'unlock-dialog';
}

export function watchSleep(loginManager, {onSleep, onResume}) {
    let asleep = false;
    const id = loginManager.connect('prepare-for-sleep', (_emitter, aboutToSuspend) => {
        if (aboutToSuspend === asleep)
            return;
        asleep = aboutToSuspend;
        if (asleep)
            onSleep();
        else
            onResume();
    });
    return () => loginManager.disconnect(id);
}
