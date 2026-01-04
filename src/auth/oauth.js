/**
 * Google OAuth with PKCE for Antigravity
 *
 * Implements the same OAuth flow as opencode-antigravity-auth
 * to obtain refresh tokens for multiple Google accounts.
 * Uses a local callback server to automatically capture the auth code.
 */

import crypto from 'crypto';
import http from 'http';
import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    OAUTH_CONFIG,
    OAUTH_REDIRECT_URI
} from '../constants.js';
import { logger } from '../utils/logger.js';
import { exchangeCode, refreshAccessToken, getUserEmail } from './oauth-client.js';

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');
    return { verifier, challenge };
}

/**
 * Generate authorization URL for Google OAuth
 * Returns the URL and the PKCE verifier (needed for token exchange)
 *
 * @returns {{url: string, verifier: string, state: string}} Auth URL and PKCE data
 */
export function getAuthorizationUrl() {
    const { verifier, challenge } = generatePKCE();
    const state = crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        redirect_uri: OAUTH_REDIRECT_URI,
        response_type: 'code',
        scope: OAUTH_CONFIG.scopes.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: state
    });

    return {
        url: `${OAUTH_CONFIG.authUrl}?${params.toString()}`,
        verifier,
        state
    };
}

/**
 * Start a local server to receive the OAuth callback
 * Returns a promise that resolves with the authorization code
 *
 * @param {string} expectedState - Expected state parameter for CSRF protection
 * @param {number} timeoutMs - Timeout in milliseconds (default 120000)
 * @returns {Promise<string>} Authorization code from OAuth callback
 */
export function startCallbackServer(expectedState, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://localhost:${OAUTH_CONFIG.callbackPort}`);

            if (url.pathname !== '/oauth-callback') {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            if (error) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(`
                    <html>
                    <head><title>Authentication Failed</title></head>
                    <body style="font-family: system-ui; padding: 40px; text-align: center;">
                        <h1 style="color: #dc3545;">❌ Authentication Failed</h1>
                        <p>Error: ${error}</p>
                        <p>You can close this window.</p>
                    </body>
                    </html>
                `);
                server.close();
                reject(new Error(`OAuth error: ${error}`));
                return;
            }

            if (state !== expectedState) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(`
                    <html>
                    <head><title>Authentication Failed</title></head>
                    <body style="font-family: system-ui; padding: 40px; text-align: center;">
                        <h1 style="color: #dc3545;">❌ Authentication Failed</h1>
                        <p>State mismatch - possible CSRF attack.</p>
                        <p>You can close this window.</p>
                    </body>
                    </html>
                `);
                server.close();
                reject(new Error('State mismatch'));
                return;
            }

            if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(`
                    <html>
                    <head><title>Authentication Failed</title></head>
                    <body style="font-family: system-ui; padding: 40px; text-align: center;">
                        <h1 style="color: #dc3545;">❌ Authentication Failed</h1>
                        <p>No authorization code received.</p>
                        <p>You can close this window.</p>
                    </body>
                    </html>
                `);
                server.close();
                reject(new Error('No authorization code'));
                return;
            }

            // Success!
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
                <html>
                <head><title>Authentication Successful</title></head>
                <body style="font-family: system-ui; padding: 40px; text-align: center;">
                    <h1 style="color: #28a745;">✅ Authentication Successful!</h1>
                    <p>You can close this window and return to the terminal.</p>
                    <script>setTimeout(() => window.close(), 2000);</script>
                </body>
                </html>
            `);

            server.close();
            resolve(code);
        });

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                reject(new Error(`Port ${OAUTH_CONFIG.callbackPort} is already in use. Close any other OAuth flows and try again.`));
            } else {
                reject(err);
            }
        });

        server.listen(OAUTH_CONFIG.callbackPort, () => {
            logger.info(`[OAuth] Callback server listening on port ${OAUTH_CONFIG.callbackPort}`);
        });

        // Timeout after specified duration
        setTimeout(() => {
            server.close();
            reject(new Error('OAuth callback timeout - no response received'));
        }, timeoutMs);
    });
}

/**
 * Exchange authorization code for tokens
 *
 * @param {string} code - Authorization code from OAuth callback
 * @param {string} verifier - PKCE code verifier
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number}>} OAuth tokens
 */
export { exchangeCode, refreshAccessToken, getUserEmail };

/**
 * Discover project ID for the authenticated user
 *
 * @param {string} accessToken - OAuth access token
 * @returns {Promise<string|null>} Project ID or null if not found
 */
export async function discoverProjectId(accessToken) {
    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
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

            if (!response.ok) continue;

            const data = await response.json();

            if (typeof data.cloudaicompanionProject === 'string') {
                return data.cloudaicompanionProject;
            }
            if (data.cloudaicompanionProject?.id) {
                return data.cloudaicompanionProject.id;
            }
        } catch (error) {
            logger.warn(`[OAuth] Project discovery failed at ${endpoint}:`, error.message);
        }
    }

    return null;
}

/**
 * Complete OAuth flow: exchange code and get all account info
 *
 * @param {string} code - Authorization code from OAuth callback
 * @param {string} verifier - PKCE code verifier
 * @returns {Promise<{email: string, refreshToken: string, accessToken: string, projectId: string|null}>} Complete account info
 */
export async function completeOAuthFlow(code, verifier) {
    // Exchange code for tokens
    const tokens = await exchangeCode(code, verifier);

    // Get user email
    const email = await getUserEmail(tokens.accessToken);

    // Discover project ID
    const projectId = await discoverProjectId(tokens.accessToken);

    return {
        email,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        projectId
    };
}

export default {
    getAuthorizationUrl,
    startCallbackServer,
    exchangeCode,
    refreshAccessToken,
    getUserEmail,
    discoverProjectId,
    completeOAuthFlow
};
