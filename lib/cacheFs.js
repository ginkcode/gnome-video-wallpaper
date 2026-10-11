import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {findProgram} from './deps.js';

for (const method of ['delete_async', 'enumerate_children_async'])
    Gio._promisify(Gio.File.prototype, method);
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const APP = 'gink-video-wallpaper';
export const STAT = 'standard::type,standard::size,time::modified,time::modified-usec,unix::nlink,unix::device,unix::inode';

function xdgDir(variable, fallback) {
    const value = GLib.getenv(variable);
    return GLib.build_filenamev([value && GLib.path_is_absolute(value)
        ? value
        : GLib.build_filenamev([GLib.get_home_dir(), ...fallback]), APP]);
}

export function cacheRoot() {
    return xdgDir('XDG_CACHE_HOME', ['.cache']);
}

export function wallpaperDir() {
    return GLib.build_filenamev([xdgDir('XDG_DATA_HOME', ['.local', 'share']), 'wallpapers']);
}

export function uniqueName() {
    return `${new Gio.Credentials().get_unix_pid()}-${GLib.uuid_string_random()}`;
}

export function isIoError(error, code) {
    return error instanceof GLib.Error && error.matches(Gio.io_error_quark(), code);
}

export async function makeDir(path, cancellable) {
    const file = Gio.File.new_for_path(path);
    try {
        await file.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable);
    } catch (error) {
        if (isIoError(error, Gio.IOErrorEnum.EXISTS))
            return;
        if (!isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
            throw error;
        await makeDir(file.get_parent().get_path(), cancellable);
        await makeDir(path, cancellable);
    }
}

export async function stat(path, cancellable, flags = Gio.FileQueryInfoFlags.NONE) {
    try {
        return await Gio.File.new_for_path(path).query_info_async(STAT, flags,
            GLib.PRIORITY_DEFAULT, cancellable);
    } catch (error) {
        if (isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
            return null;
        throw error;
    }
}

export async function children(path, cancellable) {
    let enumerator;
    try {
        enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
            `standard::name,${STAT}`, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_LOW, cancellable);
    } catch (error) {
        if (isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
            return [];
        throw error;
    }
    const infos = [];
    for (;;) {
        const batch = await enumerator.next_files_async(64, GLib.PRIORITY_LOW, cancellable);
        if (batch.length === 0)
            break;
        infos.push(...batch);
    }
    return infos;
}

export async function removeFile(path) {
    try {
        await Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null);
    } catch (error) {
        if (!isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
            throw error;
    }
}

export async function removeTree(path) {
    for (const info of await children(path, null)) {
        const child = GLib.build_filenamev([path, info.get_name()]);
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            await removeTree(child);
        else
            await removeFile(child);
    }
    await removeFile(path);
}

export async function treeSize(path) {
    let total = 0;
    for (const info of await children(path, null)) {
        total += info.get_file_type() === Gio.FileType.DIRECTORY
            ? await treeSize(GLib.build_filenamev([path, info.get_name()]))
            : info.get_size();
    }
    return total;
}

export function lowPriority() {
    const nice = findProgram('nice');
    return nice ? [nice, '-n', '19'] : [];
}
