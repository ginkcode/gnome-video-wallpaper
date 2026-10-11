import Meta from 'gi://Meta';

import {CoverageController} from './coverageController.js';
import {createLogger} from './log.js';

export class PauseController {
    constructor({playerManager, settings, logger = createLogger('pause')}) {
        this._coverage = new CoverageController({playerManager, settings, logger,
            display: global.display, workspaceManager: global.workspace_manager,
            normalType: Meta.WindowType.NORMAL, maximizeBoth: Meta.MaximizeFlags.BOTH});
    }

    enable() {
        this._coverage.enable();
    }

    disable() {
        this._coverage.disable();
    }
}
