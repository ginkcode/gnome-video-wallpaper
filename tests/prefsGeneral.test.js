import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseVersion} from '../lib/deps.js';
import {bindChoice, bindScaled} from '../prefs/bindings.js';
import {clearReport, installCommands, osFamilies} from '../prefs/diagnostics.js';
import {assertDeepEqual, assertEqual, run, test} from './harness.js';

const root = GLib.dir_make_tmp('gink-vw-general-XXXXXX');
GLib.setenv('XDG_CACHE_HOME', `${root}/cache`, true);
const {cacheSize} = await import('../lib/stillCache.js');
const [, , stderr, status] = GLib.spawn_sync(null, ['glib-compile-schemas', '--strict', `--targetdir=${root}`,
    'schemas'], null, GLib.SpawnFlags.SEARCH_PATH, null);
if (status !== 0)
    throw new Error(new TextDecoder().decode(stderr));
const source = Gio.SettingsSchemaSource.new_from_directory(root, Gio.SettingsSchemaSource.get_default(), false);

function settings() {
    return new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.gink-video-wallpaper', true),
        backend: Gio.memory_settings_backend_new()});
}

const Target = GObject.registerClass({
    Properties: {
        value: GObject.ParamSpec.double('value', null, null, GObject.ParamFlags.READWRITE, 0, 1000, 0),
        selected: GObject.ParamSpec.uint('selected', null, null, GObject.ParamFlags.READWRITE, 0, 100, 0),
    },
}, class Target extends GObject.Object {});

test('seconds bind both ways to millisecond keys', () => {
    const store = settings();
    const target = new Target();
    const unbind = bindScaled(store, 'startup-delay-ms', target, 'value', 1000);
    assertEqual(target.value, 3, 'initial seconds');
    target.value = 1.5;
    assertEqual(store.get_uint('startup-delay-ms'), 1500, 'widget to setting');
    store.set_uint('startup-delay-ms', 250);
    assertEqual(target.value, 0.25, 'setting to widget');
    unbind();
    target.value = 9;
    assertEqual(store.get_uint('startup-delay-ms'), 250, 'unbound');
});

test('choices bind enum nicks to the selected index', () => {
    const store = settings();
    const target = new Target();
    const nicks = ['auto', 'gpu-next', 'dmabuf-wayland'];
    const unbind = bindChoice(store, 'video-output', target, nicks);
    assertEqual(target.selected, 0);
    target.selected = 2;
    assertEqual(store.get_string('video-output'), 'dmabuf-wayland');
    store.set_string('video-output', 'gpu-next');
    assertEqual(target.selected, 1);
    target.selected = 7;
    assertEqual(store.get_string('video-output'), 'gpu-next', 'out of range ignored');
    unbind();
});

test('version strings and install commands', () => {
    assertEqual(parseVersion('mpv v0.41.0 Copyright © 2000-2025\n'), '0.41.0');
    assertEqual(parseVersion('ffmpeg version 8.0.1-3ubuntu2 Copyright (c)'), '8.0.1-3ubuntu2');
    assertEqual(parseVersion(''), null);
    assertDeepEqual(osFamilies('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n'), ['ubuntu', 'debian']);
    assertDeepEqual(installCommands('ID=ubuntu\nID_LIKE=debian', ['mpv', 'ffprobe', 'ffmpeg']),
        ['sudo apt install mpv ffmpeg']);
    assertDeepEqual(installCommands('ID="fedora"', ['ffprobe']), ['sudo dnf install ffmpeg']);
    assertDeepEqual(installCommands('ID=gentoo', ['mpv']), ['sudo apt install mpv', 'sudo dnf install mpv']);
    assertDeepEqual(installCommands('ID=arch', []), []);
});

test('clear report names preserved bytes', () => {
    const size = bytes => `${bytes} B`;
    assertEqual(clearReport({removedBytes: 10, preservedActiveBytes: 0, preservedWallpaperBytes: 0}, size),
        'Freed 10 B.');
    assertEqual(clearReport({removedBytes: 0, preservedActiveBytes: 5, preservedWallpaperBytes: 7}, size),
        'Freed 0 B. Kept 5 B in use by playing wallpapers and 7 B of applied wallpaper images.');
});

test('cache size counts hard-linked files once', async () => {
    assertEqual(await cacheSize(), 0, 'missing cache is empty');
    const stills = Gio.File.new_for_path(`${root}/cache/gink-video-wallpaper/stills`);
    stills.make_directory_with_parents(null);
    const ref = Gio.File.new_for_path(`${root}/cache/gink-video-wallpaper/refs/1-x`);
    ref.make_directory_with_parents(null);
    stills.get_child('a.png').replace_contents(new Uint8Array(100), null, false, Gio.FileCreateFlags.NONE, null);
    stills.get_child('b.png').replace_contents(new Uint8Array(50), null, false, Gio.FileCreateFlags.NONE, null);
    GLib.spawn_sync(null, ['ln', stills.get_child('a.png').get_path(), ref.get_child('a').get_path()], null,
        GLib.SpawnFlags.SEARCH_PATH, null);
    assertEqual(await cacheSize(), 150);
});

try {
    await run();
} finally {
    Gio.Subprocess.new(['rm', '-rf', root], Gio.SubprocessFlags.NONE).wait(null);
}
