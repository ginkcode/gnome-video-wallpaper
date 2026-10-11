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

export function parseVersion(text) {
    const match = /^\S+\s+(?:version\s+)?v?(\S+)/.exec((text ?? '').trim());
    return match ? match[1] : null;
}

async function programVersion(path, cancellable) {
    const flag = /^ff(mpeg|probe)$/.test(GLib.path_get_basename(path)) ? '-version' : '--version';
    try {
        const {status, stdout} = await spawnAsync([path, flag], {cancellable, stderr: false});
        return status === 0 ? parseVersion(stdout) : null;
    } catch (error) {
        if (cancellable?.is_cancelled())
            throw error;
        return null;
    }
}

export async function describeDependencies(cancellable = null) {
    const names = ['mpv', 'ffmpeg', 'ffprobe'];
    const [deps, ...versions] = await Promise.all([checkDependencies(cancellable),
        ...names.map(name => {
            const path = findProgram(name);
            return path ? programVersion(path, cancellable) : null;
        })]);
    const result = {vaapi: {found: deps.vaapi, version: null}};
    names.forEach((name, index) => {
        result[name] = {found: deps[name], version: versions[index]};
    });
    return result;
}
