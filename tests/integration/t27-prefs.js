import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {HANABI_UUID} from '../../lib/compat.js';
import {HanabiBanner} from '../../prefs/hanabiBanner.js';

const report = (event, data = {}) => print(`T27_PREFS ${JSON.stringify({event, ...data})}`);
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function waitFor(predicate, timeout = 15000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout)
            return false;
        await sleep(50);
    }
    return true;
}

function enableHanabi() {
    Gio.DBus.session.call_sync('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell.Extensions',
        'EnableExtension', new GLib.Variant('(s)', [HANABI_UUID]), null, Gio.DBusCallFlags.NONE, 5000, null);
}

async function main() {
    Adw.init();
    const hanabi = new HanabiBanner();
    const page = new Adw.PreferencesPage();
    const banner = hanabi.attach(page);
    await sleep(1500);
    const initial = {active: hanabi.active, revealed: banner.revealed, attached: page.banner === banner};
    report('initial', initial);
    if (!initial.active) {
        hanabi.close();
        return;
    }
    banner.emit('button-clicked');
    const cleared = await waitFor(() => !hanabi.active && !banner.revealed);
    report('disabled', {cleared, active: hanabi.active, revealed: banner.revealed});
    enableHanabi();
    const shown = await waitFor(() => hanabi.active && banner.revealed);
    report('reenabled', {shown, active: hanabi.active, revealed: banner.revealed});
    hanabi.close();
}

const loop = new GLib.MainLoop(null, false);
main().catch(error => report('error', {message: error.message, stack: error.stack})).finally(() => loop.quit());
loop.run();
