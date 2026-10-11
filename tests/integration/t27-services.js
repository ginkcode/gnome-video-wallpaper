import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SESSION_IFACE = `<node><interface name="org.gnome.SessionManager">
<method name="Inhibit"><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/>
<arg type="u" direction="in"/><arg type="u" direction="out"/></method>
<method name="Uninhibit"><arg type="u" direction="in"/></method>
<method name="IsInhibited"><arg type="u" direction="in"/><arg type="b" direction="out"/></method>
<method name="GetInhibitors"><arg type="ao" direction="out"/></method>
<signal name="InhibitorAdded"><arg type="o"/></signal>
<signal name="InhibitorRemoved"><arg type="o"/></signal>
<property name="InhibitedActions" type="u" access="read"/>
</interface></node>`;
const SCREENSAVER_IFACE = `<node><interface name="org.freedesktop.ScreenSaver">
<method name="Inhibit"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="u" direction="out"/></method>
<method name="UnInhibit"><arg type="u" direction="in"/></method>
<method name="GetActive"><arg type="b" direction="out"/></method>
</interface></node>`;
const FAKE_IFACE = `<node><interface name="org.ginkcode.T27Fake">
<method name="Log"><arg type="s" direction="out"/></method>
</interface></node>`;
const IDLE = 8;

const calls = [];
const inhibitors = new Map();
let nextCookie = 1;

function senderPid(sender) {
    try {
        return Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'GetConnectionUnixProcessID', new GLib.Variant('(s)', [sender]), null, Gio.DBusCallFlags.NONE, 2000,
            null).deep_unpack()[0];
    } catch {
        return null;
    }
}

function record(iface, method, args, invocation) {
    const sender = invocation.get_sender();
    const entry = {iface, method, args, sender, pid: senderPid(sender), t: Math.round(GLib.get_monotonic_time() / 1000)};
    calls.push(entry);
    return entry;
}

const actions = () => [...inhibitors.values()].reduce((flags, entry) => flags | entry.flags, 0);
let session;

function add(appId, reason, flags, entry) {
    const cookie = nextCookie++;
    inhibitors.set(cookie, {cookie, appId, reason, flags, pid: entry.pid, via: entry.iface});
    session.emit_signal('InhibitorAdded', new GLib.Variant('(o)', [`/org/gnome/SessionManager/Inhibitor${cookie}`]));
    session.emit_property_changed('InhibitedActions', new GLib.Variant('u', actions()));
    return cookie;
}

function remove(cookie) {
    if (!inhibitors.delete(cookie))
        return;
    session.emit_signal('InhibitorRemoved', new GLib.Variant('(o)', [`/org/gnome/SessionManager/Inhibitor${cookie}`]));
    session.emit_property_changed('InhibitedActions', new GLib.Variant('u', actions()));
}

const sessionImpl = {
    InhibitAsync(params, invocation) {
        const [appId, , reason, flags] = params;
        const entry = record('session', 'Inhibit', params, invocation);
        invocation.return_value(new GLib.Variant('(u)', [add(appId, reason, flags, entry)]));
    },
    UninhibitAsync(params, invocation) {
        record('session', 'Uninhibit', params, invocation);
        remove(params[0]);
        invocation.return_value(null);
    },
    IsInhibited(flags) {
        return (actions() & flags) !== 0;
    },
    GetInhibitors() {
        return [...inhibitors.keys()].map(cookie => `/org/gnome/SessionManager/Inhibitor${cookie}`);
    },
    get InhibitedActions() {
        return actions();
    },
};

const screensaverImpl = {
    InhibitAsync(params, invocation) {
        const entry = record('screensaver', 'Inhibit', params, invocation);
        invocation.return_value(new GLib.Variant('(u)', [add(params[0], params[1], IDLE, entry)]));
    },
    UnInhibitAsync(params, invocation) {
        record('screensaver', 'UnInhibit', params, invocation);
        remove(params[0]);
        invocation.return_value(null);
    },
    GetActive() {
        return false;
    },
};

const fakeImpl = {
    Log() {
        return JSON.stringify({calls, inhibitors: [...inhibitors.values()], inhibitedActions: actions()});
    },
};

session = Gio.DBusExportedObject.wrapJSObject(SESSION_IFACE, sessionImpl);
session.export(Gio.DBus.session, '/org/gnome/SessionManager');
const screensaver = Gio.DBusExportedObject.wrapJSObject(SCREENSAVER_IFACE, screensaverImpl);
screensaver.export(Gio.DBus.session, '/org/freedesktop/ScreenSaver');
const fake = Gio.DBusExportedObject.wrapJSObject(FAKE_IFACE, fakeImpl);
fake.export(Gio.DBus.session, '/org/ginkcode/T27Fake');
for (const name of ['org.gnome.SessionManager', 'org.freedesktop.ScreenSaver', 'org.ginkcode.T27Fake'])
    Gio.bus_own_name(Gio.BusType.SESSION, name, Gio.BusNameOwnerFlags.NONE, null, null, null);
print('T27_SERVICES ready');
new GLib.MainLoop(null, false).run();
