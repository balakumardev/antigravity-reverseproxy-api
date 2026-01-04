import { sendMessage, sendMessageStream, listModels, getModelQuotas } from '../../src/cloudcode/index.js';
import { formatDuration } from '../../src/utils/helpers.js';
import { logger } from '../../src/utils/logger.js';
import { WorkerAccountManager } from './account-manager.js';
import { convertOpenAIToAnthropic } from '../../src/format/openai-request-converter.js';
import { convertAnthropicToOpenAI, convertStreamToOpenAI, formatOpenAIError } from '../../src/format/openai-response-converter.js';

let accountManager = null;
let initError = null;
let initPromise = null;

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Max-Age': '86400'
    };
}

function jsonResponse(data, init = {}) {
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        ...corsHeaders(),
        ...(init.headers || {})
    };
    return new Response(JSON.stringify(data), { ...init, headers });
}

function textResponse(text, init = {}) {
    const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        ...corsHeaders(),
        ...(init.headers || {})
    };
    return new Response(text, { ...init, headers });
}

function parseError(error) {
    let errorType = 'api_error';
    let statusCode = 500;
    let errorMessage = error.message || String(error);

    if (errorMessage.includes('401') || errorMessage.includes('UNAUTHENTICATED')) {
        errorType = 'authentication_error';
        statusCode = 401;
        errorMessage = 'Authentication failed. Make sure your Google account tokens are valid.';
    } else if (errorMessage.includes('429') || errorMessage.includes('RESOURCE_EXHAUSTED') || errorMessage.includes('QUOTA_EXHAUSTED')) {
        errorType = 'invalid_request_error';
        statusCode = 400; // force clients not to retry

        const resetMatch = errorMessage.match(/quota will reset after ([\\dh\\dm\\ds]+)/i);
        const modelMatch = errorMessage.match(/Rate limited on ([^.]+)\\./) || errorMessage.match(/\"model\":\\s*\"([^\"]+)\"/);
        const model = modelMatch ? modelMatch[1] : 'the model';

        if (resetMatch) {
            errorMessage = `You have exhausted your capacity on ${model}. Quota will reset after ${resetMatch[1]}.`;
        } else {
            errorMessage = `You have exhausted your capacity on ${model}. Please wait for your quota to reset.`;
        }
    } else if (errorMessage.includes('invalid_request_error') || errorMessage.includes('INVALID_ARGUMENT')) {
        errorType = 'invalid_request_error';
        statusCode = 400;
        const msgMatch = errorMessage.match(/\"message\":\"([^\"]+)\"/);
        if (msgMatch) errorMessage = msgMatch[1];
    } else if (errorMessage.includes('All endpoints failed')) {
        errorType = 'api_error';
        statusCode = 503;
        errorMessage = 'Unable to connect to Cloud Code API.';
    } else if (errorMessage.includes('PERMISSION_DENIED')) {
        errorType = 'permission_error';
        statusCode = 403;
        errorMessage = 'Permission denied. Check your Antigravity/Gemini Code Assist access.';
    }

    return { errorType, statusCode, errorMessage };
}

async function ensureInitialized(env) {
    if (accountManager) return;
    if (initError) throw initError;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        const debug = env.DEBUG === 'true';
        logger.setDebug(debug);

        const mgr = new WorkerAccountManager();
        await mgr.initialize(env);
        accountManager = mgr;
    })().catch((e) => {
        initError = e;
        initPromise = null;
        throw e;
    });

    return initPromise;
}

