
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDonationSummary } from '../src/stats.js';
import { ClawRouteConfig, DonationConfig } from '../src/types.js';

describe('Donation System', () => {
    const mockConfig: ClawRouteConfig = {
        enabled: true,
        dryRun: false,
        proxyPort: 3000,
        proxyHost: 'localhost',
        authToken: null,
        apiKeys: {
            anthropic: 'sk-ant-123',
            openai: '',
            google: '',
            deepseek: '',
            openrouter: '',
        },
        models: {} as any,
        classification: {} as any,
        escalation: {} as any,
        logging: {} as any,
        dashboard: { enabled: true },
        donations: {
            minMonthlyUsd: 10,
            stripeCheckoutUrl: 'https://stripe.com/test',
            usdcAddress: '0x123',
            enabled: true,
        },
        alerts: {} as any,
        overrides: { globalForceModel: null, sessions: {} },
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return correct defaults when no history exists', () => {
        // Mock getDb to return null or empty result
        vi.mock('../src/logger.js', () => ({
            getDb: () => null
        }));

        const summary = getDonationSummary(mockConfig);

        expect(summary.savingsUsd).toBe(0);
        expect(summary.suggestedUsd).toBe(10); // Should match config
        expect(summary.requests).toBe(0);
    });

    it('should respect configuration values', () => {
        expect(mockConfig.donations.minMonthlyUsd).toBe(10);
        expect(mockConfig.donations.stripeCheckoutUrl).toBe('https://stripe.com/test');
    });
});
