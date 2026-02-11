/**
 * ClawRoute Stats Aggregation
 *
 * Queries for computing statistics from the routing log.
 */

import { PeriodStats, StatsResponse, TaskTier, ClawRouteConfig, DonationSummary } from './types.js';
import { getDb, getRecentDecisions } from './logger.js';
import { getModelMap } from './router.js';
import { Database } from 'sql.js';

/**
 * Create empty period stats.
 */
function emptyPeriodStats(): PeriodStats {
    return {
        requests: 0,
        originalCostUsd: 0,
        actualCostUsd: 0,
        savingsUsd: 0,
        savingsPercent: 0,
        tierBreakdown: {
            [TaskTier.HEARTBEAT]: 0,
            [TaskTier.SIMPLE]: 0,
            [TaskTier.MODERATE]: 0,
            [TaskTier.COMPLEX]: 0,
            [TaskTier.FRONTIER]: 0,
        },
        escalations: 0,
        dryRunRequests: 0,
    };
}

/**
 * Get stats for a specific time period.
 *
 * @param db - The database instance
 * @param whereClause - SQL WHERE clause for the period
 * @returns Period stats
 */
function getStatsByPeriod(db: Database, whereClause: string): PeriodStats {
    const stats = emptyPeriodStats();

    try {
        // Main aggregates
        const mainResult = db.exec(`
      SELECT
        COUNT(*) as requests,
        COALESCE(SUM(original_cost_usd), 0) as original_cost,
        COALESCE(SUM(actual_cost_usd), 0) as actual_cost,
        COALESCE(SUM(savings_usd), 0) as savings,
        COALESCE(SUM(CASE WHEN escalated = 1 THEN 1 ELSE 0 END), 0) as escalations,
        COALESCE(SUM(CASE WHEN is_dry_run = 1 THEN 1 ELSE 0 END), 0) as dry_runs
      FROM routing_log
      ${whereClause ? `WHERE ${whereClause}` : ''}
    `);

        if (mainResult[0] && mainResult[0].values[0]) {
            const row = mainResult[0].values[0];
            stats.requests = row[0] as number;
            stats.originalCostUsd = row[1] as number;
            stats.actualCostUsd = row[2] as number;
            stats.savingsUsd = row[3] as number;
            stats.escalations = row[4] as number;
            stats.dryRunRequests = row[5] as number;

            if (stats.originalCostUsd > 0) {
                stats.savingsPercent = (stats.savingsUsd / stats.originalCostUsd) * 100;
            }
        }

        // Tier breakdown
        const tierResult = db.exec(`
      SELECT tier, COUNT(*) as count
      FROM routing_log
      ${whereClause ? `WHERE ${whereClause}` : ''}
      GROUP BY tier
    `);

        if (tierResult[0]) {
            for (const row of tierResult[0].values) {
                const tier = row[0] as string;
                const count = row[1] as number;
                if (tier in stats.tierBreakdown) {
                    stats.tierBreakdown[tier as TaskTier] = count;
                }
            }
        }
    } catch (error) {
        console.error('Failed to get stats:', error);
    }

    return stats;
}

/**
 * Get complete stats response.
 *
 * @param config - The ClawRoute configuration
 * @returns Stats response with all periods
 */
export function getStatsResponse(config: ClawRouteConfig): StatsResponse {
    const db = getDb();

    const response: StatsResponse = {
        today: emptyPeriodStats(),
        thisWeek: emptyPeriodStats(),
        thisMonth: emptyPeriodStats(),
        allTime: emptyPeriodStats(),
        recentDecisions: [],
        config: {
            enabled: config.enabled,
            dryRun: config.dryRun,
            modelMap: getModelMap(config),
            activeOverrides: Object.keys(config.overrides.sessions).length +
                (config.overrides.globalForceModel ? 1 : 0),
        },
    };

    if (!db) {
        return response;
    }

    // Get stats for each period
    response.today = getStatsByPeriod(db, "date(timestamp) = date('now')");
    response.thisWeek = getStatsByPeriod(db, "timestamp >= datetime('now', '-7 days')");
    response.thisMonth = getStatsByPeriod(db, "timestamp >= datetime('now', '-30 days')");
    response.allTime = getStatsByPeriod(db, '');

    // Get recent decisions (already returns RecentDecision[])
    response.recentDecisions = getRecentDecisions(30);

    return response;
}

/**
 * Get formatted stats string for CLI display.
 *
 * @param stats - The stats response
 * @param period - Which period to display
 * @returns Formatted string
 */
