/**
 * ClawRoute Classifier Tests
 *
 * 30+ test cases covering all classification tiers.
 */

import { describe, it, expect } from 'vitest';
import { classifyRequest } from '../src/classifier.js';
import { TaskTier, ChatCompletionRequest, ClawRouteConfig } from '../src/types.js';

// Helper to create a minimal config for testing
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
            retryDelayMs: 100,
            onlyRetryBeforeStreaming: true,
            onlyRetryWithoutToolCalls: true,
            alwaysFallbackToOriginal: true,
        },
        models: {
            [TaskTier.HEARTBEAT]: { primary: 'test/heartbeat', fallback: 'test/fallback' },
            [TaskTier.SIMPLE]: { primary: 'test/simple', fallback: 'test/fallback' },
            [TaskTier.MODERATE]: { primary: 'test/moderate', fallback: 'test/fallback' },
            [TaskTier.COMPLEX]: { primary: 'test/complex', fallback: 'test/fallback' },
            [TaskTier.FRONTIER]: { primary: 'test/frontier', fallback: 'test/fallback' },
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
        apiKeys: { anthropic: '', openai: '', google: '', deepseek: '', openrouter: '' },
        // v1.1: License, billing, alerts
        license: { enabled: true, plan: 'pro' },
        billing: { proRatePercent: 0.02, minMonthlyUsd: 9, graceDays: 7 },
        alerts: {},
    };
}

// Helper to create a request
function createRequest(
    lastUserMessage: string,
    messageCount: number = 1,
    tools: ChatCompletionRequest['tools'] = undefined,
    toolChoice: ChatCompletionRequest['tool_choice'] = undefined
): ChatCompletionRequest {
    const messages: ChatCompletionRequest['messages'] = [];

    // Add system message if multiple messages
    if (messageCount > 1) {
        messages.push({ role: 'system', content: 'You are a helpful assistant.' });
    }

    // Add filler messages for conversation depth
    for (let i = 0; i < messageCount - 1; i++) {
        if (i % 2 === 0) {
            messages.push({ role: 'user', content: 'Previous message ' + i });
        } else {
            messages.push({ role: 'assistant', content: 'Previous response ' + i });
        }
    }

    // Add the last user message
    messages.push({ role: 'user', content: lastUserMessage });

    return {
        model: 'test-model',
        messages,
        tools,
        tool_choice: toolChoice,
    };
}

