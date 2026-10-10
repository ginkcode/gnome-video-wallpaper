import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';

class Blocked extends Error {}

function delay(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function waitFor(predicate, ms = 3000) {
    const deadline = GLib.get_monotonic_time() + ms * 1000;
    do {
        const result = await predicate();
        if (result)
            return result;
        await delay(50);
    } while (GLib.get_monotonic_time() < deadline);
    return null;
}

function requireApi(condition, reason) {
    if (!condition)
        throw new Blocked(reason);
}

function enabledExtension(uuid) {
    const extension = Main.extensionManager?.lookup(uuid);
    // An imported stateObj survives disable(), so it alone is not readiness evidence.
    return extension?.state === 1 && extension.stateObj ? extension : null;
}

function dbus(connection, bus, path, iface, method, args = null) {
    return new Promise((resolve, reject) => connection.call(bus, path, iface, method,
        args, null, Gio.DBusCallFlags.NONE, 750, null, (object, result) => {
            try {
                resolve(object.call_finish(result).deepUnpack());
            } catch (error) {
                reject(error);
            }
        }));
}

async function accessibilityConnection() {
    const [address] = await dbus(Gio.DBus.session, 'org.a11y.Bus', '/org/a11y/bus',
        'org.a11y.Bus', 'GetAddress');
    return new Promise((resolve, reject) => Gio.DBusConnection.new_for_address(address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        null, null, (_object, result) => {
            try {
                resolve(Gio.DBusConnection.new_for_address_finish(result));
            } catch (error) {
                reject(error);
            }
        }));
}

const ACCESSIBLE = 'org.a11y.atspi.Accessible';

async function accessibleName(connection, [bus, path]) {
    const [value] = await dbus(connection, bus, path, 'org.freedesktop.DBus.Properties',
        'Get', new GLib.Variant('(ss)', [ACCESSIBLE, 'Name']));
    return value instanceof GLib.Variant ? value.deepUnpack() : value;
}

async function findFixture(connection, pid, fixture) {
    const [applications] = await dbus(connection, 'org.a11y.atspi.Registry',
        '/org/a11y/atspi/accessible/root', ACCESSIBLE, 'GetChildren');
    let root = null;
    for (const app of applications.slice(0, 32)) {
        const [ownerPid] = await dbus(connection, 'org.freedesktop.DBus',
            '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
            new GLib.Variant('(s)', [app[0]]));
        if (ownerPid === pid) {
            root = app;
            break;
        }
    }
    if (!root)
        return null;
    const queue = [root];
    const deadline = GLib.get_monotonic_time() + 3000000;
    for (let visited = 0; queue.length && visited < 128 && GLib.get_monotonic_time() < deadline; visited++) {
        const ref = queue.shift();
        const name = await accessibleName(connection, ref);
        if (name === fixture || name?.startsWith(`${fixture} File`))
            return {ref, name};
        const [children] = await dbus(connection, ...ref, ACCESSIBLE, 'GetChildren');
        queue.push(...children.slice(0, 64));
    }
    return null;
}

async function verifyDing(window, capture) {
    const extension = enabledExtension('ding@rastersoft.com');
    requireApi(extension, 'DING not enabled in the private session');
    const process = extension.stateObj.data?.currentProcess;
    const pid = Number(process?.subprocess?.get_identifier());
    requireApi(pid && process?._waylandClient?.owns_window,
        'Installed DING process/Wayland ownership API unavailable');
    const desktopWindows = global.get_window_actors().map(actor => actor.meta_window)
        .filter(candidate => process._waylandClient.owns_window(candidate));
    requireApi(desktopWindows.length, 'DING has no mapped desktop window');
    const fixture = GLib.getenv('T08_DESKTOP_FIXTURE') ?? 't08-consumer-fixture.txt';
    let connection;
    let pointer;
    let pressed = false;
    const [oldX, oldY] = global.get_pointer();
    try {
        try {
            connection = await accessibilityConnection();
        } catch (error) {
            throw new Blocked(`Private AT-SPI bus unavailable: ${error.message}`);
        }
        let icon;
        try {
            icon = await findFixture(connection, pid, fixture);
        } catch (error) {
            throw new Blocked(`DING accessible APIs unavailable: ${error.message}`);
        }
        requireApi(icon, `DING accessible fixture ${fixture} absent; prepare Desktop and accessibility`);
        requireApi(!icon.name.endsWith(' Selected'), 'Desktop fixture already selected; start with clean Desktop');
        let extents;
        try {
            [extents] = await dbus(connection, ...icon.ref, 'org.a11y.atspi.Component',
                'GetExtents', new GLib.Variant('(u)', [0]));
        } catch (error) {
            throw new Blocked(`DING accessible screen coordinates unavailable: ${error.message}`);
        }
        const [x, y, width, height] = extents;
        const targetX = x + width / 2;
        const targetY = y + height / 2;
        requireApi(width > 0 && height > 0 && Main.layoutManager.monitors.some(monitor =>
            targetX >= monitor.x && targetX < monitor.x + monitor.width &&
            targetY >= monitor.y && targetY < monitor.y + monitor.height),
        'DING fixture has no usable on-screen bounds');
        const seat = Clutter.get_default_backend()?.get_default_seat?.();
        requireApi(seat?.create_virtual_device, 'Mutter virtual pointer API unavailable');
        pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        requireApi(pointer?.notify_absolute_motion && pointer?.notify_button,
            'Virtual pointer motion/button methods unavailable');
        await capture('consumer-ding-before');
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), targetX, targetY);
        await delay(100);
        pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.PRESSED);
        pressed = true;
        await delay(60);
        pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED);
        pressed = false;
        // Installed GTK3 DING exposes selection in the accessible name, not SELECTED state.
        const selectedName = await waitFor(async () => {
            const name = await accessibleName(connection, icon.ref);
            return name !== icon.name && name === `${fixture} File Selected` ? name : null;
        }, 2000);
        await capture('consumer-ding-selected');
        if (!selectedName)
            throw new Error('DING pointer click did not change the fixture accessible name to selected');
        if (global.display.focus_window === window)
            throw new Error('Wallpaper stole focus during DING click');
        return {pid, fixture, targetX, targetY, before: icon.name, after: selectedName,
            desktopWindows: desktopWindows.length, evidence: 'accessible-name-selection-transition'};
    } finally {
        if (pressed)
            pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED);
        if (pointer) {
            pointer.notify_absolute_motion(GLib.get_monotonic_time(), oldX, oldY);
            pointer.run_dispose();
        }
        if (connection) {
            await new Promise(resolve => connection.close(null, (object, result) => {
                try {
                    object.close_finish(result);
                } catch {
                    // A closed accessibility bus needs no further cleanup.
                } finally {
                    resolve();
                }
            }));
        }
    }
}

