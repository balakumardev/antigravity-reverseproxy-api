import { refreshAccessToken } from '../../src/auth/oauth-client.js';
import { discoverProject } from '../../src/account-manager/project-discovery.js';
import {
    clearExpiredLimits as clearLimits,
    getAvailableAccounts as getAvailable,
    getInvalidAccounts as getInvalid,
    getMinWaitTimeMs as getMinWait,
    isAllRateLimited as checkAllRateLimited,
    markInvalid as markAccountInvalid,
    markRateLimited as markLimited,
    resetAllRateLimits as resetLimits
} from '../../src/account-manager/rate-limits.js';
import {
    getCurrentStickyAccount as getSticky,
    pickNext as selectNext,
    pickStickyAccount as selectSticky,
    shouldWaitForCurrentAccount as shouldWait
} from '../../src/account-manager/selection.js';
import { TOKEN_REFRESH_INTERVAL_MS } from '../../src/constants/shared.js';
import { logger } from '../../src/utils/logger.js';
import { isNetworkError } from '../../src/utils/helpers.js';

function parseAccountsFromEnv(env) {
    const rawConfig = env.ACCOUNTS_JSON || env.ACCOUNTS;

    if (rawConfig) {
        let parsed;
        try {
            parsed = JSON.parse(rawConfig);
        } catch (error) {
            throw new Error(`Invalid ACCOUNTS_JSON: ${error.message}`);
        }

        const config = Array.isArray(parsed) ? { accounts: parsed } : parsed;
        const accounts = Array.isArray(config.accounts) ? config.accounts : [];

        return {
            accounts,
            settings: config.settings || {},
            activeIndex: config.activeIndex || 0
        };
    }

    if (env.ACCOUNT_REFRESH_TOKEN) {
        return {
            accounts: [
                {
                    email: env.ACCOUNT_EMAIL || 'default@oauth',
                    source: 'oauth',
                    refreshToken: env.ACCOUNT_REFRESH_TOKEN,
                    projectId: env.ACCOUNT_PROJECT_ID || undefined,
                    addedAt: new Date().toISOString(),
                    lastUsed: null,
                    modelRateLimits: {}
                }
            ],
            settings: {},
            activeIndex: 0
        };
    }

    if (env.ACCOUNT_API_KEY) {
        return {
            accounts: [
                {
                    email: env.ACCOUNT_EMAIL || 'default@manual',
                    source: 'manual',
                    apiKey: env.ACCOUNT_API_KEY,
                    projectId: env.ACCOUNT_PROJECT_ID || undefined,
                    addedAt: new Date().toISOString(),
                    lastUsed: null,
                    modelRateLimits: {}
                }
            ],
            settings: {},
            activeIndex: 0
        };
    }

    return { accounts: [], settings: {}, activeIndex: 0 };
}

function normalizeAccounts(accounts) {
    return accounts.map((acc, index) => ({
        email: acc.email || `account-${index}@unknown`,
        source: acc.source || (acc.refreshToken ? 'oauth' : (acc.apiKey ? 'manual' : 'oauth')),
        refreshToken: acc.refreshToken,
        apiKey: acc.apiKey,
        projectId: acc.projectId,
        addedAt: acc.addedAt || new Date().toISOString(),
        lastUsed: acc.lastUsed || null,
        modelRateLimits: acc.modelRateLimits || {},
        // Give accounts a fresh chance on cold start
        isInvalid: false,
        invalidReason: null
    }));
}

export class WorkerAccountManager {
    #accounts = [];
    #currentIndex = 0;
    #settings = {};
    #initialized = false;

    #tokenCache = new Map(); // email -> { token, extractedAt }
    #projectCache = new Map(); // email -> projectId

