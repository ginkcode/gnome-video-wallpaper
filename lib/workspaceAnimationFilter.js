import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

// The sticky player window would otherwise be cloned at full opacity above
// every workspace during a switch. Windows stay excluded once seen as owned:
// a window whose eligibility changes mid-switch has no clone record, and
// Shell's restack handler throws on it.
export class WorkspaceAnimationFilter {
    constructor({isOwn}) {
        this._isOwn = isOwn;
        this._injections = null;
    }

    enable() {
        if (this._injections)
            throw new Error('WorkspaceAnimationFilter is already enabled');
        const isOwn = this._isOwn;
        const owned = new WeakSet();
        this._injections = new InjectionManager();
        this._injections.overrideMethod(WorkspaceAnimation.WorkspaceGroup.prototype, '_shouldShowWindow',
            original => function (window) {
                if (owned.has(window) || isOwn(window)) {
                    owned.add(window);
                    return false;
                }
                return original.call(this, window);
            });
    }

    disable() {
        this._injections?.clear();
        this._injections = null;
    }
}
