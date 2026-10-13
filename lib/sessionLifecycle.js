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