export async function verifyConsumers(window, capture) {
    if (!window || typeof capture !== 'function')
        throw new Error('verifyConsumers requires a live Meta.Window and async capture(name)');
    if (GLib.getenv('T08_PRIVATE_NESTED') !== '1')
        throw new Error('Consumer verification is restricted to T08_PRIVATE_NESTED=1 fixtures');
    const reports = [];
    async function check(consumer, action) {
        try {
            reports.push({consumer, status: 'verified', ...await action()});
        } catch (error) {
            reports.push({consumer, status: error instanceof Blocked ? 'blocked' : 'failed',
                reason: error.message});
        }
    }
    const overviewWasVisible = Main.overview.visible;
    try {
        Main.overview.show();
        await check('overview', async () => {
            const display = Main.overview._overview?.controls?._workspacesDisplay;
            requireApi(display, 'Overview workspaces display API unavailable');
            const ready = await waitFor(() => !Main.overview.animationInProgress &&
                display._workspacesViews?.length);
            if (!ready)
                throw new Error('Overview picker failed to settle within 3 seconds');
            const workspaces = display._workspacesViews.flatMap(view =>
                view._workspaces ?? (view._workspace ? [view._workspace] : []));
            requireApi(workspaces.length && workspaces.every(workspace => Array.isArray(workspace._windows)),
                'Overview runtime workspace preview arrays unavailable');
            const previews = workspaces.flatMap(workspace => workspace._windows);
            requireApi(previews.every(preview => preview.metaWindow), 'Overview preview Meta.Window API unavailable');
            await capture('consumer-overview-picker');
            if (previews.some(preview => preview.metaWindow === window))
                throw new Error('Wallpaper appears in actual overview window previews');
            return {workspaces: workspaces.length, previews: previews.length, windowExcluded: true};
        });
        await check('dock', async () => {
            const uuids = ['dash-to-dock@micxgx.gmail.com', 'ubuntu-dock@ubuntu.com'];
            const extension = uuids.map(enabledExtension).find(Boolean);
            requireApi(extension, 'No enabled installed dash-to-dock/ubuntu-dock consumer');
            // Shell stores the instance; the installed dock exports its manager from extension.js.
            const module = await import(extension.dir.get_child('extension.js').get_uri());
            const manager = module.dockManager;
            requireApi(manager?._allDocks?.length, 'Installed dock exported manager/runtime docks unavailable');
            requireApi(manager.settings?.showRunning, 'Dock show-running disabled; exclusion would be vacuous');
            await delay(600);
            const docks = manager._allDocks.map(dock => {
                requireApi(typeof dock.dash?.getAppIcons === 'function', 'Dock runtime icon API unavailable');
                const icons = dock.dash.getAppIcons();
                requireApi(icons.every(icon => icon.app), 'Dock app icon identity unavailable');
                return {monitor: dock.monitorIndex, apps: icons.map(icon => icon.app)};
            });
            const wallpaperApp = Shell.WindowTracker.get_default().get_window_app(window);
            requireApi(wallpaperApp, 'Wallpaper Shell.App identity unavailable');
            await capture('consumer-dock-app-list');
            if (docks.some(dock => dock.apps.includes(wallpaperApp)))
                throw new Error('Wallpaper application appears in installed dock runtime app icons');
            return {uuid: extension.uuid, windowExcluded: true,
                docks: docks.map(dock => ({monitor: dock.monitor,
                    apps: dock.apps.map(app => app.get_id())}))};
        });
        Main.overview.hide();
        await delay(600);
        for (const [consumer, Type, binding] of [
            ['altTab-applications', AltTab.AppSwitcherPopup, 'switch-applications'],
            ['altTab-windows', AltTab.WindowSwitcherPopup, 'switch-windows'],
        ]) {
            await check(consumer, async () => {
                requireApi(Type, 'Installed Shell switcher popup class unavailable');
                const popup = new Type();
                try {
                    requireApi(Array.isArray(popup._items), 'Switcher runtime item array unavailable');
                    const items = popup._items;
                    const appMode = consumer === 'altTab-applications';
                    requireApi(items.every(item => appMode ? Array.isArray(item.cachedWindows) : item.window),
                        'Switcher runtime window identity API unavailable');
                    const windows = items.flatMap(item => appMode ? item.cachedWindows : [item.window]);
                    if (windows.includes(window))
                        throw new Error('Wallpaper appears in actual switcher popup items');
                    requireApi(items.length, 'Switcher has no normal applications/windows to show; add a control app');
                    requireApi(popup.show(false, binding, 0), 'Switcher popup could not be shown');
                    const visible = await waitFor(() => popup.visible && popup.opacity > 0, 1000);
                    if (!visible)
                        throw new Error('Switcher popup did not become visible');
                    await capture(`consumer-${consumer}-popup`);
                    return {windowExcluded: true, shown: true, items: items.length, windows: windows.length};
                } finally {
                    popup.destroy();
                }
            });
        }
        await check('ding', () => verifyDing(window, capture));
    } finally {
        if (overviewWasVisible)
            Main.overview.show();
        else
            Main.overview.hide();
    }
    if (reports.some(report => report.status === 'failed')) {
        const error = new Error(`Consumer verification failed: ${JSON.stringify(reports)}`);
        error.reports = reports;
        throw error;
    }
    return reports;
}
