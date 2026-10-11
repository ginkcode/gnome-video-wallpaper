import GLib from 'gi://GLib';

import {spawnAsync} from './async.js';

export function findProgram(name) {
    return GLib.find_program_in_path(name);
}

export async function checkDependencies(cancellable = null) {
    const mpv = findProgram('mpv');
    let vaapi = false;
    if (mpv) {
        try {
            const {status, stdout} = await spawnAsync([mpv, '--no-config', '--hwdec=help'],
                {cancellable, stderr: false});
            vaapi = status === 0 && /\bvaapi\b/.test(stdout);
        } catch (error) {
            if (cancellable?.is_cancelled())
                throw error;
        }
    }
    return {
        mpv: Boolean(mpv),
        ffmpeg: Boolean(findProgram('ffmpeg')),
        ffprobe: Boolean(findProgram('ffprobe')),
        vaapi,
    };
}
