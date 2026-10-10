import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {sleep, spawnAsync} from '../lib/async.js';
import {MpvIpc} from '../lib/mpvIpc.js';
import {test, assertEqual, run} from './harness.js';

const mpv = GLib.find_program_in_path('mpv');
const ffmpeg = GLib.find_program_in_path('ffmpeg');
const directory = GLib.dir_make_tmp('gink-vw-mpv-XXXXXX');
const socketPath = `${directory}/ipc.sock`;
const mediaPath = `${directory}/paused.mp4`;
const readinessCount = 4;

function deadline(ms) {
    const end = Date.now() + ms;
    return () => Date.now() >= end;
}

async function until(condition, expired) {
    while (!condition()) {
        if (expired())
            throw new Error('timed out waiting for condition');
        await sleep(20);
    }
}

function startMpv(argv) {
    return Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
}

async function makeMedia() {
    const result = await spawnAsync([ffmpeg, '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10',
        '-t', '1', '-pix_fmt', 'yuv420p', mediaPath], {stderr: false});
    assertEqual(result.status, 0, 'ffmpeg status');
}

if (!mpv || !ffmpeg) {
    console.log('mpv or ffmpeg missing; skipping IPC tests');
    GLib.rmdir(directory);
} else {
    const process = startMpv([mpv, '--idle=yes', '--pause=yes', '--force-window=no', '--keep-open=yes',
        '--vo=null', '--ao=null', `--input-ipc-server=${socketPath}`]);
    const ipc = new MpvIpc(socketPath);

    test('connect times out and closes without a pending attempt', async () => {
        const missing = new MpvIpc(`${directory}/missing.sock`);
        let rejected = false;
        try {
            await missing.connect({timeoutMs: 150});
        } catch {
            rejected = true;
        }
        assertEqual(rejected, true);
        await missing.close();
        assertEqual(await missing.close(), undefined);
    });

    test('connect cancellation settles before the retry interval', async () => {
        const missing = new MpvIpc(`${directory}/cancelled.sock`);
        const cancellable = new Gio.Cancellable();
        const started = Date.now();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
        let rejected = false;
        try {
            await missing.connect({timeoutMs: 5000, cancellable});
        } catch {
            rejected = true;
        }
        assertEqual(rejected, true);
        assertEqual(Date.now() - started < 500, true, 'connect cancellation latency');
        await missing.close();
    });

    test('close races a connect attempt and prevents late adoption', async () => {
        const connecting = new MpvIpc(`${directory}/race.sock`);
        const attempt = connecting.connect({timeoutMs: 5000}).then(() => false, () => true);
        await connecting.close();
        assertEqual(await attempt, true);
        assertEqual(connecting._connection, null);
        assertEqual(connecting._connecting, null);
    });

    test('commands, events, observations and unsubscribe work', async () => {
        await ipc.connect({timeoutMs: 3000});
        const version = await ipc.command(['get_property', 'mpv-version']);
        assertEqual(typeof version, 'string');
        await ipc.setPause(true);
        assertEqual(await ipc.command(['get_property', 'pause']), true);

        let observed = null;
        const unsubscribe = ipc.observe('pause', value => {
            observed = value;
        });
        await until(() => observed !== null, deadline(2000));
        assertEqual(observed, true);
        let event = null;
        const unsubscribeEvent = ipc.onEvent('property-change', value => {
            event = value.name;
        });
        await ipc.setPause(false);
        await until(() => observed === false, deadline(2000));
        assertEqual(event, 'pause');
        unsubscribe();
        unsubscribeEvent();
        assertEqual(ipc._observations.size, readinessCount);
        assertEqual(ipc._events.size, 0);
    });

    test('command errors and cancellation reject', async () => {
        let rejected = false;
        try {
            await ipc.command(['get_property', 'not-a-property']);
        } catch {
            rejected = true;
        }
        assertEqual(rejected, true);
        const cancellable = new Gio.Cancellable();
        const pending = ipc.command(['get_property', 'mpv-version'], {cancellable});
        cancellable.cancel();
        let cancelled = false;
        try {
            await pending;
        } catch {
            cancelled = true;
        }
        assertEqual(cancelled, true);
        assertEqual(ipc._pending.size, 0);
    });

    test('concurrent commands resolve independently', async () => {
        const values = await Promise.all([
            ipc.command(['get_property', 'mpv-version']),
            ipc.command(['get_property', 'pause']),
        ]);
        assertEqual(typeof values[0], 'string');
        assertEqual(values[1], false);
    });

    test('paused load readiness ignores stale media and preserves pause', async () => {
        await ipc.setPause(true);
        await makeMedia();
        const oldPath = `${directory}/old.mp4`;
        const copied = Gio.File.new_for_path(mediaPath).copy(Gio.File.new_for_path(oldPath),
            Gio.FileCopyFlags.NONE, null, null);
        assertEqual(copied, true);
        await ipc.command(['loadfile', oldPath], {assetIdentity: 'old-asset'});
        await ipc.waitForContent({assetIdentity: 'old-asset', timeoutMs: 3000});

        const started = ipc.waitForContent({assetIdentity: 'new-asset', timeoutMs: 3000});
        await ipc.command(['loadfile', mediaPath], {assetIdentity: 'new-asset'});
        await started;
        assertEqual(await ipc.command(['get_property', 'pause']), true);
        let unsupported = false;
        try {
            await ipc.command(['loadfile', mediaPath, 'append'], {assetIdentity: 'ignored'});
        } catch {
            unsupported = true;
        }
        assertEqual(unsupported, true);

        await ipc.command(['loadfile', mediaPath], {assetIdentity: 'repeat-a'});
        await ipc.waitForContent({assetIdentity: 'repeat-a', timeoutMs: 3000});
        const stale = ipc.waitForContent({assetIdentity: 'repeat-a', timeoutMs: 3000})
            .then(() => false, () => true);
        const replacement = ipc.command(['loadfile', mediaPath], {assetIdentity: 'repeat-b'});
        assertEqual(await stale, true);
        await replacement;
        await ipc.waitForContent({assetIdentity: 'repeat-b', timeoutMs: 3000});
    });

    test('killing mpv closes the client and rejects pending waits', async () => {
        const killedSocket = `${directory}/killed.sock`;
        const killed = startMpv([mpv, '--idle=yes', '--pause=yes', '--force-window=no',
            '--vo=null', '--ao=null', `--input-ipc-server=${killedSocket}`]);
        const client = new MpvIpc(killedSocket);
        try {
            await client.connect({timeoutMs: 3000});
            const pending = client.command(['get_property', 'mpv-version']).then(() => false, () => true);
            const waiting = client.waitForContent({assetIdentity: 'never', timeoutMs: 5000})
                .then(() => false, () => true);
            killed.force_exit();
            await killed.wait_async(null);
            await until(() => client._closed, deadline(2000));
            await pending;
            assertEqual(await waiting, true);
            await client.close();
            assertEqual(client._pending.size, 0);
            assertEqual(client._waits.size, 0);
        } finally {
            killed.force_exit();
            await killed.wait_async(null);
            await client.close();
            GLib.unlink(killedSocket);
        }
    });

    test('content timeout, cancellation and close settle waits', async () => {
        let timedOut = false;
        try {
            await ipc.waitForContent({assetIdentity: 'absent', timeoutMs: 100});
        } catch {
            timedOut = true;
        }
        assertEqual(timedOut, true);
        const cancellable = new Gio.Cancellable();
        const waiting = ipc.waitForContent({assetIdentity: 'absent', timeoutMs: 5000, cancellable});
        cancellable.cancel();
        let cancelled = false;
        try {
            await waiting;
        } catch {
            cancelled = true;
        }
        assertEqual(cancelled, true);
        const closing = ipc.waitForContent({assetIdentity: 'absent', timeoutMs: 5000});
        const pending = ipc.command(['get_property', 'mpv-version']).then(() => false, () => true);
        const closed = ipc.close();
        assertEqual(await pending, true);
        let rejected = false;
        try {
            await closing;
        } catch {
            rejected = true;
        }
        assertEqual(rejected, true);
        await closed;
        assertEqual(ipc._pending.size, 0);
        assertEqual(ipc._waits.size, 0);
    });

    await run().finally(async () => {
        await ipc.close();
        process.force_exit();
        await process.wait_async(null);
        for (const name of ['paused.mp4', 'old.mp4', 'ipc.sock'])
            GLib.unlink(`${directory}/${name}`);
        GLib.rmdir(directory);
    });
}