async function handleHealth() {
    const start = Date.now();
    const status = accountManager.getStatus();
    const allAccounts = accountManager.getAllAccounts();

    const accountDetails = await Promise.allSettled(
        allAccounts.map(async (account) => {
            const activeModelLimits = Object.entries(account.modelRateLimits || {})
                .filter(([_, limit]) => limit.isRateLimited && limit.resetTime > Date.now());
            const isRateLimited = activeModelLimits.length > 0;
            const soonestReset = activeModelLimits.length > 0
                ? Math.min(...activeModelLimits.map(([_, l]) => l.resetTime))
                : null;

            const baseInfo = {
                email: account.email,
                lastUsed: account.lastUsed ? new Date(account.lastUsed).toISOString() : null,
                modelRateLimits: account.modelRateLimits || {},
                rateLimitCooldownRemaining: soonestReset ? Math.max(0, soonestReset - Date.now()) : 0
            };

            if (account.isInvalid) {
                return { ...baseInfo, status: 'invalid', error: account.invalidReason, models: {} };
            }

            try {
                const token = await accountManager.getTokenForAccount(account);
                const quotas = await getModelQuotas(token);

                const formattedQuotas = {};
                for (const [modelId, info] of Object.entries(quotas)) {
                    formattedQuotas[modelId] = {
                        remaining: info.remainingFraction !== null ? `${Math.round(info.remainingFraction * 100)}%` : 'N/A',
                        remainingFraction: info.remainingFraction,
                        resetTime: info.resetTime || null
                    };
                }

                return {
                    ...baseInfo,
                    status: isRateLimited ? 'rate-limited' : 'ok',
                    models: formattedQuotas
                };
            } catch (error) {
                return { ...baseInfo, status: 'error', error: error.message, models: {} };
            }
        })
    );

    const detailedAccounts = accountDetails.map((result, index) => {
        if (result.status === 'fulfilled') return result.value;
        const acc = allAccounts[index];
        return { email: acc.email, status: 'error', error: result.reason?.message || 'Unknown error', modelRateLimits: acc.modelRateLimits || {} };
    });

    return jsonResponse({
        status: 'ok',
        timestamp: new Date().toISOString(),
        latencyMs: Date.now() - start,
        summary: status.summary,
        counts: {
            total: status.total,
            available: status.available,
            rateLimited: status.rateLimited,
            invalid: status.invalid
        },
        accounts: detailedAccounts
    });
}

async function handleAccountLimits(url) {
    const allAccounts = accountManager.getAllAccounts();
    const format = url.searchParams.get('format') || 'json';

    const results = await Promise.allSettled(
        allAccounts.map(async (account) => {
            if (account.isInvalid) {
                return { email: account.email, status: 'invalid', error: account.invalidReason, models: {} };
            }

            try {
                const token = await accountManager.getTokenForAccount(account);
                const quotas = await getModelQuotas(token);
                return { email: account.email, status: 'ok', models: quotas };
            } catch (error) {
                return { email: account.email, status: 'error', error: error.message, models: {} };
            }
        })
    );

    const accountLimits = results.map((result, index) => {
        if (result.status === 'fulfilled') return result.value;
        return { email: allAccounts[index].email, status: 'error', error: result.reason?.message || 'Unknown error', models: {} };
    });

    const allModelIds = new Set();
    for (const account of accountLimits) {
        for (const modelId of Object.keys(account.models || {})) allModelIds.add(modelId);
    }
    const sortedModels = Array.from(allModelIds).sort();

    if (format === 'table') {
        const lines = [];
        const timestamp = new Date().toLocaleString();
        lines.push(`Account Limits (${timestamp})`);

        const status = accountManager.getStatus();
        lines.push(`Accounts: ${status.total} total, ${status.available} available, ${status.rateLimited} rate-limited, ${status.invalid} invalid`);
        lines.push('');

        const accColWidth = 25;
        const statusColWidth = 15;
        const lastUsedColWidth = 25;
        const resetColWidth = 25;

        let accHeader = 'Account'.padEnd(accColWidth) + 'Status'.padEnd(statusColWidth) + 'Last Used'.padEnd(lastUsedColWidth) + 'Quota Reset';
        lines.push(accHeader);
        lines.push('─'.repeat(accColWidth + statusColWidth + lastUsedColWidth + resetColWidth));

        for (const acc of status.accounts) {
            const shortEmail = acc.email.split('@')[0].slice(0, 22);
            const lastUsed = acc.lastUsed ? new Date(acc.lastUsed).toLocaleString() : 'never';

            const accLimit = accountLimits.find(a => a.email === acc.email);
            let accStatus;
            if (acc.isInvalid) {
                accStatus = 'invalid';
            } else if (accLimit?.status === 'error') {
                accStatus = 'error';
            } else {
                const models = accLimit?.models || {};
                const modelCount = Object.keys(models).length;
                const exhaustedCount = Object.values(models).filter(
                    q => q.remainingFraction === 0 || q.remainingFraction === null
                ).length;

                if (exhaustedCount === 0) accStatus = 'ok';
                else accStatus = `(${exhaustedCount}/${modelCount}) limited`;
            }

            const claudeModel = sortedModels.find(m => m.includes('claude'));
            const quota = claudeModel && accLimit?.models?.[claudeModel];
            const resetTime = quota?.resetTime ? new Date(quota.resetTime).toLocaleString() : '-';

            let row = shortEmail.padEnd(accColWidth) + accStatus.padEnd(statusColWidth) + lastUsed.padEnd(lastUsedColWidth) + resetTime;

            if (accLimit?.error) {
                lines.push(row);
                lines.push('  └─ ' + accLimit.error);
            } else {
                lines.push(row);
            }
        }

        lines.push('');

        const modelColWidth = Math.max(28, ...sortedModels.map(m => m.length)) + 2;
        const accountColWidth = 30;

        let header = 'Model'.padEnd(modelColWidth);
        for (const acc of accountLimits) {
            const shortEmail = acc.email.split('@')[0].slice(0, 26);
            header += shortEmail.padEnd(accountColWidth);
        }
        lines.push(header);
        lines.push('─'.repeat(modelColWidth + accountLimits.length * accountColWidth));

        for (const modelId of sortedModels) {
            let row = modelId.padEnd(modelColWidth);
            for (const acc of accountLimits) {
                const quota = acc.models?.[modelId];
                let cell;
                if (acc.status !== 'ok' && acc.status !== 'rate-limited') {
                    cell = `[${acc.status}]`;
                } else if (!quota) {
                    cell = '-';
                } else if (quota.remainingFraction === 0 || quota.remainingFraction === null) {
                    if (quota.resetTime) {
                        const resetMs = new Date(quota.resetTime).getTime() - Date.now();
                        if (resetMs > 0) cell = `0% (wait ${formatDuration(resetMs)})`;
                        else cell = '0% (resetting...)';
                    } else {
                        cell = '0% (exhausted)';
                    }
                } else {
                    const pct = Math.round(quota.remainingFraction * 100);
                    cell = `${pct}%`;
                }
                row += cell.padEnd(accountColWidth);
            }
            lines.push(row);
        }

        return textResponse(lines.join('\n'));
    }

    return jsonResponse({
        timestamp: new Date().toLocaleString(),
        totalAccounts: allAccounts.length,
        models: sortedModels,
        accounts: accountLimits.map(acc => ({
            email: acc.email,
            status: acc.status,
            error: acc.error || null,
            limits: Object.fromEntries(
                sortedModels.map(modelId => {
                    const quota = acc.models?.[modelId];
                    if (!quota) return [modelId, null];
                    return [modelId, {
                        remaining: quota.remainingFraction !== null
                            ? `${Math.round(quota.remainingFraction * 100)}%`
                            : 'N/A',
                        remainingFraction: quota.remainingFraction,
                        resetTime: quota.resetTime || null
                    }];
                })
            )
        }))
    });
}

