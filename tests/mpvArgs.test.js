import Gio from 'gi://Gio';

import {test, assertEqual, assertDeepEqual, run} from './harness.js';
import {buildMpvArgv, withParentDeathSignal} from '../lib/mpvArgs.js';

function exitStatus(argv) {
    const subprocess = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
    return new Promise((resolve, reject) => subprocess.wait_async(null, (_s, result) => {
        try {
            subprocess.wait_finish(result);
            resolve(subprocess.get_exit_status());
        } catch (error) {
            reject(error);
        }
    }));
}

test('buildMpvArgv builds base arguments with priority prefix', () => {
    const argv = buildMpvArgv({
        mpvPath: '/usr/bin/mpv',
        socketPath: '/tmp/mpv.sock',
        vo: 'gpu',
        hwdec: 'vaapi',
        appId: 'gink-video-wallpaper',
        lowPriority: true,
    });
    const expected = [
        'nice', '-n', '10', 'ionice', '-c3',
        '/usr/bin/mpv',
        '--no-config',
        '--no-audio',
        '--loop-file=inf',
        '--hwdec=vaapi',
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
        '--wayland-app-id=gink-video-wallpaper',
        '--title=gink-video-wallpaper',
        '--input-ipc-server=/tmp/mpv.sock',
        '--vo=gpu',
        '--video-sync=display-resample',
        '--wayland-content-type=video',
        '--msg-level=all=warn',
        '--clipboard-backends=vo',
        '--stop-screensaver=no',
    ];
    assertDeepEqual(argv, expected);
});

test('buildMpvArgv respects lowPriority=false and overrides', () => {
    const argv = buildMpvArgv({
        mpvPath: 'mpv',
        socketPath: '/run/user/1000/gink-vw.sock',
        vo: 'dmabuf-wayland',
        hwdec: 'nvdec',
        appId: 'custom-app-id',
        lowPriority: false,
    });
    assertEqual(argv[0], 'mpv');
    assertEqual(argv.includes('--hwdec=nvdec'), true);
    assertEqual(argv.includes('--vo=dmabuf-wayland'), true);
    assertEqual(argv.includes('--wayland-app-id=custom-app-id'), true);
    assertEqual(argv.includes('--input-ipc-server=/run/user/1000/gink-vw.sock'), true);
    assertEqual(argv.includes('nice'), false);
    assertEqual(argv.includes('ionice'), false);
});

test('buildMpvArgv contains no media file or fit options', () => {
    const argv = buildMpvArgv({
        mpvPath: 'mpv',
        socketPath: '/tmp/test.sock',
        vo: 'null',
    });
    for (const arg of argv) {
        assertEqual(arg.includes('panscan'), false);
        assertEqual(arg.includes('video-unscaled'), false);
        assertEqual(arg.endsWith('.mp4') || arg.endsWith('.mkv'), false);
    }
});

test('default hwdec and app ID keep substitution in individual argv entries', () => {
    const argv = buildMpvArgv({
        mpvPath: '/path with spaces/mpv',
        socketPath: '/private path/ipc.sock',
        vo: 'gpu-next',
        lowPriority: false,
    });
    assertEqual(argv[0], '/path with spaces/mpv');
    assertEqual(argv.includes('--input-ipc-server=/private path/ipc.sock'), true);
    assertEqual(argv.includes('--hwdec=vaapi'), true);
    assertEqual(argv.includes('--wayland-app-id=gink-video-wallpaper'), true);
    assertEqual(argv.includes('--vo=gpu-next'), true);
    assertDeepEqual(argv.filter(arg => !arg.startsWith('--')), ['/path with spaces/mpv']);
});

test('withParentDeathSignal arms KILL before the parent check and preserves argv', () => {
    const argv = withParentDeathSignal(['nice', '/path with spaces/mpv', '--x=$HOME'], 42);
    assertDeepEqual(argv.slice(0, 5), ['setpriv', '--pdeathsig', 'KILL', '--', '/bin/sh']);
    assertDeepEqual(argv.slice(-4), ['42', 'nice', '/path with spaces/mpv', '--x=$HOME']);
});

test('parent check executes the command only under the expected parent', async () => {
    const self = new Gio.Credentials().get_unix_pid();
    assertEqual(await exitStatus(withParentDeathSignal(['/bin/sh', '-c', 'exit 7'], self)), 7,
        'expected parent');
    assertEqual(await exitStatus(withParentDeathSignal(['/bin/sh', '-c', 'exit 7'], 1)), 1,
        'reparented');
});

await run();
