import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {assertEqual, assertThrows, run, test} from './harness.js';

const root = GLib.dir_make_tmp('gink-vw-wallpaper-XXXXXX');
GLib.setenv('XDG_CACHE_HOME', `${root}/cache`, true);
GLib.setenv('XDG_DATA_HOME', `${root}/data`, true);
const {WallpaperSync, isPublishedUri} = await import('../lib/wallpaperSync.js');
const {clearCache, wallpaperDir} = await import('../lib/stillCache.js');

const schemaDir = GLib.build_filenamev([GLib.get_current_dir(), 'schemas']);
const [, , stderr, status] = GLib.spawn_sync(null, ['glib-compile-schemas', '--strict',
    `--targetdir=${root}`, schemaDir], null, GLib.SpawnFlags.SEARCH_PATH, null);
if (status !== 0)
    throw new Error(`glib-compile-schemas failed: ${new TextDecoder().decode(stderr)}`);
const source = Gio.SettingsSchemaSource.new_from_directory(root, Gio.SettingsSchemaSource.get_default(), false);
const logger = {debug() {}, info() {}, warn() {}, error() {}};
const ORIGINAL = {
    'picture-uri': 'file:///usr/share/backgrounds/light.png',
    'picture-uri-dark': 'file:///usr/share/backgrounds/dark.png',
    'picture-options': 'centered',
    'primary-color': '#023c88',
    'color-shading-type': 'vertical',
};
const STILL = {'picture-options': 'zoom', 'primary-color': '#000000', 'color-shading-type': 'solid'};

function settings(id, backend) {
    return new Gio.Settings({settings_schema: source.lookup(id, true), backend});
}

function session() {
    const backend = Gio.memory_settings_backend_new();
    const background = settings('org.gnome.desktop.background', backend);
    for (const [key, value] of Object.entries(ORIGINAL))
        background.set_string(key, value);
    return {backend, background, extension: settings('org.gnome.shell.extensions.gink-video-wallpaper', backend)};
}

function published(name) {
    GLib.mkdir_with_parents(wallpaperDir(), 0o755);
    const path = `${wallpaperDir()}/${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, name, -1)}.png`;
    GLib.file_set_contents(path, name);
    return `file://${path}`;
}

function current(background) {
    return Object.fromEntries(Object.keys(ORIGINAL).map(key => [key, background.get_string(key)]));
}

test('only published wallpaper URIs are accepted', () => {
    const uri = published('a');
    assertEqual(isPublishedUri(uri), true, 'published');
    assertEqual(isPublishedUri(`file://${root}/cache/gink-video-wallpaper/stills/${'a'.repeat(64)}.png`),
        false, 'cache path');
    assertEqual(isPublishedUri(`file://${wallpaperDir()}/../wallpapers/x.png`), false, 'non-hash name');
    assertEqual(isPublishedUri(`file://${wallpaperDir()}/sub/../../${'b'.repeat(64)}.png`), false, 'traversal');
    const {background, extension} = session();
    const sync = new WallpaperSync(extension, logger, background);
    assertThrows(() => sync.apply('file:///tmp/x.png'), 'apply rejects unpublished');
    assertEqual(extension.get_boolean('wallpaper-applied'), false, 'nothing saved on rejection');
    sync.destroy();
});

test('apply saves originals once and restore brings them back exactly', () => {
    const {background, extension} = session();
    const sync = new WallpaperSync(extension, logger, background);
    const first = published('first');
    assertEqual(sync.apply(first), true, 'applied');
    assertEqual(JSON.stringify(current(background)), JSON.stringify(
        {'picture-uri': first, 'picture-uri-dark': first, ...STILL}), 'still applied on a black background');
    assertEqual(sync.isApplied, true, 'isApplied');
    sync.apply(published('second'));
    assertEqual(extension.get_string('saved-picture-uri'), ORIGINAL['picture-uri'], 'originals kept');
    sync.restore();
    assertEqual(JSON.stringify(current(background)), JSON.stringify(ORIGINAL), 'restored');
    assertEqual(sync.isApplied, false, 'not applied');
    assertEqual(extension.get_string('saved-picture-uri'), '', 'saved cleared');
    assertEqual(sync.apply(first), false, 'stale apply after restore ignored');
    assertEqual(JSON.stringify(current(background)), JSON.stringify(ORIGINAL), 'still restored');
    sync.destroy();
});

