/**
 * ClawRoute Integration Tests
 *
 * End-to-end tests for the proxy server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { TaskTier, ClawRouteConfig } from '../src/types.js';

// Mock fetch for provider calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

function createTestConfig(): ClawRouteConfig {
    return {
        enabled: true,
        dryRun: false,
        proxyPort: 18799, // Different port for tests
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
            retryDelayMs: 10,
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

describe('Integration Tests', () => {
    let app: Hono;

    beforeAll(async () => {
        // Import createApp after setting up mocks
        const { createApp } = await import('../src/server.js');
        app = createApp(createTestConfig());
    });

    afterAll(() => {
        vi.restoreAllMocks();
    });

    beforeEach(() => {
        mockFetch.mockReset();
    });

    describe('Health Endpoint', () => {
        it('should return health status', async () => {
            const res = await app.request('/health');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.status).toBe('ok');
            expect(body.version).toBe('1.1.0');
        });
    });

    describe('Stats Endpoint', () => {
        it('should return stats', async () => {
            const res = await app.request('/stats');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body).toHaveProperty('today');
            expect(body).toHaveProperty('thisWeek');
            expect(body).toHaveProperty('thisMonth');
            expect(body).toHaveProperty('allTime');
        });
    });

    describe('Config Endpoint', () => {
        it('should return redacted config', async () => {
            const res = await app.request('/api/config');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.apiKeys.openai).toBe('[REDACTED]');
        });
    });

    describe('Enable/Disable Endpoints', () => {
        it('should enable ClawRoute', async () => {
            const res = await app.request('/api/enable', { method: 'POST' });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.enabled).toBe(true);
        });

        it('should disable ClawRoute', async () => {
            const res = await app.request('/api/disable', { method: 'POST' });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.enabled).toBe(false);

            // Re-enable for other tests
            await app.request('/api/enable', { method: 'POST' });
        });
    });

    describe('Dry-Run Endpoints', () => {
        it('should enable dry-run', async () => {
            const res = await app.request('/api/dry-run/enable', { method: 'POST' });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.dryRun).toBe(true);
        });

        it('should disable dry-run', async () => {
            const res = await app.request('/api/dry-run/disable', { method: 'POST' });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.dryRun).toBe(false);
        });
    });

    describe('Global Override Endpoints', () => {
        it('should set global override', async () => {
            const res = await app.request('/api/override/global', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'openai/gpt-4o' }),
            });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.globalForceModel).toBe('openai/gpt-4o');
        });

        it('should remove global override', async () => {
            const res = await app.request('/api/override/global', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: false }),
            });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.globalForceModel).toBeNull();
        });
    });

    describe('Session Override Endpoints', () => {
        it('should set session override', async () => {
            const res = await app.request('/api/override/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: 'test-session', model: 'openai/gpt-4o', turns: 5 }),
            });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.sessionId).toBe('test-session');
        });

        it('should remove session override', async () => {
            const res = await app.request('/api/override/session', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: 'test-session' }),
            });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
        });
    });

    describe('Proxy Endpoint', () => {
        it('should handle chat completion request', async () => {
            // Mock successful provider response
            mockFetch.mockResolvedValueOnce(new Response(
                JSON.stringify({
                    id: 'test-id',
                    object: 'chat.completion',
                    created: Date.now(),
                    model: 'test-model',
                    choices: [
                        {
                            index: 0,
                            message: { role: 'assistant', content: 'Hello!' },
                            finish_reason: 'stop',
                        },
                    ],
                    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            ));

            const res = await app.request('/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'anthropic/claude-sonnet-4-5',
                    messages: [{ role: 'user', content: 'ping' }],
                }),
            });

            expect(res.status).toBe(200);
            expect(mockFetch).toHaveBeenCalled();
        });
    });

    describe('Unknown Endpoints', () => {
        it('should return 404 for unknown routes', async () => {
            const res = await app.request('/unknown/endpoint');

            expect(res.status).toBe(404);
        });
    });

    describe('Anthropic Format Placeholder', () => {
        it('should return error for /v1/messages', async () => {
            const res = await app.request('/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'claude-3', messages: [] }),
            });
            const body = await res.json();

            expect(res.status).toBe(400);
            expect(body.error.code).toBe('unsupported_format');
        });
    });
});
