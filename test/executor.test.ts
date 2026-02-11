/**
 * ClawRoute Executor Tests
 *
 * Tests for execution logic with mocked HTTP calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskTier, ClassificationResult, RoutingDecision, ClawRouteConfig } from '../src/types.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

function createTestConfig(): ClawRouteConfig {
    return {
        enabled: true,
        dryRun: false,
        proxyPort: 18790,
        proxyHost: '127.0.0.1',
        authToken: null,
        classification: {
            conservativeMode: true,
            minConfidence: 0.7,
            toolAwareRouting: true,
        },
        escalation: {
            enabled: true,
            maxRetries: 2,
            retryDelayMs: 10, // Fast for tests
            onlyRetryBeforeStreaming: true,
            onlyRetryWithoutToolCalls: true,
            alwaysFallbackToOriginal: true,
        },
        models: {
            [TaskTier.HEARTBEAT]: { primary: 'google/gemini-2.5-flash-lite', fallback: 'deepseek/deepseek-chat' },
            [TaskTier.SIMPLE]: { primary: 'deepseek/deepseek-chat', fallback: 'google/gemini-2.5-flash' },
            [TaskTier.MODERATE]: { primary: 'google/gemini-2.5-flash', fallback: 'openai/gpt-4o-mini' },
            [TaskTier.COMPLEX]: { primary: 'anthropic/claude-sonnet-4-5', fallback: 'openai/gpt-4o' },
            [TaskTier.FRONTIER]: { primary: 'anthropic/claude-sonnet-4-5', fallback: 'openai/gpt-4o' },
        },
        logging: {
            dbPath: ':memory:',
            logContent: false,
            logSystemPrompts: false,
            debugMode: false,
            retentionDays: 30,
        },
        dashboard: { enabled: true },
        overrides: { globalForceModel: null, sessions: {} },
        apiKeys: {
            anthropic: 'test-key',
            openai: 'test-key',
            google: 'test-key',
            deepseek: 'test-key',
            openrouter: '',
        },
        // v1.1: License, billing, alerts
        license: { enabled: true, plan: 'pro' },
        billing: { proRatePercent: 0.02, minMonthlyUsd: 9, graceDays: 7 },
        alerts: {},
    };
}

function createClassification(tier: TaskTier, safeToRetry: boolean = true): ClassificationResult {
    return {
        tier,
        confidence: 0.9,
        reason: 'test',
        signals: ['test'],
        toolsDetected: false,
        safeToRetry,
    };
}

function createRoutingDecision(
    originalModel: string,
    routedModel: string,
    tier: TaskTier,
    safeToRetry: boolean = true
): RoutingDecision {
    return {
        originalModel,
        routedModel,
        tier,
        reason: 'test routing',
        confidence: 0.9,
        isDryRun: false,
        isOverride: false,
        isPassthrough: false,
        estimatedSavingsUsd: 0.01,
        safeToRetry,
    };
}

function createSuccessResponse(content: string = 'Test response'): Response {
    return new Response(
        JSON.stringify({
            id: 'test-id',
            object: 'chat.completion',
            created: Date.now(),
            model: 'test-model',
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }
    );
}

function createErrorResponse(status: number, message: string): Response {
    return new Response(
        JSON.stringify({ error: { message, type: 'error', code: 'error' } }),
        { status, headers: { 'Content-Type': 'application/json' } }
    );
}

function createToolCallResponse(): Response {
    return new Response(
        JSON.stringify({
            id: 'test-id',
            object: 'chat.completion',
            created: Date.now(),
            model: 'test-model',
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                            {
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'test_action', arguments: '{}' },
                            },
                        ],
                    },
                    finish_reason: 'tool_calls',
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }
    );
}

describe('Executor Logic', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('Successful Routing', () => {
        it('should successfully route to cheap model', async () => {
            mockFetch.mockResolvedValueOnce(createSuccessResponse());

            // Import executor after mocking
            const { executeRequest } = await import('../src/executor.js');

            const request = {
                model: 'anthropic/claude-sonnet-4-5',
                messages: [{ role: 'user' as const, content: 'test' }],
                stream: false,
            };
            const routing = createRoutingDecision(
                'anthropic/claude-sonnet-4-5',
                'google/gemini-2.5-flash-lite',
                TaskTier.HEARTBEAT
            );
            const classification = createClassification(TaskTier.HEARTBEAT);
            const config = createTestConfig();

            const result = await executeRequest(request, routing, classification, config);

            expect(result.actualModel).toBe('google/gemini-2.5-flash-lite');
            expect(result.escalated).toBe(false);
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('Escalation on Error', () => {
        it('should escalate on HTTP error when safe to retry', async () => {
            // First call fails, second succeeds
            mockFetch
                .mockResolvedValueOnce(createErrorResponse(500, 'Server error'))
                .mockResolvedValueOnce(createSuccessResponse());

            const { executeRequest } = await import('../src/executor.js');

            const request = {
                model: 'anthropic/claude-sonnet-4-5',
                messages: [{ role: 'user' as const, content: 'test' }],
                stream: false,
            };
            const routing = createRoutingDecision(
                'anthropic/claude-sonnet-4-5',
                'google/gemini-2.5-flash-lite',
                TaskTier.HEARTBEAT,
                true // safeToRetry
            );
            const classification = createClassification(TaskTier.HEARTBEAT, true);
            const config = createTestConfig();

            const result = await executeRequest(request, routing, classification, config);

            expect(result.escalated).toBe(true);
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });
    });

    describe('Tool Call Retry Blocking', () => {
        it('should NOT retry when response has tool calls', async () => {
            // This tests that tool calls block retry even if response seems bad
            mockFetch.mockResolvedValueOnce(createToolCallResponse());

            const { executeRequest } = await import('../src/executor.js');

            const request = {
                model: 'anthropic/claude-sonnet-4-5',
                messages: [{ role: 'user' as const, content: 'do action' }],
                tools: [
                    {
                        type: 'function' as const,
                        function: { name: 'test_action', description: 'Test action' }
                    }
                ],
                stream: false,
            };
            const routing = createRoutingDecision(
                'anthropic/claude-sonnet-4-5',
                'google/gemini-2.5-flash',
                TaskTier.COMPLEX,
                false // NOT safeToRetry because tools
            );
            const classification = createClassification(TaskTier.COMPLEX, false);
            const config = createTestConfig();

            const result = await executeRequest(request, routing, classification, config);

            // Should not escalate because tool call was received
            expect(result.hadToolCalls).toBe(true);
            // Only one call made
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('Fallback to Original', () => {
        it('should fallback to original when all escalations fail', async () => {
            // All calls fail except the last (original model)
            mockFetch
                .mockResolvedValueOnce(createErrorResponse(500, 'Error 1'))
                .mockResolvedValueOnce(createErrorResponse(500, 'Error 2'))
                .mockResolvedValueOnce(createErrorResponse(500, 'Error 3'))
                .mockResolvedValueOnce(createSuccessResponse());

            const { executeRequest } = await import('../src/executor.js');

            const request = {
                model: 'anthropic/claude-sonnet-4-5',
                messages: [{ role: 'user' as const, content: 'test' }],
                stream: false,
            };
            const routing = createRoutingDecision(
                'anthropic/claude-sonnet-4-5',
                'google/gemini-2.5-flash-lite',
                TaskTier.HEARTBEAT,
                true
            );
            const classification = createClassification(TaskTier.HEARTBEAT, true);
            const config = createTestConfig();

            const result = await executeRequest(request, routing, classification, config);

            // Should have fallen back to original model
            expect(result.escalated).toBe(true);
            expect(result.escalationChain.length).toBeGreaterThan(1);
        });
    });

    describe('Passthrough Mode', () => {
        it('should passthrough when ClawRoute errors', async () => {
            mockFetch.mockResolvedValueOnce(createSuccessResponse());

            const { executePassthrough } = await import('../src/executor.js');

            const request = {
                model: 'openai/gpt-4o',
                messages: [{ role: 'user' as const, content: 'test' }],
            };
            const config = createTestConfig();

            const response = await executePassthrough(request, config);

            expect(response.ok).toBe(true);
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });
});
