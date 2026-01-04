/**
 * Crypto utilities (runtime-agnostic)
 *
 * Uses Web Crypto APIs when available (Node 18+ and Cloudflare Workers).
 * Falls back to Node's `crypto` module only when needed.
 */

function getWebCrypto() {
    if (globalThis.crypto && (globalThis.crypto.getRandomValues || globalThis.crypto.subtle)) {
        return globalThis.crypto;
    }
    return null;
}

function bytesToHex(bytes) {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

/**
 * Generate a UUID v4 string.
 * @returns {string}
 */
export function randomUUID() {
    const webCrypto = getWebCrypto();
    if (webCrypto?.randomUUID) return webCrypto.randomUUID();

    // Extremely unlikely fallback
    return `${randomHex(4)}-${randomHex(2)}-${randomHex(2)}-${randomHex(2)}-${randomHex(6)}`;
}

/**
 * Generate random bytes as a hex string.
 * @param {number} byteLength
 * @returns {string}
 */
export function randomHex(byteLength) {
    const webCrypto = getWebCrypto();
    if (webCrypto?.getRandomValues) {
        const bytes = new Uint8Array(byteLength);
        webCrypto.getRandomValues(bytes);
        return bytesToHex(bytes);
    }

    throw new Error('No secure random generator available in this runtime');
}

/**
 * SHA-256 digest of a string, returned as hex.
 * @param {string} input
 * @returns {Promise<string>}
 */
export async function sha256Hex(input) {
    const webCrypto = getWebCrypto();
    if (webCrypto?.subtle?.digest) {
        const bytes = new TextEncoder().encode(input);
        const digest = await webCrypto.subtle.digest('SHA-256', bytes);
        return bytesToHex(new Uint8Array(digest));
    }

    throw new Error('No SHA-256 implementation available in this runtime');
}
