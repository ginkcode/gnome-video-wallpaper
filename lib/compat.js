import {Disposables} from './disposables.js';
import {createLogger} from './log.js';

export const HANABI_UUID = 'hanabi-extension@jeffshee.github.io';
export const ExtensionStateValue = {ACTIVE: 1, UNINSTALLED: 99};

const log = createLogger('compat');

export function stateFromInfo(info) {
    const state = info?.state;
    return typeof state === 'number' ? state : ExtensionStateValue.UNINSTALLED;
}

export function hanabiActive({state, enabled = [], disabled = [], userExtensionsDisabled = false} = {}) {
    if (typeof state === 'number')
        return state === ExtensionStateValue.ACTIVE;
    return !userExtensionsDisabled && enabled.includes(HANABI_UUID) && !disabled.includes(HANABI_UUID);
}

export class HanabiWatcher {
    constructor({extensionManager, onChange = null}) {
        this._manager = extensionManager;
        this._onChange = onChange;
        this._disposables = null;
        this.active = false;
    }

    enable() {
        this._disposables = new Disposables();
        this._disposables.connect(this._manager, 'extension-state-changed', (_manager, extension) => {
            if (extension?.uuid === HANABI_UUID)
                this._update();
        });
        this._update();
    }

    disable() {
        this._disposables?.dispose();
        this._disposables = null;
        this.active = false;
    }

    _update() {
        const active = hanabiActive({state: this._manager.lookup(HANABI_UUID)?.state ??
            ExtensionStateValue.UNINSTALLED});
        if (active === this.active)
            return;
        this.active = active;
        if (active) {
            log.warn(`Hanabi (${HANABI_UUID}) is enabled and also draws a video wallpaper; ` +
                `disable it with: gnome-extensions disable ${HANABI_UUID}`);
        }
        this._onChange?.(active);
    }
}
