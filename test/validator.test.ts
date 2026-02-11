/**
 * ClawRoute Validator Tests
 */

import { describe, it, expect } from 'vitest';
import { validateResponse, extractToolCalls, isConfusedResponse } from '../src/validator.js';
import { TaskTier, ChatCompletionRequest, ChatCompletionResponse } from '../src/types.js';

function createRequest(tools?: ChatCompletionRequest['tools']): ChatCompletionRequest {
    return {
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
        tools,
    };
}

function createResponse(
    content: string | null = 'Test response',
    toolCalls?: ChatCompletionResponse['choices'][0]['message']['tool_calls']
): ChatCompletionResponse {
    return {
        id: 'test-id',
        object: 'chat.completion',
        created: Date.now(),
        model: 'test-model',
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content,
                    tool_calls: toolCalls,
                },
                finish_reason: 'stop',
            },
        ],
        usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
        },
    };
}

function createMockHttpResponse(status: number): Response {
    return new Response(null, { status });
}

describe('Validator', () => {
    describe('HTTP Status Validation', () => {
        it('should fail for non-200 status', () => {
            const response = createMockHttpResponse(500);
            const result = validateResponse(response, null, createRequest(), TaskTier.MODERATE);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('http_error_500');
        });

        it('should pass for 200 status', () => {
            const response = createMockHttpResponse(200);
            const responseBody = createResponse();
            const result = validateResponse(response, responseBody, createRequest(), TaskTier.MODERATE);

            expect(result.valid).toBe(true);
        });
    });

    describe('JSON Body Validation', () => {
        it('should fail for null response body', () => {
            const response = createMockHttpResponse(200);
            const result = validateResponse(response, null, createRequest(), TaskTier.MODERATE);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('invalid_json_body');
        });
    });

    describe('Tool Call Validation', () => {
        it('should validate correct tool calls', () => {
            const tools = [
                { type: 'function' as const, function: { name: 'get_weather', description: 'Get weather' } }
            ];
            const request = createRequest(tools);

            const toolCalls = [
                {
                    id: 'call_1',
                    type: 'function' as const,
                    function: { name: 'get_weather', arguments: '{"location": "NYC"}' }
                }
            ];
            const responseBody = createResponse(null, toolCalls);
            const response = createMockHttpResponse(200);

            const result = validateResponse(response, responseBody, request, TaskTier.COMPLEX);

            expect(result.valid).toBe(true);
            expect(result.hadToolCalls).toBe(true);
        });

        it('should fail for invalid tool call JSON', () => {
            const tools = [
                { type: 'function' as const, function: { name: 'action', description: 'Do action' } }
            ];
            const request = createRequest(tools);

            const toolCalls = [
                {
                    id: 'call_1',
                    type: 'function' as const,
                    function: { name: 'action', arguments: 'not valid json {' }
                }
            ];
            const responseBody = createResponse(null, toolCalls);
            const response = createMockHttpResponse(200);

            const result = validateResponse(response, responseBody, request, TaskTier.COMPLEX);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('invalid_tool_call_json');
            expect(result.hadToolCalls).toBe(true);
        });

        it('should fail for unknown tool name', () => {
            const tools = [
                { type: 'function' as const, function: { name: 'known_tool', description: 'Known tool' } }
            ];
            const request = createRequest(tools);

            const toolCalls = [
                {
                    id: 'call_1',
                    type: 'function' as const,
                    function: { name: 'unknown_tool', arguments: '{}' }
                }
            ];
            const responseBody = createResponse(null, toolCalls);
            const response = createMockHttpResponse(200);

            const result = validateResponse(response, responseBody, request, TaskTier.COMPLEX);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('unknown_tool_name');
        });
    });

    describe('Response Length Validation', () => {
        it('should fail for suspiciously short response (non-heartbeat)', () => {
            const response = createMockHttpResponse(200);
            const responseBody = createResponse('Hi'); // Very short

            const result = validateResponse(response, responseBody, createRequest(), TaskTier.MODERATE);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('suspiciously_short_response');
        });

        it('should pass for short response in heartbeat tier', () => {
            const response = createMockHttpResponse(200);
            const responseBody = createResponse('Hi');

            const result = validateResponse(response, responseBody, createRequest(), TaskTier.HEARTBEAT);

            expect(result.valid).toBe(true);
        });

        it('should pass for normal length response', () => {
            const response = createMockHttpResponse(200);
            const responseBody = createResponse('This is a normal response with enough content.');

            const result = validateResponse(response, responseBody, createRequest(), TaskTier.MODERATE);

            expect(result.valid).toBe(true);
        });
    });

    describe('hadToolCalls Flag', () => {
        it('should set hadToolCalls to false when no tool calls', () => {
            const response = createMockHttpResponse(200);
            const responseBody = createResponse('Normal response');

            const result = validateResponse(response, responseBody, createRequest(), TaskTier.MODERATE);

            expect(result.hadToolCalls).toBe(false);
        });

        it('should set hadToolCalls to true when tool calls present', () => {
            const tools = [
                { type: 'function' as const, function: { name: 'action', description: 'Action' } }
            ];
            const request = createRequest(tools);

            const toolCalls = [
                {
                    id: 'call_1',
                    type: 'function' as const,
                    function: { name: 'action', arguments: '{}' }
                }
            ];
            const responseBody = createResponse(null, toolCalls);
            const response = createMockHttpResponse(200);

            const result = validateResponse(response, responseBody, request, TaskTier.COMPLEX);

            expect(result.hadToolCalls).toBe(true);
        });
    });

    describe('Extract Tool Calls', () => {
        it('should extract tool calls from response', () => {
            const toolCalls = [
                {
                    id: 'call_1',
                    type: 'function' as const,
                    function: { name: 'action', arguments: '{"a": 1}' }
                }
            ];
            const responseBody = createResponse(null, toolCalls);

            const extracted = extractToolCalls(responseBody);

            expect(extracted).toHaveLength(1);
            expect(extracted[0]?.name).toBe('action');
            expect(extracted[0]?.arguments).toBe('{"a": 1}');
        });

        it('should return empty array when no tool calls', () => {
            const responseBody = createResponse('Normal response');

            const extracted = extractToolCalls(responseBody);

            expect(extracted).toHaveLength(0);
        });

        it('should return empty array for null response', () => {
            const extracted = extractToolCalls(null);

            expect(extracted).toHaveLength(0);
        });
    });

    describe('Confused Response Detection', () => {
        it('should detect "I am not sure" as confused', () => {
            expect(isConfusedResponse("I'm not sure what you mean")).toBe(true);
        });

        it('should detect clarification requests as confused', () => {
            expect(isConfusedResponse("Could you please clarify your request?")).toBe(true);
        });

        it('should detect AI identity disclaimers as confused', () => {
            expect(isConfusedResponse("As an AI language model, I cannot...")).toBe(true);
        });

        it('should not flag normal responses as confused', () => {
            expect(isConfusedResponse("Here is the answer to your question.")).toBe(false);
        });

        it('should not flag long responses as confused', () => {
            const longResponse = "I understand your question. " + "x".repeat(600);
            expect(isConfusedResponse(longResponse)).toBe(false);
        });
    });
});
