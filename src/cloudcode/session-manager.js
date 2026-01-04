/**
 * Session Management for Cloud Code
 *
 * Handles session ID derivation for prompt caching continuity.
 * Session IDs are derived from the first user message to ensure
 * the same conversation uses the same session across turns.
 */

import { randomUUID, sha256Hex } from '../utils/crypto.js';

/**
 * Derive a stable session ID from the first user message in the conversation.
 * This ensures the same conversation uses the same session ID across turns,
 * enabling prompt caching (cache is scoped to session + organization).
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @returns {string} A stable session ID (32 hex characters) or random UUID if no user message
 */
export async function deriveSessionId(anthropicRequest) {
    const messages = anthropicRequest.messages || [];

    // Find the first user message
    for (const msg of messages) {
        if (msg.role === 'user') {
            let content = '';

            if (typeof msg.content === 'string') {
                content = msg.content;
            } else if (Array.isArray(msg.content)) {
                // Extract text from content blocks
                content = msg.content
                    .filter(block => block.type === 'text' && block.text)
                    .map(block => block.text)
                    .join('\n');
            }

            if (content) {
                // Hash the content with SHA256, return first 32 hex chars
                const hash = await sha256Hex(content);
                return hash.substring(0, 32);
            }
        }
    }

    // Fallback to random UUID if no user message found
    return randomUUID();
}
