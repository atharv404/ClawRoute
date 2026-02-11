/**
 * ClawRoute Donation Tests
 *
 * Verification of Donationware endpoints.
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
        proxyPort: 18798,
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
        // v1.1: Donation defaults
        donations: {
            minMonthlyUsd: 5,
            enabled: true,
        },
        alerts: {},
    };
}

describe('Donationware Endpoints', () => {
    let app: Hono;

    beforeAll(async () => {
        const { createApp } = await import('../src/server.js');
        app = createApp(createTestConfig());
    });

    afterAll(() => {
        vi.restoreAllMocks();
    });

    describe('Donation Summary', () => {
        it('should return donation summary with savings', async () => {
            const res = await app.request('/billing/summary');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body).toHaveProperty('savingsUsd');
            expect(body).toHaveProperty('requests');
            expect(body).toHaveProperty('suggestedUsd');
            expect(body.suggestedUsd).toBeGreaterThanOrEqual(0);
        });
    });

    describe('Donation Config', () => {
        it('should reflect donation settings in public config', async () => {
            const res = await app.request('/api/config');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body).toHaveProperty('donations');
            expect(body.donations.enabled).toBe(true);
        });
    });
});