test('redundant writes are skipped', () => {
    const {background, extension} = session();
    const sync = new WallpaperSync(extension, logger, background);
    const uri = published('same');
    sync.apply(uri);
    let changes = 0;
    const id = background.connect('changed', () => changes++);
    sync.apply(uri);
    background.disconnect(id);
    assertEqual(changes, 0, 'no rewrite');
    sync.restore();
    sync.destroy();
});

test('restart while applied does not overwrite saved originals', () => {
    const {background, extension} = session();
    const before = new WallpaperSync(extension, logger, background);
    before.apply(published('crash'));
    before.destroy();
    const after = new WallpaperSync(extension, logger, background);
    after.apply(published('restart'));
    assertEqual(extension.get_string('saved-picture-uri-dark'), ORIGINAL['picture-uri-dark'], 'saved dark kept');
    after.restore();
    assertEqual(JSON.stringify(current(background)), JSON.stringify(ORIGINAL), 'restored after restart');
    after.destroy();
});

test('external change while applied becomes the restored original', () => {
    const {background, extension} = session();
    const sync = new WallpaperSync(extension, logger, background);
    sync.apply(published('external'));
    background.set_string('picture-uri', 'file:///home/user/new-light.jpg');
    background.set_string('picture-options', 'wallpaper');
    sync.apply(published('external-2'));
    sync.restore();
    assertEqual(JSON.stringify(current(background)), JSON.stringify({...ORIGINAL,
        'picture-uri': 'file:///home/user/new-light.jpg', 'picture-options': 'wallpaper'}), 'user change kept');
    sync.destroy();
});

test('wallpaper changed while the extension was off becomes the restored original', () => {
    const {background, extension} = session();
    const before = new WallpaperSync(extension, logger, background);
    before.apply(published('off'));
    before.destroy();
    background.set_string('picture-uri', 'file:///home/user/while-off.jpg');
    background.set_string('primary-color', '#ffffff');
    const after = new WallpaperSync(extension, logger, background);
    after.apply(published('on-again'), 'scaled');
    assertEqual(background.get_string('picture-options'), 'scaled', 'fit mode applied');
    after.restore();
    assertEqual(JSON.stringify(current(background)), JSON.stringify({...ORIGINAL,
        'picture-uri': 'file:///home/user/while-off.jpg', 'picture-options': 'zoom', 'primary-color': '#ffffff'}),
    'the new picture keeps its options; unchanged keys stay saved');
    after.destroy();
});

test('publication survives clear cache and restore', async () => {
    const {background, extension} = session();
    const sync = new WallpaperSync(extension, logger, background);
    const uri = published('persistent');
    sync.apply(uri);
    await clearCache();
    const path = Gio.File.new_for_uri(uri).get_path();
    assertEqual(GLib.file_test(path, GLib.FileTest.EXISTS), true, 'after clear cache');
    sync.restore();
    await clearCache();
    assertEqual(GLib.file_test(path, GLib.FileTest.EXISTS), true, 'after restore');
    sync.destroy();
    background.set_string('picture-uri', 'file:///after/destroy.png');
    assertEqual(extension.get_string('saved-picture-uri'), '', 'destroyed sync ignores changes');
});

await run().finally(() => {
    if (root.startsWith(`${GLib.get_tmp_dir()}/gink-vw-wallpaper-`))
        GLib.spawn_sync(null, ['rm', '-rf', '--', root], null, GLib.SpawnFlags.SEARCH_PATH, null);
});
