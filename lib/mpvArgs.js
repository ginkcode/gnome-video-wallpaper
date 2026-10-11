export function buildMpvArgv({
    mpvPath,
    socketPath,
    vo,
    hwdec = 'vaapi',
    appId = 'gink-video-wallpaper',
    lowPriority = true,
}) {
    const argv = [
        mpvPath,
        '--no-config',
        '--no-audio',
        '--loop-file=inf',
        `--hwdec=${hwdec}`,
        '--cache=no',
        '--demuxer-max-bytes=32MiB',
        '--osc=no',
        '--osd-level=0',
        '--input-default-bindings=no',
        '--input-vo-keyboard=no',
        '--no-input-cursor',
        '--cursor-autohide=always',
        '--no-border',
        '--title-bar=no',
        '--auto-window-resize=no',
        '--keepaspect-window=no',
        '--hidpi-window-scale=no',
        '--force-window=no',
        '--idle=yes',
        '--pause=yes',
        '--keep-open=no',
        '--background-color=#000000',
        `--wayland-app-id=${appId}`,
        '--title=gink-video-wallpaper',
        `--input-ipc-server=${socketPath}`,
        `--vo=${vo}`,
        '--video-sync=display-resample',
        '--wayland-content-type=video',
        '--msg-level=all=warn',
        '--clipboard-backends=vo',
    ];
    if (lowPriority)
        return ['nice', '-n', '10', 'ionice', '-c3', ...argv];
    return argv;
}

// Mutter sets no parent-death signal, and idle mpv holds no Wayland connection
// that would end with the Shell. Checking the parent after arming the signal
// closes the race where the Shell dies before setpriv runs.
const PARENT_CHECK = '[ "$PPID" = "$1" ] || exit 1; shift; exec "$@"';

export function withParentDeathSignal(argv, parentPid) {
    return ['setpriv', '--pdeathsig', 'KILL', '--', '/bin/sh', '-c', PARENT_CHECK,
        'sh', String(parentPid), ...argv];
}
