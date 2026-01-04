/**
 * OAuth client helpers (runtime-agnostic)
 *
 * These helpers only use fetch/Web APIs and can run in Node 18+ and edge runtimes.
 */

import { OAUTH_CONFIG, OAUTH_REDIRECT_URI } from '../constants/shared.js';
import { logger } from '../utils/logger.js';

/**
 * Exchange authorization code for tokens.
 *
 * @param {string} code - Authorization code from OAuth callback
 * @param {string} verifier - PKCE code verifier
 * @param {Object} [config]
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number}>}
 */
export async function exchangeCode(code, verifier, config = OAUTH_CONFIG) {
    const response = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code: code,
            code_verifier: verifier,
            grant_type: 'authorization_code',
            redirect_uri: OAUTH_REDIRECT_URI
        })
    });

    if (!response.ok) {
        const error = await response.text();
        logger.error(`[OAuth] Token exchange failed: ${response.status} ${error}`);
        throw new Error(`Token exchange failed: ${error}`);
    }

    const tokens = await response.json();

    if (!tokens.access_token) {
        logger.error('[OAuth] No access token in response:', tokens);
        throw new Error('No access token received');
    }

    logger.info(`[OAuth] Token exchange successful, access_token length: ${tokens.access_token?.length}`);

    return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in
    };
}

/**
 * Refresh access token using refresh token.
 *
 * @param {string} refreshToken - OAuth refresh token
 * @param {Object} [config]
 * @returns {Promise<{accessToken: string, expiresIn: number}>}
 */
export async function refreshAccessToken(refreshToken, config = OAUTH_CONFIG) {
    const response = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token refresh failed: ${error}`);
    }

    const tokens = await response.json();
    return {
        accessToken: tokens.access_token,
        expiresIn: tokens.expires_in
    };
}

/**
 * Get user email from access token.
 *
 * @param {string} accessToken - OAuth access token
 * @param {Object} [config]
 * @returns {Promise<string>}
 */
export async function getUserEmail(accessToken, config = OAUTH_CONFIG) {
    const response = await fetch(config.userInfoUrl, {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[OAuth] getUserEmail failed: ${response.status} ${errorText}`);
        throw new Error(`Failed to get user info: ${response.status}`);
    }

    const userInfo = await response.json();
    return userInfo.email;
}

export default {
    exchangeCode,
    refreshAccessToken,
    getUserEmail
};