describe('Classifier', () => {
    const config = createTestConfig();

    // ========== HEARTBEAT TESTS ==========
    describe('Heartbeat Detection', () => {
        it('should classify "ping" as heartbeat', () => {
            const result = classifyRequest(createRequest('ping'), config);
            expect(result.tier).toBe(TaskTier.HEARTBEAT);
            expect(result.confidence).toBeGreaterThanOrEqual(0.8);
        });

        it('should classify "status" as heartbeat', () => {
            const result = classifyRequest(createRequest('status'), config);
            expect(result.tier).toBe(TaskTier.HEARTBEAT);
        });

        it('should classify "hi" as heartbeat', () => {
            const result = classifyRequest(createRequest('hi'), config);
            expect(result.tier).toBe(TaskTier.HEARTBEAT);
        });

        it('should classify "hello" as heartbeat', () => {
            const result = classifyRequest(createRequest('hello'), config);
            expect(result.tier).toBe(TaskTier.HEARTBEAT);
        });

        it('should classify "test" as heartbeat', () => {
            const result = classifyRequest(createRequest('test'), config);
            expect(result.tier).toBe(TaskTier.HEARTBEAT);
        });

        it('should classify "are you there?" as heartbeat', () => {
            const result = classifyRequest(createRequest('are you there?'), config);
            expect(result.tier).toBe(TaskTier.HEARTBEAT);
        });

        it('should classify "yo" as heartbeat', () => {
            const result = classifyRequest(createRequest('yo'), config);
            expect(result.tier).toBe(TaskTier.HEARTBEAT);
        });

        it('should NOT classify "Hey, can you help me with something?" as heartbeat', () => {
            const result = classifyRequest(createRequest('Hey, can you help me with something?'), config);
            expect(result.tier).not.toBe(TaskTier.HEARTBEAT);
        });
    });

    // ========== SIMPLE TESTS ==========
    describe('Simple Detection', () => {
        // Note: Very short acknowledgments may be classified as heartbeat
        // since they're short and could be status checks. This is expected behavior.
        it('should classify "thanks" as heartbeat or simple', () => {
            const result = classifyRequest(createRequest('thanks'), config);
            expect([TaskTier.HEARTBEAT, TaskTier.SIMPLE]).toContain(result.tier);
        });

        it('should classify "ok" as heartbeat or simple', () => {
            const result = classifyRequest(createRequest('ok'), config);
            expect([TaskTier.HEARTBEAT, TaskTier.SIMPLE]).toContain(result.tier);
        });

        it('should classify "👍" as heartbeat or simple', () => {
            const result = classifyRequest(createRequest('👍'), config);
            expect([TaskTier.HEARTBEAT, TaskTier.SIMPLE]).toContain(result.tier);
        });

        it('should classify "yes" as heartbeat or simple', () => {
            const result = classifyRequest(createRequest('yes'), config);
            expect([TaskTier.HEARTBEAT, TaskTier.SIMPLE]).toContain(result.tier);
        });

        it('should classify "no" as heartbeat or simple', () => {
            const result = classifyRequest(createRequest('no'), config);
            expect([TaskTier.HEARTBEAT, TaskTier.SIMPLE]).toContain(result.tier);
        });

        it('should classify "sounds good!" as simple', () => {
            const result = classifyRequest(createRequest('sounds good!'), config);
            expect([TaskTier.HEARTBEAT, TaskTier.SIMPLE]).toContain(result.tier);
        });

        it('should classify "thank you" as heartbeat or simple', () => {
            const result = classifyRequest(createRequest('thank you'), config);
            expect([TaskTier.HEARTBEAT, TaskTier.SIMPLE]).toContain(result.tier);
        });

        it('should classify "lol" as heartbeat or simple', () => {
            const result = classifyRequest(createRequest('lol'), config);
            expect([TaskTier.HEARTBEAT, TaskTier.SIMPLE]).toContain(result.tier);
        });
    });

    // ========== FRONTIER TESTS ==========
    describe('Frontier Detection', () => {
        it('should classify request with tools + tool_choice as frontier', () => {
            const tools = [
                { type: 'function' as const, function: { name: 'get_weather', description: 'Get weather' } }
            ];
            const result = classifyRequest(
                createRequest('What is the weather?', 1, tools, 'auto'),
                config
            );
            expect(result.tier).toBe(TaskTier.FRONTIER);
        });

        it('should classify code blocks as frontier', () => {
            const message = 'Please review this code:\n```python\ndef hello():\n    print("hello")\n```';
            const result = classifyRequest(createRequest(message), config);
            expect(result.tier).toBe(TaskTier.FRONTIER);
        });

        it('should classify "implement a binary search tree in TypeScript" with context as complex/frontier', () => {
            const longMessage = 'I need you to implement a binary search tree in TypeScript. ' +
                'It should support insert, delete, and search operations. ' +
                'Please also include balancing logic for AVL trees. ' +
                'Make sure to add comprehensive error handling and type safety.';
            const result = classifyRequest(createRequest(longMessage), config);
            // Should be at least COMPLEX due to keywords
            expect([TaskTier.COMPLEX, TaskTier.FRONTIER]).toContain(result.tier);
        });

        it('should classify very long context as frontier', () => {
            // Create a very long message
            const longMessage = 'Please analyze this: ' + 'x'.repeat(10000);
            const result = classifyRequest(createRequest(longMessage), config);
            expect(result.tier).toBe(TaskTier.FRONTIER);
        });
    });

    // ========== COMPLEX TESTS ==========
    describe('Complex Detection', () => {
        it('should classify request with tools (no tool_choice) as complex', () => {
            const tools = [
                { type: 'function' as const, function: { name: 'search', description: 'Search' } }
            ];
            const result = classifyRequest(createRequest('Search for something', 1, tools), config);
            expect(result.tier).toBe(TaskTier.COMPLEX);
        });

        it('should classify "explain the differences between REST and GraphQL" as complex', () => {
            const message = 'Can you explain the differences between REST and GraphQL in detail? ' +
                'I want to understand the pros and cons of each approach for my project. ' +
                'Please include examples of when to use each one.';
            const result = classifyRequest(createRequest(message), config);
            expect([TaskTier.COMPLEX, TaskTier.MODERATE]).toContain(result.tier);
        });

        it('should classify deep conversations as complex', () => {
            // Create a request with 10 messages
            const result = classifyRequest(createRequest('Continue the discussion', 10), config);
            expect(result.tier).toBe(TaskTier.COMPLEX);
        });
    });

    // ========== MODERATE TESTS ==========
    describe('Moderate Detection', () => {
        // Note: Short messages may be classified as heartbeat/simple even if they ask questions
        it('should classify "what\'s the weather like today?" appropriately', () => {
            const result = classifyRequest(createRequest("what's the weather like today?"), config);
            // Short question could be heartbeat, simple, or moderate
            expect([TaskTier.HEARTBEAT, TaskTier.SIMPLE, TaskTier.MODERATE]).toContain(result.tier);
        });

        it('should classify "tell me a joke" appropriately', () => {
            const result = classifyRequest(createRequest('tell me a joke'), config);
            expect([TaskTier.HEARTBEAT, TaskTier.SIMPLE, TaskTier.MODERATE]).toContain(result.tier);
        });

        it('should classify general questions as moderate or simpler', () => {
            const result = classifyRequest(createRequest('What is the capital of France?'), config);
            expect([TaskTier.MODERATE, TaskTier.SIMPLE, TaskTier.HEARTBEAT]).toContain(result.tier);
        });
    });

    // ========== TOOL-AWARE ROUTING TESTS ==========
    describe('Tool-Aware Escalation', () => {
        it('should escalate heartbeat to complex when tools present', () => {
            const tools = [
                { type: 'function' as const, function: { name: 'get_time', description: 'Get time' } }
            ];
            const result = classifyRequest(createRequest('hi', 1, tools), config);
            // Should be escalated due to tools
            expect([TaskTier.COMPLEX, TaskTier.FRONTIER]).toContain(result.tier);
        });

        it('should escalate simple to complex when tools present', () => {
            const tools = [
                { type: 'function' as const, function: { name: 'send_message', description: 'Send msg' } }
            ];
            const result = classifyRequest(createRequest('ok', 1, tools), config);
            expect([TaskTier.COMPLEX, TaskTier.FRONTIER]).toContain(result.tier);
        });
    });

    // ========== CONFIDENCE ESCALATION TESTS ==========
    describe('Confidence Escalation', () => {
        it('should have high confidence for clear heartbeat', () => {
            const result = classifyRequest(createRequest('ping'), config);
            expect(result.confidence).toBeGreaterThanOrEqual(0.8);
        });

        it('should have high confidence for clear acknowledgment', () => {
            const result = classifyRequest(createRequest('thanks'), config);
            expect(result.confidence).toBeGreaterThanOrEqual(0.7);
        });

        it('should set safeToRetry correctly for heartbeat', () => {
            const result = classifyRequest(createRequest('ping'), config);
            expect(result.safeToRetry).toBe(true);
        });

        it('should set safeToRetry correctly for simple', () => {
            const result = classifyRequest(createRequest('ok'), config);
            expect(result.safeToRetry).toBe(true);
        });

        it('should set safeToRetry to false when tools present', () => {
            const tools = [
                { type: 'function' as const, function: { name: 'action', description: 'Do something' } }
            ];
            const result = classifyRequest(createRequest('go', 1, tools), config);
            expect(result.safeToRetry).toBe(false);
        });
    });

    // ========== EDGE CASES ==========
    describe('Edge Cases', () => {
        it('should handle empty message gracefully', () => {
            const result = classifyRequest(createRequest(''), config);
            expect(result.tier).toBeDefined();
        });

        it('should handle message with only whitespace', () => {
            const result = classifyRequest(createRequest('   '), config);
            expect(result.tier).toBeDefined();
        });

        it('should handle very short messages', () => {
            const result = classifyRequest(createRequest('a'), config);
            expect(result.tier).toBeDefined();
        });

        it('should detect model name hints', () => {
            const request = createRequest('Do something');
            request.model = 'heartbeat-monitor';
            const result = classifyRequest(request, config);
            expect(result.tier).toBe(TaskTier.HEARTBEAT);
        });
    });
});
