import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {createLogger} from './log.js';
import {waitForStartupOn} from './startupLifecycle.js';

const log = createLogger('startup');

export function waitForStartup({delayMs, cancellable}) {
    return waitForStartupOn(Main.layoutManager, {delayMs, cancellable,
        onComplete: () => log.debug(`startup-complete at ${GLib.get_monotonic_time() / 1000 | 0} ms`)});
}
