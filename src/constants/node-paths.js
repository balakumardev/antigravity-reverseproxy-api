/**
 * Node-only filesystem path constants
 *
 * This file intentionally uses Node builtins and must NOT be imported by edge runtimes.
 */

import { homedir, platform } from 'os';
import { join } from 'path';

/**
 * Get the Antigravity database path based on the current platform.
 * - macOS: ~/Library/Application Support/Antigravity/...
 * - Windows: ~/AppData/Roaming/Antigravity/...
 * - Linux/other: ~/.config/Antigravity/...
 * @returns {string} Full path to the Antigravity state database
 */
function getAntigravityDbPath() {
    const home = homedir();
    switch (platform()) {
        case 'darwin':
            return join(home, 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb');
        case 'win32':
            return join(home, 'AppData/Roaming/Antigravity/User/globalStorage/state.vscdb');
        default: // linux, freebsd, etc.
            return join(home, '.config/Antigravity/User/globalStorage/state.vscdb');
    }
}

// Multi-account configuration
export const ACCOUNT_CONFIG_PATH = process.env.ACCOUNT_CONFIG_PATH || join(
    homedir(),
    '.config/antigravity-proxy/accounts.json'
);

// Antigravity app database path (for legacy single-account token extraction)
export const ANTIGRAVITY_DB_PATH = process.env.ANTIGRAVITY_DB_PATH || getAntigravityDbPath();

export default {
    ACCOUNT_CONFIG_PATH,
    ANTIGRAVITY_DB_PATH
};

