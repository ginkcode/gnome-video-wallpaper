import {COVERED} from './coverageController.js';
import {BATTERY, OVERVIEW, REMOTE} from './sessionPauseController.js';

const LABELS = [
    [COVERED, 'a window covers the desktop'],
    [OVERVIEW, 'the Overview is open'],
    [BATTERY, 'on battery power'],
    [REMOTE, 'the screen is shared or remote'],
];

export function pauseStatus(reasons) {
    const active = LABELS.filter(([reason]) => reasons.has(reason)).map(([, label]) => label);
    return active.length > 0 ? `Paused automatically: ${active.join(', ')}` : null;
}
