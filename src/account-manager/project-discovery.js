/**
 * Project discovery (runtime-agnostic)
 *
 * Looks up the Cloud Code/Gemini Code Assist project ID for an account.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    DEFAULT_PROJECT_ID
} from '../constants/shared.js';
import { logger } from '../utils/logger.js';

/**
 * Discover project ID via Cloud Code API.
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<string>} Project ID
 */
export async function discoverProject(token) {
    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    ...ANTIGRAVITY_HEADERS
                },
                body: JSON.stringify({
                    metadata: {
                        ideType: 'IDE_UNSPECIFIED',
                        platform: 'PLATFORM_UNSPECIFIED',
                        pluginType: 'GEMINI'
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.warn(`[AccountManager] Project discovery failed at ${endpoint}: ${response.status} - ${errorText}`);
                continue;
            }

            const data = await response.json();

            if (typeof data.cloudaicompanionProject === 'string') {
                logger.success(`[AccountManager] Discovered project: ${data.cloudaicompanionProject}`);
                return data.cloudaicompanionProject;
            }
            if (data.cloudaicompanionProject?.id) {
                logger.success(`[AccountManager] Discovered project: ${data.cloudaicompanionProject.id}`);
                return data.cloudaicompanionProject.id;
            }
        } catch (error) {
            logger.warn(`[AccountManager] Project discovery failed at ${endpoint}:`, error.message);
        }
    }

    logger.warn(`[AccountManager] Project discovery failed for all endpoints. Using default project: ${DEFAULT_PROJECT_ID}`);
    logger.warn(`[AccountManager] If you see 404 errors, your account may not have Gemini Code Assist enabled.`);
    return DEFAULT_PROJECT_ID;
}

export default {
    discoverProject
};

