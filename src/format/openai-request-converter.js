/**
 * OpenAI Request Converter
 * Converts OpenAI Chat Completions API requests to Anthropic Messages API format
 */

import { logger } from '../utils/logger.js';

/**
 * Convert OpenAI Chat Completions request to Anthropic Messages format
 *
 * @param {Object} openaiRequest - OpenAI Chat Completions format request
 * @returns {Object} Anthropic Messages format request
 */
export function convertOpenAIToAnthropic(openaiRequest) {
    const {
        model,
        messages,
        max_tokens,
        max_completion_tokens,
        temperature,
        top_p,
        stop,
        stream,
        tools,
        tool_choice,
        // OpenAI-specific params we'll map or ignore
        frequency_penalty,
        presence_penalty,
        n,
        // Extended thinking support (custom extension)
        thinking
    } = openaiRequest;

    // Extract system messages and convert to Anthropic system field
    const systemMessages = [];
    const nonSystemMessages = [];

    for (const msg of messages || []) {
        if (msg.role === 'system') {
            // Collect system message content
            if (typeof msg.content === 'string') {
                systemMessages.push(msg.content);
            } else if (Array.isArray(msg.content)) {
                // Handle content array (OpenAI format)
                for (const part of msg.content) {
                    if (part.type === 'text') {
                        systemMessages.push(part.text);
                    }
                }
            }
        } else {
            nonSystemMessages.push(msg);
        }
    }

    // Convert messages to Anthropic format
    const anthropicMessages = convertMessages(nonSystemMessages);

    // Build Anthropic request
    const anthropicRequest = {
        model: model,
        messages: anthropicMessages,
        max_tokens: max_tokens || max_completion_tokens || 4096,
        stream: stream || false
    };

    // Add system prompt if present
    if (systemMessages.length > 0) {
        anthropicRequest.system = systemMessages.join('\n\n');
    }

    // Map optional parameters
    if (temperature !== undefined) {
        anthropicRequest.temperature = temperature;
    }
    if (top_p !== undefined) {
        anthropicRequest.top_p = top_p;
    }
    if (stop) {
        anthropicRequest.stop_sequences = Array.isArray(stop) ? stop : [stop];
    }

    // Convert tools to Anthropic format
    if (tools && tools.length > 0) {
        anthropicRequest.tools = convertTools(tools);
    }

    // Convert tool_choice
    if (tool_choice) {
        anthropicRequest.tool_choice = convertToolChoice(tool_choice);
    }

    // Pass through thinking config for thinking models
    if (thinking) {
        anthropicRequest.thinking = thinking;
    }

    // Log ignored parameters
    if (frequency_penalty || presence_penalty) {
        logger.debug('[OpenAIConverter] Ignoring frequency_penalty/presence_penalty (not supported)');
    }
    if (n && n > 1) {
        logger.debug('[OpenAIConverter] Ignoring n > 1 (only single completion supported)');
    }

    return anthropicRequest;
}

/**
 * Convert OpenAI messages to Anthropic format
 * @param {Array} messages - OpenAI format messages
 * @returns {Array} Anthropic format messages
 */
function convertMessages(messages) {
    const result = [];

    for (const msg of messages) {
        const anthropicMsg = {
            role: msg.role === 'assistant' ? 'assistant' : 'user'
        };

        // Handle tool role (convert to user with tool_result)
        if (msg.role === 'tool') {
            anthropicMsg.role = 'user';
            anthropicMsg.content = [{
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
            }];
            result.push(anthropicMsg);
            continue;
        }

        // Handle assistant messages with tool_calls
        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
            const contentBlocks = [];

            // Add text content first if present
            if (msg.content) {
                if (typeof msg.content === 'string' && msg.content.trim()) {
                    contentBlocks.push({ type: 'text', text: msg.content });
                } else if (Array.isArray(msg.content)) {
                    for (const part of msg.content) {
                        if (part.type === 'text' && part.text?.trim()) {
                            contentBlocks.push({ type: 'text', text: part.text });
                        }
                    }
                }
            }

            // Convert tool_calls to tool_use blocks
            for (const toolCall of msg.tool_calls) {
                if (toolCall.type === 'function') {
                    let args = {};
                    try {
                        args = typeof toolCall.function.arguments === 'string'
                            ? JSON.parse(toolCall.function.arguments)
                            : toolCall.function.arguments || {};
                    } catch (e) {
                        logger.warn('[OpenAIConverter] Failed to parse tool arguments:', e.message);
                        args = { raw: toolCall.function.arguments };
                    }

                    contentBlocks.push({
                        type: 'tool_use',
                        id: toolCall.id,
                        name: toolCall.function.name,
                        input: args
                    });
                }
            }

            anthropicMsg.content = contentBlocks;
            result.push(anthropicMsg);
            continue;
        }

        // Handle regular content
        if (typeof msg.content === 'string') {
            anthropicMsg.content = msg.content;
        } else if (Array.isArray(msg.content)) {
            // Convert OpenAI content array to Anthropic format
            anthropicMsg.content = convertContentArray(msg.content);
        } else if (msg.content === null && msg.role === 'assistant') {
            // Assistant message with no content (possible with tool_calls only)
            anthropicMsg.content = [];
        } else {
            anthropicMsg.content = '';
        }

        result.push(anthropicMsg);
    }

    return result;
}

/**
 * Convert OpenAI content array to Anthropic format
 * @param {Array} contentArray - OpenAI content parts
 * @returns {Array} Anthropic content blocks
 */
function convertContentArray(contentArray) {
    const blocks = [];

    for (const part of contentArray) {
        if (part.type === 'text') {
            blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
            // Convert OpenAI image_url to Anthropic image format
            const imageUrl = part.image_url?.url || '';

            if (imageUrl.startsWith('data:')) {
                // Base64 encoded image
                const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                    blocks.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: match[1],
                            data: match[2]
                        }
                    });
                }
            } else {
                // URL reference
                blocks.push({
                    type: 'image',
                    source: {
                        type: 'url',
                        url: imageUrl
                    }
                });
            }
        }
    }

    return blocks;
}

/**
 * Convert OpenAI tools to Anthropic format
 * @param {Array} tools - OpenAI tool definitions
 * @returns {Array} Anthropic tool definitions
 */
function convertTools(tools) {
    return tools.map(tool => {
        if (tool.type === 'function') {
            return {
                name: tool.function.name,
                description: tool.function.description || '',
                input_schema: tool.function.parameters || { type: 'object' }
            };
        }
        // Handle other tool types if needed
        return {
            name: tool.name || 'unknown',
            description: tool.description || '',
            input_schema: tool.parameters || tool.input_schema || { type: 'object' }
        };
    });
}

/**
 * Convert OpenAI tool_choice to Anthropic format
 * @param {string|Object} toolChoice - OpenAI tool_choice
 * @returns {Object} Anthropic tool_choice
 */
function convertToolChoice(toolChoice) {
    if (typeof toolChoice === 'string') {
        switch (toolChoice) {
            case 'none':
                return { type: 'none' };
            case 'auto':
                return { type: 'auto' };
            case 'required':
                return { type: 'any' };
            default:
                return { type: 'auto' };
        }
    }

    if (toolChoice?.type === 'function' && toolChoice?.function?.name) {
        return {
            type: 'tool',
            name: toolChoice.function.name
        };
    }

    return { type: 'auto' };
}