    async initialize(env) {
        if (this.#initialized) return;

        const { accounts, settings, activeIndex } = parseAccountsFromEnv(env);
        this.#accounts = normalizeAccounts(accounts);
        this.#settings = settings || {};
        this.#currentIndex = activeIndex || 0;

        if (this.#accounts.length === 0) {
            throw new Error('No accounts configured. Set ACCOUNTS_JSON (recommended) or ACCOUNT_REFRESH_TOKEN.');
        }

        // Clamp
        if (this.#currentIndex >= this.#accounts.length) {
            this.#currentIndex = 0;
        }

        this.clearExpiredLimits();
        this.#initialized = true;
        logger.success(`[WorkerAccountManager] Loaded ${this.#accounts.length} account(s)`);
    }

    getAccountCount() {
        return this.#accounts.length;
    }

    getAllAccounts() {
        return this.#accounts;
    }

    clearExpiredLimits() {
        return clearLimits(this.#accounts);
    }

    resetAllRateLimits() {
        resetLimits(this.#accounts);
    }

    isAllRateLimited(modelId = null) {
        return checkAllRateLimited(this.#accounts, modelId);
    }

    getMinWaitTimeMs(modelId = null) {
        return getMinWait(this.#accounts, modelId);
    }

    getAvailableAccounts(modelId = null) {
        return getAvailable(this.#accounts, modelId);
    }

    getInvalidAccounts() {
        return getInvalid(this.#accounts);
    }

    pickNext(modelId = null) {
        const { account, newIndex } = selectNext(this.#accounts, this.#currentIndex, null, modelId);
        this.#currentIndex = newIndex;
        return account;
    }

    getCurrentStickyAccount(modelId = null) {
        const { account, newIndex } = getSticky(this.#accounts, this.#currentIndex, null, modelId);
        this.#currentIndex = newIndex;
        return account;
    }

    shouldWaitForCurrentAccount(modelId = null) {
        return shouldWait(this.#accounts, this.#currentIndex, modelId);
    }

    pickStickyAccount(modelId = null) {
        const { account, waitMs, newIndex } = selectSticky(this.#accounts, this.#currentIndex, null, modelId);
        this.#currentIndex = newIndex;
        return { account, waitMs };
    }

    markRateLimited(email, resetMs = null, modelId = null) {
        markLimited(this.#accounts, email, resetMs, this.#settings, modelId);
    }

    markInvalid(email, reason = 'Unknown error') {
        markAccountInvalid(this.#accounts, email, reason);
    }

    clearTokenCache(email = null) {
        if (email) this.#tokenCache.delete(email);
        else this.#tokenCache.clear();
    }

    clearProjectCache(email = null) {
        if (email) this.#projectCache.delete(email);
        else this.#projectCache.clear();
    }

    async getTokenForAccount(account) {
        const cached = this.#tokenCache.get(account.email);
        if (cached && (Date.now() - cached.extractedAt) < TOKEN_REFRESH_INTERVAL_MS) {
            return cached.token;
        }

        let token;
        if (account.source === 'oauth' && account.refreshToken) {
            try {
                const tokens = await refreshAccessToken(account.refreshToken);
                token = tokens.accessToken;

                // Handle refresh token rotation (Google may issue new refresh tokens)
                if (tokens.refreshToken && tokens.refreshToken !== account.refreshToken) {
                    logger.warn(`[WorkerAccountManager] Refresh token rotated for ${account.email}. ` +
                        `UPDATE ACCOUNTS_JSON secret with new token to avoid future auth failures.`);
                    // Update in-memory for this instance's lifetime
                    account.refreshToken = tokens.refreshToken;
                }

                if (account.isInvalid) {
                    account.isInvalid = false;
                    account.invalidReason = null;
                }
            } catch (error) {
                if (isNetworkError(error)) {
                    throw new Error(`AUTH_NETWORK_ERROR: ${error.message}`);
                }
                this.markInvalid(account.email, error.message);
                throw new Error(`AUTH_INVALID: ${account.email}: ${error.message}`);
            }
        } else if (account.source === 'manual' && account.apiKey) {
            token = account.apiKey;
        } else {
            this.markInvalid(account.email, 'Unsupported account source in Workers (use OAuth or manual API key)');
            throw new Error(`AUTH_INVALID: ${account.email}: unsupported account source`);
        }

        this.#tokenCache.set(account.email, { token, extractedAt: Date.now() });
        return token;
    }

    async getProjectForAccount(account, token) {
        const cached = this.#projectCache.get(account.email);
        if (cached) return cached;

        if (account.projectId) {
            this.#projectCache.set(account.email, account.projectId);
            return account.projectId;
        }

        const projectId = await discoverProject(token);
        this.#projectCache.set(account.email, projectId);
        return projectId;
    }

    getStatus() {
        const available = this.getAvailableAccounts();
        const invalid = this.getInvalidAccounts();

        const rateLimited = this.#accounts.filter(a => {
            if (!a.modelRateLimits) return false;
            return Object.values(a.modelRateLimits).some(
                limit => limit.isRateLimited && limit.resetTime > Date.now()
            );
        });

        return {
            total: this.#accounts.length,
            available: available.length,
            rateLimited: rateLimited.length,
            invalid: invalid.length,
            summary: `${this.#accounts.length} total, ${available.length} available, ${rateLimited.length} rate-limited, ${invalid.length} invalid`,
            accounts: this.#accounts.map(a => ({
                email: a.email,
                source: a.source,
                modelRateLimits: a.modelRateLimits || {},
                isInvalid: a.isInvalid || false,
                invalidReason: a.invalidReason || null,
                lastUsed: a.lastUsed
            }))
        };
    }
}

export default WorkerAccountManager;

