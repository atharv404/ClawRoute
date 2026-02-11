/**
 * ClawRoute Response Validator
 *
 * Validates LLM responses for quality before accepting.
 * Used for non-streaming responses where retry is still possible.
 */

import {
    ChatCompletionRequest,
    ChatCompletionResponse,
    TaskTier,
    ValidationResult,
} from './types.js';
import { safeJsonParse } from './utils.js';

/**
 * Validate an LLM response.
 *
 * @param response - The HTTP response object
 * @param responseBody - The parsed response body
 * @param request - The original request
 * @param tier - The classification tier
 * @returns Validation result
 */
export function validateResponse(
    response: Response,
    responseBody: ChatCompletionResponse | null,
    request: ChatCompletionRequest,
    tier: TaskTier
): ValidationResult {
    // 1. Check HTTP status
    if (!response.ok) {
        return {
            valid: false,
            reason: `http_error_${response.status}`,
            hadToolCalls: false,
        };
    }

    // 2. Check if response body is valid
    if (!responseBody) {
        return {
            valid: false,
            reason: 'invalid_json_body',
            hadToolCalls: false,
        };
    }

    // 3. Check for error in response body
    if ('error' in responseBody && responseBody.error) {
        return {
            valid: false,
            reason: 'api_error_response',
            hadToolCalls: false,
        };
    }

    // 4. Check choices exist
    const choices = responseBody.choices;
    if (!choices || choices.length === 0) {
        return {
            valid: false,
            reason: 'no_choices',
            hadToolCalls: false,
        };
    }

    const firstChoice = choices[0];
    if (!firstChoice) {
        return {
            valid: false,
            reason: 'no_first_choice',
            hadToolCalls: false,
        };
    }

    const message = firstChoice.message;
    if (!message) {
        return {
            valid: false,
            reason: 'no_message',
            hadToolCalls: false,
        };
    }

    // 5. Check for tool calls
    const toolCalls = message.tool_calls;
    const hadToolCalls = Boolean(toolCalls && toolCalls.length > 0);

    // 6. Validate tool calls if present
    if (hadToolCalls && toolCalls && request.tools && request.tools.length > 0) {
        const toolNames = new Set(request.tools.map((t) => t.function.name));

        for (const toolCall of toolCalls) {
            // Check tool name exists
            if (!toolNames.has(toolCall.function.name)) {
                return {
                    valid: false,
                    reason: `unknown_tool_name: ${toolCall.function.name}`,
                    hadToolCalls: true,
                };
            }

            // Check arguments are valid JSON
            const argsJson = toolCall.function.arguments;
            if (argsJson && argsJson.trim() !== '') {
                const parsed = safeJsonParse(argsJson);
                if (parsed === null && argsJson !== '{}') {
                    return {
                        valid: false,
                        reason: 'invalid_tool_call_json',
                        hadToolCalls: true,
                    };
                }
            }
        }
    }

    // 7. Check for suspiciously short response (non-heartbeat only)
    const content = typeof message.content === 'string' ? message.content : '';

    if (tier !== TaskTier.HEARTBEAT && !hadToolCalls) {
        if (content.length < 15 && content.trim() !== '') {
            // Very short response for a non-trivial task
            return {
                valid: false,
                reason: 'suspiciously_short_response',
                hadToolCalls: false,
            };
        }
    }

    // All checks passed
    return {
        valid: true,
        reason: 'ok',
        hadToolCalls,
    };
}

/**
 * Validate a streaming chunk for basic structure.
 *
 * @param chunk - The chunk data string
 * @returns Whether the chunk appears valid
 */
export function validateStreamingChunk(chunk: string): boolean {
    // Check for SSE format
    if (!chunk.startsWith('data:')) {
        // Could be a comment or other SSE field, that's ok
        return true;
    }

    const data = chunk.slice(5).trim();

    // Check for [DONE] marker
    if (data === '[DONE]') {
        return true;
    }

    // Try to parse as JSON
    const parsed = safeJsonParse(data);
    if (parsed === null) {
        return false;
    }

    return true;
}

/**
 * Extract tool calls from a response.
 *
 * @param responseBody - The parsed response body
 * @returns Array of tool calls, or empty array
 */
export function extractToolCalls(
    responseBody: ChatCompletionResponse | null
): Array<{ name: string; arguments: string }> {
    if (!responseBody?.choices?.[0]?.message?.tool_calls) {
        return [];
    }

    return responseBody.choices[0].message.tool_calls.map((tc) => ({
        name: tc.function.name,
        arguments: tc.function.arguments,
    }));
}

/**
 * Check if a response indicates the model is confused or gave a non-answer.
 *
 * @param content - The response content
 * @returns Whether the response shows confusion
 */
export function isConfusedResponse(content: string): boolean {
    if (!content || content.length > 500) {
        // Empty or long responses are not "confused"
        return false;
    }

    const confusionPatterns = [
        /i('m| am) (not sure|confused|uncertain)/i,
        /i (don't|do not) (understand|know what)/i,
        /could you (please )?(clarify|explain|rephrase)/i,
        /what (exactly |specifically )?do you mean/i,
        /i('m| am) (just )?an ai/i,
        /as an ai( language model)?/i,
    ];

    for (const pattern of confusionPatterns) {
        if (pattern.test(content)) {
            return true;
        }
    }

    return false;
}
