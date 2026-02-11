/**
 * ClawRoute Utilities
 *
 * Shared utility functions used across the application.
 */

import { ChatMessage } from './types.js';

/**
 * Generate a unique request ID.
 *
 * @returns A unique request ID string
 */
export function generateRequestId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `cr_${timestamp}_${random}`;
}

/**
 * Estimate token count from text.
 * Uses a simple heuristic of ~4 characters per token for English text.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    // Average of ~4 characters per token for English
    return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for an array of messages.
 *
 * @param messages - Array of chat messages
 * @returns Estimated total token count
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
    let total = 0;

    for (const message of messages) {
        // Count role token overhead (~4 tokens per message)
        total += 4;

        // Count content tokens
        if (typeof message.content === 'string') {
            total += estimateTokens(message.content);
        }

        // Count tool calls if present
        if (message.tool_calls) {
            for (const toolCall of message.tool_calls) {
                total += estimateTokens(toolCall.function.name);
                total += estimateTokens(toolCall.function.arguments);
            }
        }
    }

    return total;
}

/**
 * Get the last user message from an array of messages.
 *
 * @param messages - Array of chat messages
 * @returns The last user message content, or empty string if none
 */
export function getLastUserMessage(messages: ChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role === 'user' && typeof msg.content === 'string') {
            return msg.content;
        }
    }
    return '';
}

/**
 * Get the system prompt from messages.
 *
 * @param messages - Array of chat messages
 * @returns The system prompt content, or empty string if none
 */
export function getSystemPrompt(messages: ChatMessage[]): string {
    const systemMsg = messages.find((m) => m.role === 'system');
    if (systemMsg && typeof systemMsg.content === 'string') {
        return systemMsg.content;
    }
    return '';
}

/**
 * Truncate a string for logging, preserving the start and end.
 *
 * @param str - String to truncate
 * @param maxLength - Maximum length
 * @returns Truncated string
 */
export function truncateForLog(str: string, maxLength: number = 50): string {
    if (!str || str.length <= maxLength) return str;

    const halfLen = Math.floor((maxLength - 3) / 2);
    return `${str.substring(0, halfLen)}...${str.substring(str.length - halfLen)}`;
}

/**
 * Redact sensitive values from a string.
 * Replaces API keys and tokens with [REDACTED].
 *
 * @param str - String to redact
 * @returns Redacted string
 */
export function redactSensitive(str: string): string {
    if (!str) return str;

    // Redact common API key patterns
    return str
        .replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')
        .replace(/sk-ant-[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')
        .replace(/AIza[a-zA-Z0-9_-]{30,}/g, '[REDACTED]')
        .replace(/(["']?(?:api[_-]?key|token|secret|password|auth)['""]?\s*[:=]\s*["']?)[^"'\s]{8,}(["']?)/gi, '$1[REDACTED]$2');
}

/**
 * Sleep for a specified number of milliseconds.
 *
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the delay
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a model ID into provider and model name.
 *
 * @param modelId - Full model ID (e.g., "anthropic/claude-sonnet-4-5")
 * @returns Object with provider and modelName
 */
export function parseModelId(modelId: string): { provider: string; modelName: string } {
    if (modelId.includes('/')) {
        const [provider, ...rest] = modelId.split('/');
        return {
            provider: provider ?? '',
            modelName: rest.join('/'),
        };
    }
    return {
        provider: '',
        modelName: modelId,
    };
}

/**
 * Format a number as USD currency.
 *
 * @param amount - Amount in USD
 * @param decimals - Number of decimal places
 * @returns Formatted currency string
 */
export function formatUsd(amount: number, decimals: number = 4): string {
    return `$${amount.toFixed(decimals)}`;
}

/**
 * Format a percentage.
 *
 * @param value - Percentage value (0-100)
 * @param decimals - Number of decimal places
 * @returns Formatted percentage string
 */
export function formatPercent(value: number, decimals: number = 1): string {
    return `${value.toFixed(decimals)}%`;
}

/**
 * Check if a value is a non-null object.
 *
 * @param value - Value to check
 * @returns Whether it's a non-null object
 */
export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Safely parse JSON.
 *
 * @param str - JSON string to parse
 * @returns Parsed object or null if invalid
 */
export function safeJsonParse<T = unknown>(str: string): T | null {
    try {
        return JSON.parse(str) as T;
    } catch {
        return null;
    }
}

/**
 * Get current ISO timestamp.
 *
 * @returns Current timestamp in ISO format
 */
export function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Extract model name for display (without provider prefix).
 *
 * @param modelId - Full model ID
 * @returns Short model name
 */
export function shortModelName(modelId: string): string {
    const { modelName } = parseModelId(modelId);
    return modelName || modelId;
}
