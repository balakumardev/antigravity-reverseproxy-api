/**
 * Node entrypoint constants
 *
 * Re-exports shared constants plus Node-only filesystem paths.
 */

export * from './constants/shared.js';
export * from './constants/node-paths.js';

import sharedDefaults from './constants/shared.js';
import { ACCOUNT_CONFIG_PATH, ANTIGRAVITY_DB_PATH } from './constants/node-paths.js';

export default {
    ...sharedDefaults,
    ACCOUNT_CONFIG_PATH,
    ANTIGRAVITY_DB_PATH
};
