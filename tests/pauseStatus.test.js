import {pauseStatus} from '../lib/pauseStatus.js';
import {assertEqual, run, test} from './harness.js';

test('only automatic reasons are described, in a fixed order', () => {
    assertEqual(pauseStatus(new Set(['startup', 'user'])), null);
    assertEqual(pauseStatus(new Set(['remote', 'covered', 'battery'])),
        'Paused automatically: a window covers the desktop, on battery power, the screen is shared or remote');
    assertEqual(pauseStatus(new Set(['overview'])), 'Paused automatically: the Overview is open');
});

await run();
