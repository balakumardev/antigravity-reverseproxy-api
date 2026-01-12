/**
 * OpenAI Response Converter
 * Converts Anthropic Messages API responses to OpenAI Chat Completions format
 */

import { randomHex } from '../utils/crypto.js';

/**
 * Convert Anthropic response to OpenAI Chat Completions format
 *
 * @param {Object} anthropicResponse - Anthropic Messages API response
 * @param {string} model - The model name
 * @returns {Object} OpenAI Chat Completions format response
 */
export function convertAnthropicToOpenAI(anthropicResponse, model) {
    const { id, content, stop_reason, usage } = anthropicResponse;

    // Convert content blocks to OpenAI format
    const { message, toolCalls } = convertContentBlocks(content || []);

    // Map stop reason
    const finishReason = mapStopReason(stop_reason, toolCalls.length > 0);

    // Build the response message
    const responseMessage = {
        role: 'assistant',
        content: message || null
    };

    // Add tool_calls if present
    if (toolCalls.length > 0) {
        responseMessage.tool_calls = toolCalls;
        // OpenAI: content is null when there are tool_calls (unless there's actual text)
        if (!message) {
            responseMessage.content = null;
        }
    }

    return {
        id: `chatcmpl-${id?.replace('msg_', '') || randomHex(16)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: responseMessage,
            finish_reason: finishReason
        }],
        usage: {
            prompt_tokens: (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0),
            completion_tokens: usage?.output_tokens || 0,
            total_tokens: (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.output_tokens || 0)
        }
    };
}

/**
 * Convert Anthropic content blocks to OpenAI message format
 * @param {Array} contentBlocks - Anthropic content blocks
 * @returns {Object} { message: string|null, toolCalls: Array }
 */
function convertContentBlocks(contentBlocks) {
    const textParts = [];
    const toolCalls = [];

    for (const block of contentBlocks) {
        if (block.type === 'text') {
            textParts.push(block.text);
        } else if (block.type === 'thinking') {
            // Include thinking as text with a prefix for visibility
            // Some clients may want to see the thinking process
            textParts.push(`<thinking>\n${block.thinking}\n</thinking>`);
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input || {})
                }
            });
        }
    }

    return {
        message: textParts.length > 0 ? textParts.join('\n') : null,
        toolCalls
    };
}

/**
 * Map Anthropic stop reason to OpenAI finish reason
 * @param {string} stopReason - Anthropic stop reason
 * @param {boolean} hasToolCalls - Whether response has tool calls
 * @returns {string} OpenAI finish reason
 */
function mapStopReason(stopReason, hasToolCalls) {
    if (hasToolCalls || stopReason === 'tool_use') {
        return 'tool_calls';
    }

    switch (stopReason) {
        case 'end_turn':
            return 'stop';
        case 'max_tokens':
            return 'length';
        case 'stop_sequence':
            return 'stop';
        default:
            return 'stop';
    }
}

/**
 * Generator that converts Anthropic SSE events to OpenAI streaming format
 *
 * @param {AsyncGenerator} anthropicStream - Generator yielding Anthropic SSE events
 * @param {string} model - The model name
 * @yields {string} OpenAI SSE formatted strings (ready to write to response)
 */
export async function* convertStreamToOpenAI(anthropicStream, model) {
    const chatId = `chatcmpl-${randomHex(16)}`;
    const created = Math.floor(Date.now() / 1000);

    let currentToolCallIndex = -1;
    let emittedRole = false;
    let inThinking = false;

    for await (const event of anthropicStream) {
        switch (event.type) {
            case 'message_start': {
                // Emit initial chunk with role
                yield formatSSE({
                    id: chatId,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [{
                        index: 0,
                        delta: { role: 'assistant', content: '' },
                        finish_reason: null
                    }]
                });
                emittedRole = true;
                break;
            }

            case 'content_block_start': {
                const block = event.content_block;
                if (block?.type === 'thinking') {
                    inThinking = true;
                    // Start thinking block with tag
                    yield formatSSE({
                        id: chatId,
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        choices: [{
                            index: 0,
                            delta: { content: '<thinking>\n' },
                            finish_reason: null
                        }]
                    });
                } else if (block?.type === 'tool_use') {
                    currentToolCallIndex++;
                    // Emit tool call start
                    yield formatSSE({
                        id: chatId,
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: [{
                                    index: currentToolCallIndex,
                                    id: block.id,
                                    type: 'function',
                                    function: {
                                        name: block.name,
                                        arguments: ''
                                    }
                                }]
                            },
                            finish_reason: null
                        }]
                    });
                }
                break;
            }

            case 'content_block_delta': {
                const delta = event.delta;

                if (delta?.type === 'thinking_delta') {
                    // Stream thinking content
                    yield formatSSE({
                        id: chatId,
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        choices: [{
                            index: 0,
                            delta: { content: delta.thinking },
                            finish_reason: null
                        }]
                    });
                } else if (delta?.type === 'text_delta') {
                    // Stream text content
                    yield formatSSE({
                        id: chatId,
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        choices: [{
                            index: 0,
                            delta: { content: delta.text },
                            finish_reason: null
                        }]
                    });
                } else if (delta?.type === 'input_json_delta') {
                    // Stream tool call arguments
                    yield formatSSE({
                        id: chatId,
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: [{
                                    index: currentToolCallIndex,
                                    function: {
                                        arguments: delta.partial_json
                                    }
                                }]
                            },
                            finish_reason: null
                        }]
                    });
                }
                // Ignore signature_delta - not relevant for OpenAI format
                break;
            }

            case 'content_block_stop': {
                if (inThinking) {
                    // Close thinking block
                    yield formatSSE({
                        id: chatId,
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        choices: [{
                            index: 0,
                            delta: { content: '\n</thinking>\n' },
                            finish_reason: null
                        }]
                    });
                    inThinking = false;
                }
                break;
            }

            case 'message_delta': {
                // Final chunk with finish reason
                const finishReason = mapStopReason(
                    event.delta?.stop_reason,
                    currentToolCallIndex >= 0
                );

                yield formatSSE({
                    id: chatId,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: finishReason
                    }],
                    usage: event.usage ? {
                        prompt_tokens: 0, // Not available in delta
                        completion_tokens: event.usage.output_tokens || 0,
                        total_tokens: event.usage.output_tokens || 0
                    } : undefined
                });
                break;
            }

            case 'message_stop': {
                // Emit [DONE] marker
                yield 'data: [DONE]\n\n';
                break;
            }

            case 'error': {
                // Convert error to OpenAI format
                yield formatSSE({
                    id: chatId,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: 'stop'
                    }],
                    error: {
                        message: event.error?.message || 'Unknown error',
                        type: event.error?.type || 'api_error'
                    }
                });
                yield 'data: [DONE]\n\n';
                break;
            }
        }
    }
}

/**
 * Format an object as SSE data line
 * @param {Object} data - Data to format
 * @returns {string} SSE formatted string
 */
function formatSSE(data) {
    return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Convert OpenAI error format to match their API
 * @param {Object} error - Error object with type and message
 * @returns {Object} OpenAI-formatted error response
 */
export function formatOpenAIError(error) {
    return {
        error: {
            message: error.message || 'An error occurred',
            type: error.type || 'api_error',
            param: null,
            code: error.code || null
        }
    };
}