export function formatStatsForCli(
    stats: StatsResponse,
    period: 'today' | 'week' | 'month' | 'all' = 'today'
): string {
    const periodStats =
        period === 'today'
            ? stats.today
            : period === 'week'
                ? stats.thisWeek
                : period === 'month'
                    ? stats.thisMonth
                    : stats.allTime;

    const periodLabel =
        period === 'today'
            ? 'Today'
            : period === 'week'
                ? 'This Week'
                : period === 'month'
                    ? 'This Month'
                    : 'All Time';

    const lines: string[] = [
        '┌─────────────────────────────────────┐',
        `│     ClawRoute Stats (${periodLabel.padEnd(10)})  │`,
        '├─────────────────────────────────────┤',
        `│  Requests:      ${String(periodStats.requests).padStart(6)}              │`,
        `│  Original cost: $${periodStats.originalCostUsd.toFixed(2).padStart(7)}            │`,
        `│  Actual cost:   $${periodStats.actualCostUsd.toFixed(2).padStart(7)}            │`,
        `│  Savings:       $${periodStats.savingsUsd.toFixed(2).padStart(7)} (${periodStats.savingsPercent.toFixed(1)}%)     │`,
        '│                                     │',
    ];

    for (const tier of [TaskTier.HEARTBEAT, TaskTier.SIMPLE, TaskTier.MODERATE, TaskTier.COMPLEX, TaskTier.FRONTIER]) {
        const count = periodStats.tierBreakdown[tier];
        const model = stats.config.modelMap[tier] ?? 'unknown';
        const shortModel = model.split('/').pop() ?? model;
        lines.push(`│  ${tier.padEnd(10)} ${String(count).padStart(4)}  → ${shortModel.padEnd(12)}│`);
    }

    lines.push(`│  Escalations: ${String(periodStats.escalations).padStart(4)}                  │`);
    lines.push('└─────────────────────────────────────┘');

    return lines.join('\n');
}

/**
 * Get a summary line for startup.
 *
 * @param config - The ClawRoute configuration
 * @returns Summary string
 */
export function getStartupSummary(config: ClawRouteConfig): string {
    const db = getDb();
    if (!db) return 'No database initialized';

    const stats = getStatsResponse(config);

    if (stats.allTime.requests === 0) {
        return 'No routing history yet. Start making requests!';
    }

    return `Total savings: $${stats.allTime.savingsUsd.toFixed(2)} across ${stats.allTime.requests} requests (${stats.allTime.savingsPercent.toFixed(1)}% savings rate)`;
}

// === Donation Summary (v1.1) ===

/**
 * Get donation summary for the current month.
 *
 * @param config - The ClawRoute configuration
 * @returns DonationSummary
 */
export function getDonationSummary(config: ClawRouteConfig): DonationSummary {
    const db = getDb();

    // Get current month boundaries
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // Default empty summary
    const emptySummary: DonationSummary = {
        monthStart: monthStart.toISOString(),
        monthEnd: monthEnd.toISOString(),
        savingsUsd: 0,
        originalCostUsd: 0,
        actualCostUsd: 0,
        percentSavings: 0,
        suggestedUsd: config.donations.minMonthlyUsd,
        requests: 0,
    };

    if (!db) {
        return emptySummary;
    }

    try {
        // Query monthly stats
        const whereClause = `date(timestamp) >= date('${monthStart.toISOString().split('T')[0]}')`;

        const result = db.exec(`
      SELECT
        COUNT(*) as requests,
        COALESCE(SUM(original_cost_usd), 0) as original_cost,
        COALESCE(SUM(actual_cost_usd), 0) as actual_cost,
        COALESCE(SUM(savings_usd), 0) as savings
      FROM routing_log
      WHERE ${whereClause}
    `);

        if (result[0] && result[0].values[0]) {
            const row = result[0].values[0];
            const requests = row[0] as number;
            const originalCostUsd = row[1] as number;
            const actualCostUsd = row[2] as number;
            const savingsUsd = row[3] as number;

            const percentSavings = originalCostUsd > 0
                ? (savingsUsd / originalCostUsd) * 100
                : 0;

            // Suggested donation: purely voluntary, defaults to min monthly
            const suggestedUsd = config.donations.minMonthlyUsd;

            return {
                monthStart: monthStart.toISOString(),
                monthEnd: monthEnd.toISOString(),
                savingsUsd,
                originalCostUsd,
                actualCostUsd,
                percentSavings,
                suggestedUsd,
                requests,
            };
        }
    } catch {
        // Return empty summary on error
    }

    return emptySummary;
}

