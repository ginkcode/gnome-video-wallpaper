import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function call(method, parameters = null) {
    return new Promise((resolve, reject) => Gio.DBus.session.call(
        'org.gnome.Shell.Screencast', '/org/gnome/Shell/Screencast',
        'org.gnome.Shell.Screencast', method, parameters, null,
        Gio.DBusCallFlags.NONE, 8000, null, (connection, result) => {
            try {
                resolve(connection.call_finish(result).deep_unpack());
            } catch (error) {
                reject(error);
            }
        }));
}

export async function startRecording(name) {
    const [success, filename] = await call('Screencast', new GLib.Variant('(sa{sv})', [
        `${GLib.getenv('T08_OUTPUT')}/${name}.webm`, {
            framerate: new GLib.Variant('i', 60),
            'draw-cursor': new GLib.Variant('b', false),
            pipeline: new GLib.Variant('s',
                'videoconvert ! vp8enc cpu-used=16 deadline=1 keyframe-max-dist=1 threads=2 ! webmmux'),
        },
    ]));
    if (!success)
        throw new Error('screencast did not start');
    return {filename, startedUs: GLib.get_monotonic_time()};
}

export async function stopRecording() {
    const [success] = await call('StopScreencast');
    if (!success)
        throw new Error('screencast did not stop');
}
