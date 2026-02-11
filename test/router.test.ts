/**
 * ClawRoute Router Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { routeRequest, getEscalatedModel, canUseModel, getModelMap } from '../src/router.js';
import { TaskTier, ClassificationResult, ChatCompletionRequest, ClawRouteConfig } from '../src/types.js';

function createTestConfig(overrides: Partial<ClawRouteConfig> = {}): ClawRouteConfig {
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
        license: {
            enabled: true,  // Pro for tests - full routing
            plan: 'pro',
        },
        billing: {
            proRatePercent: 0.02,
            minMonthlyUsd: 9,
            graceDays: 7,
        },
        alerts: {},
        ...overrides,
    };
}

function createClassification(
    tier: TaskTier,
    confidence: number = 0.9,
    safeToRetry: boolean = true
): ClassificationResult {
    return {
        tier,
        confidence,
        reason: 'test classification',
        signals: ['test'],
        toolsDetected: false,
        safeToRetry,
    };
}

function createRequest(model: string): ChatCompletionRequest {
    return {
        model,
        messages: [{ role: 'user', content: 'test' }],
    };
}

describe('Router', () => {
    describe('Model Selection', () => {
        it('should route heartbeat tier to heartbeat model', () => {
            const config = createTestConfig();
            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('google/gemini-2.5-flash-lite');
            expect(decision.tier).toBe(TaskTier.HEARTBEAT);
        });

        it('should route simple tier to simple model', () => {
            const config = createTestConfig();
            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.SIMPLE);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('deepseek/deepseek-chat');
        });

        it('should route moderate tier to moderate model', () => {
            const config = createTestConfig();
            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.MODERATE);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('google/gemini-2.5-flash');
        });

        it('should route complex tier to complex model', () => {
            const config = createTestConfig();
            const request = createRequest('openai/gpt-4o');
            const classification = createClassification(TaskTier.COMPLEX);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('anthropic/claude-sonnet-4-5');
        });
    });

    describe('Fallback Behavior', () => {
        it('should use fallback when primary model API key is missing', () => {
            const config = createTestConfig({
                apiKeys: {
                    anthropic: '',
                    openai: 'test-key',
                    google: '',
                    deepseek: '',
                    openrouter: '',
                },
            });

            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.COMPLEX);

            const decision = routeRequest(request, classification, config);

            // Should fall back to openai/gpt-4o since anthropic key is missing
            expect(decision.routedModel).toBe('openai/gpt-4o');
        });

        it('should passthrough when no models available', () => {
            const config = createTestConfig({
                apiKeys: {
                    anthropic: '',
                    openai: '',
                    google: '',
                    deepseek: '',
                    openrouter: '',
                },
            });

            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.COMPLEX);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('anthropic/claude-sonnet-4-5');
            expect(decision.isPassthrough).toBe(true);
        });
    });

    describe('Override Behavior', () => {
        it('should use global override when set', () => {
            const config = createTestConfig();
            config.overrides.globalForceModel = 'openai/gpt-4o';

            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('openai/gpt-4o');
            expect(decision.isOverride).toBe(true);
        });
    });

    describe('Dry-Run Mode', () => {
        it('should return original model in dry-run mode', () => {
            const config = createTestConfig({ dryRun: true });

            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('anthropic/claude-sonnet-4-5');
            expect(decision.isDryRun).toBe(true);
            expect(decision.reason).toContain('dry-run');
        });
    });

    describe('Disabled State', () => {
        it('should passthrough when disabled', () => {
            const config = createTestConfig({ enabled: false });

            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            expect(decision.routedModel).toBe('anthropic/claude-sonnet-4-5');
            expect(decision.isPassthrough).toBe(true);
        });
    });

    describe('Savings Calculation', () => {
        it('should calculate positive savings when routing to cheaper model', () => {
            const config = createTestConfig();

            const request = createRequest('anthropic/claude-sonnet-4-5');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            expect(decision.estimatedSavingsUsd).toBeGreaterThan(0);
        });

        it('should have zero savings when using original model', () => {
            const config = createTestConfig({ dryRun: true });

            const request = createRequest('google/gemini-2.5-flash-lite');
            const classification = createClassification(TaskTier.HEARTBEAT);

            const decision = routeRequest(request, classification, config);

            // In dry-run, uses original model
            expect(decision.estimatedSavingsUsd).toBe(0);
        });
    });

    describe('Escalation', () => {
        it('should return next tier model for escalation', () => {
            const config = createTestConfig();

            const result = getEscalatedModel(TaskTier.SIMPLE, config);

            expect(result).not.toBeNull();
            expect(result?.tier).toBe(TaskTier.MODERATE);
        });

        it('should return null when at max tier', () => {
            const config = createTestConfig();

            const result = getEscalatedModel(TaskTier.FRONTIER, config);

            expect(result).toBeNull();
        });
    });

    describe('Model Availability', () => {
        it('should return true for available models', () => {
            const config = createTestConfig();

            expect(canUseModel('openai/gpt-4o', config)).toBe(true);
        });

        it('should return false for unavailable models', () => {
            const config = createTestConfig({
                apiKeys: {
                    anthropic: '',
                    openai: '',
                    google: '',
                    deepseek: '',
                    openrouter: '',
                },
            });

            expect(canUseModel('openai/gpt-4o', config)).toBe(false);
        });
    });

    describe('Model Map', () => {
        it('should return correct model map', () => {
            const config = createTestConfig();

            const map = getModelMap(config);

            expect(map[TaskTier.HEARTBEAT]).toBe('google/gemini-2.5-flash-lite');
            expect(map[TaskTier.COMPLEX]).toBe('anthropic/claude-sonnet-4-5');
        });
    });
});
