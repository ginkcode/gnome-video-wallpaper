import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta?version=18';

import {withParentDeathSignal} from './mpvArgs.js';
import {ProcessLifecycle} from './playerLifecycle.js';

export {preparePlayerSocket, releasePlayerSocket} from './playerLifecycle.js';

export class PlayerProcess extends ProcessLifecycle {
    constructor({argv, socketPath, logger}) {
        super({argv, socketPath, logger, spawn: args => {
            const launcher = new Gio.SubprocessLauncher({flags:
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE});
            launcher.setenv('XDG_RUNTIME_DIR', GLib.getenv('XDG_RUNTIME_DIR'), true);
            const parentPid = new Gio.Credentials().get_unix_pid();
            const client = Meta.WaylandClient.new_subprocess(global.context, launcher,
                withParentDeathSignal(args, parentPid));
            return {client, subprocess: client.get_subprocess()};
        }});
    }

    get pid() {
        return this.waylandClient?.get_pid?.() ?? super.pid;
    }

    ownsWindow(window) {
        if (!(window instanceof Meta.Window))
            return false;
        try {
            if (Meta.WindowClientType &&
                window.get_client_type?.() !== Meta.WindowClientType.WAYLAND)
                return false;
            return super.ownsWindow(window);
        } catch {
            return false;
        }
    }
}