async function handleRefreshToken() {
    accountManager.clearTokenCache();
    accountManager.clearProjectCache();

    // Try to fetch a fresh token (best-effort)
    const first = accountManager.getAvailableAccounts()[0];
    let tokenPrefix = null;
    if (first) {
        try {
            const token = await accountManager.getTokenForAccount(first);
            tokenPrefix = token.substring(0, 10) + '...';
        } catch {
            // ignore
        }
    }

    return jsonResponse({
        status: 'ok',
        message: 'Token caches cleared',
        tokenPrefix
    });
}

async function handleModels() {
    const account = accountManager.pickNext();
    if (!account) {
        return jsonResponse({
            type: 'error',
            error: { type: 'api_error', message: 'No accounts available' }
        }, { status: 503 });
    }

    const token = await accountManager.getTokenForAccount(account);
    const models = await listModels(token);
    return jsonResponse(models);
}

async function handleMessages(request, env) {
    const body = await request.json();
    const {
        model,
        messages,
        max_tokens,
        stream,
        system,
        tools,
        tool_choice,
        thinking,
        top_p,
        top_k,
        temperature
    } = body || {};

    const modelId = model || 'claude-3-5-sonnet-20241022';
    if (accountManager.isAllRateLimited(modelId)) {
        logger.warn(`[Worker] All accounts rate-limited for ${modelId}. Resetting state for optimistic retry.`);
        accountManager.resetAllRateLimits();
    }

    if (!messages || !Array.isArray(messages)) {
        return jsonResponse({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'messages is required and must be an array' }
        }, { status: 400 });
    }

    const proxyRequest = {
        model: modelId,
        messages,
        max_tokens: max_tokens || 4096,
        stream,
        system,
        tools,
        tool_choice,
        thinking,
        top_p,
        top_k,
        temperature
    };

    const fallbackEnabled = env.FALLBACK === 'true';

    if (stream) {
        const encoder = new TextEncoder();
        const streamBody = new ReadableStream({
            async start(controller) {
                try {
                    for await (const event of sendMessageStream(proxyRequest, accountManager, fallbackEnabled)) {
                        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
                    }
                    controller.close();
                } catch (streamError) {
                    const { errorType, errorMessage } = parseError(streamError);
                    controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
                        type: 'error',
                        error: { type: errorType, message: errorMessage }
                    })}\n\n`));
                    controller.close();
                }
            }
        });

        return new Response(streamBody, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                ...corsHeaders()
            }
        });
    }

    const response = await sendMessage(proxyRequest, accountManager, fallbackEnabled);
    return jsonResponse(response);
}

async function handleChatCompletions(request, env) {
    const body = await request.json();

    // Convert OpenAI request to Anthropic format
    const anthropicRequest = convertOpenAIToAnthropic(body);
    const model = anthropicRequest.model;
    const stream = anthropicRequest.stream;

    // Optimistic Retry: If ALL accounts are rate-limited for this model, reset them
    if (accountManager.isAllRateLimited(model)) {
        logger.warn(`[Worker] All accounts rate-limited for ${model}. Resetting state for optimistic retry.`);
        accountManager.resetAllRateLimits();
    }

    if (!anthropicRequest.messages || !Array.isArray(anthropicRequest.messages)) {
        return jsonResponse(formatOpenAIError({
            message: 'messages is required and must be an array',
            type: 'invalid_request_error'
        }), { status: 400 });
    }

    logger.info(`[Worker/OpenAI] Request for model: ${model}, stream: ${!!stream}`);

    const fallbackEnabled = env.FALLBACK === 'true';

    if (stream) {
        const encoder = new TextEncoder();
        const streamBody = new ReadableStream({
            async start(controller) {
                try {
                    // Get the Anthropic stream generator
                    const anthropicStream = sendMessageStream(anthropicRequest, accountManager, fallbackEnabled);

                    // Convert to OpenAI format and stream
                    for await (const chunk of convertStreamToOpenAI(anthropicStream, model)) {
                        controller.enqueue(encoder.encode(chunk));
                    }
                    controller.close();
                } catch (streamError) {
                    const { errorMessage } = parseError(streamError);
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                        error: { message: errorMessage, type: 'api_error' }
                    })}\n\n`));
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                }
            }
        });

        return new Response(streamBody, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                ...corsHeaders()
            }
        });
    }

    // Non-streaming
    const anthropicResponse = await sendMessage(anthropicRequest, accountManager, fallbackEnabled);
    const openaiResponse = convertAnthropicToOpenAI(anthropicResponse, model);
    return jsonResponse(openaiResponse);
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders() });
        }

        const url = new URL(request.url);

        try {
            await ensureInitialized(env);

            // Basic request logging (skip noisy event logging endpoint)
            if (url.pathname !== '/api/event_logging/batch') {
                logger.info(`[${request.method}] ${url.pathname}`);
            } else if (logger.isDebugEnabled) {
                logger.debug(`[${request.method}] ${url.pathname}`);
            }

            if (request.method === 'GET' && url.pathname === '/health') {
                return await handleHealth();
            }

            if (request.method === 'GET' && url.pathname === '/account-limits') {
                return await handleAccountLimits(url);
            }

            if (request.method === 'POST' && url.pathname === '/refresh-token') {
                return await handleRefreshToken();
            }

            if (request.method === 'GET' && url.pathname === '/v1/models') {
                return await handleModels();
            }

            if (request.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
                return jsonResponse({
                    type: 'error',
                    error: {
                        type: 'not_implemented',
                        message: 'Token counting is not implemented. Use /v1/messages with max_tokens or configure your client to skip token counting.'
                    }
                }, { status: 501 });
            }

            if (request.method === 'POST' && url.pathname === '/v1/messages') {
                return await handleMessages(request, env);
            }

            if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
                return await handleChatCompletions(request, env);
            }

            return jsonResponse({
                type: 'error',
                error: { type: 'not_found_error', message: `Endpoint ${request.method} ${url.pathname} not found` }
            }, { status: 404 });
        } catch (error) {
            logger.error('[Worker] Error:', error.message || error);
            const { errorType, statusCode, errorMessage } = parseError(error);
            return jsonResponse({
                type: 'error',
                error: { type: errorType, message: errorMessage }
            }, { status: statusCode });
        }
    }
};

