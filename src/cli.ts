#!/usr/bin/env node

/**
 * ClawRoute CLI
 *
 * Command-line interface for ClawRoute management.
 * All commands (except start) communicate with running instance via HTTP.
 */

const DEFAULT_HOST = 'http://127.0.0.1:18790';

interface StatsResponse {
    today: PeriodStats;
    thisWeek: PeriodStats;
    thisMonth: PeriodStats;
    allTime: PeriodStats;
    config: {
        enabled: boolean;
        dryRun: boolean;
        modelMap: Record<string, string>;
    };
    recentDecisions: Array<{
        timestamp: string;
        tier: string;
        originalModel: string;
        routedModel: string;
        savingsUsd: number;
        escalated: boolean;
        reason: string;
        responseTimeMs: number;
    }>;
}

interface PeriodStats {
    requests: number;
    originalCostUsd: number;
    actualCostUsd: number;
    savingsUsd: number;
    savingsPercent: number;
    tierBreakdown: Record<string, number>;
    escalations: number;
}

/**
 * Print usage help.
 */
function printHelp(): void {
    console.log(`
ClawRoute CLI v1.1

Usage: clawroute <command> [options]

Commands:
  start              Start the ClawRoute proxy server
  stats              Show today's routing stats
  stats --week       Show this week's stats
  stats --month      Show this month's stats
  stats --all        Show all-time stats
  enable             Enable ClawRoute routing
  disable            Disable ClawRoute (passthrough mode)
  dry-run            Enable dry-run mode
  live               Disable dry-run mode (go live)
  log                Show last 20 routing decisions
  config             Show current configuration
  billing            Show billing summary and suggested payment
  license            Show license status
  license --enable   Enable Pro license (with token)
  license --disable  Disable Pro license
  help               Show this help message

Examples:
  clawroute start           # Start the proxy server
  clawroute stats           # Show today's stats
  clawroute billing         # Show billing info
  clawroute license         # Show license status

Environment:
  CLAWROUTE_HOST     Target host for CLI commands (default: ${DEFAULT_HOST})
  CLAWROUTE_LICENSE  Pro license token (honorware)
`);
}

/**
 * Make HTTP request to the running ClawRoute instance.
 */
async function request(
    path: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    body?: unknown
): Promise<unknown> {
    const host = process.env['CLAWROUTE_HOST'] ?? DEFAULT_HOST;
    const url = `${host}${path}`;

    try {
        const response = await fetch(url, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text}`);
        }

        return await response.json();
    } catch (error) {
        if (error instanceof TypeError && error.message.includes('fetch')) {
            console.error(
                `❌ Cannot connect to ClawRoute at ${host}`
            );
            console.error('   Is the server running? Start it with: clawroute start');
            process.exit(1);
        }
        throw error;
    }
}

/**
 * Format stats for display.
 */
function formatStats(stats: PeriodStats, label: string, modelMap: Record<string, string>): void {
    console.log('┌─────────────────────────────────────┐');
    console.log(`│     ClawRoute Stats (${label.padEnd(10)})  │`);
    console.log('├─────────────────────────────────────┤');
    console.log(`│  Requests:      ${String(stats.requests).padStart(6)}              │`);
    console.log(`│  Original cost: $${stats.originalCostUsd.toFixed(2).padStart(7)}            │`);
    console.log(`│  Actual cost:   $${stats.actualCostUsd.toFixed(2).padStart(7)}            │`);
    console.log(
        `│  Savings:       $${stats.savingsUsd.toFixed(2).padStart(7)} (${stats.savingsPercent.toFixed(1)}%)     │`
    );
    console.log('│                                     │');

    // Tier breakdown
    const tiers = ['heartbeat', 'simple', 'moderate', 'complex', 'frontier'];
    for (const tier of tiers) {
        const count = stats.tierBreakdown[tier] ?? 0;
        const model = modelMap[tier] ?? 'unknown';
        const shortModel = model.split('/').pop() ?? model;
        console.log(
            `│  ${tier.padEnd(10)} ${String(count).padStart(4)}  → ${shortModel.padEnd(12)}│`
        );
    }

    console.log(`│  Escalations: ${String(stats.escalations).padStart(4)}                  │`);
    console.log('└─────────────────────────────────────┘');
}

/**
 * Show stats command.
 */
async function showStats(period: 'today' | 'week' | 'month' | 'all'): Promise<void> {
    const response = (await request('/stats')) as StatsResponse;

    const periodStats =
        period === 'today'
            ? response.today
            : period === 'week'
                ? response.thisWeek
                : period === 'month'
                    ? response.thisMonth
                    : response.allTime;

    const label =
        period === 'today'
            ? 'Today'
            : period === 'week'
                ? 'This Week'
                : period === 'month'
                    ? 'This Month'
                    : 'All Time';

    formatStats(periodStats, label, response.config.modelMap);

    // Status line
    const status = response.config.enabled
        ? response.config.dryRun
            ? '🔬 DRY-RUN'
            : '🟢 LIVE'
        : '⏸️  DISABLED';
    console.log(`\nStatus: ${status}`);
}

/**
 * Show log command.
 */
async function showLog(): Promise<void> {
    const response = (await request('/stats')) as StatsResponse;

    console.log('┌────────────────────────────────────────────────────────────────────┐');
    console.log('│                    Recent Routing Decisions                        │');
    console.log('├──────────┬────────────┬───────────────────────┬─────────┬──────────┤');
    console.log('│ Time     │ Tier       │ Routed To             │ Saved   │ Status   │');
    console.log('├──────────┼────────────┼───────────────────────┼─────────┼──────────┤');

    for (const decision of response.recentDecisions.slice(0, 20)) {
        const time = new Date(decision.timestamp).toLocaleTimeString().slice(0, 5);
        const tier = decision.tier.padEnd(10);
        const model = (decision.routedModel.split('/').pop() ?? decision.routedModel)
            .slice(0, 21)
            .padEnd(21);
        const saved = `$${decision.savingsUsd.toFixed(2)}`.padStart(7);
        const status = decision.escalated ? '⬆️ ESC' : '  ✓  ';
        console.log(`│ ${time}    │ ${tier} │ ${model} │ ${saved} │ ${status}   │`);
    }

    console.log('└──────────┴────────────┴───────────────────────┴─────────┴──────────┘');
}

/**
 * Show config command.
 */
async function showConfig(): Promise<void> {
    const response = await request('/api/config');
    console.log(JSON.stringify(response, null, 2));
}

/**
 * Enable ClawRoute.
 */
async function enableClawRoute(): Promise<void> {
    await request('/api/enable', 'POST');
    console.log('✅ ClawRoute enabled');
}

/**
 * Disable ClawRoute.
 */
async function disableClawRoute(): Promise<void> {
    await request('/api/disable', 'POST');
    console.log('⏸️  ClawRoute disabled (passthrough mode)');
}

/**
 * Enable dry-run mode.
 */
async function enableDryRun(): Promise<void> {
    await request('/api/dry-run/enable', 'POST');
    console.log('🔬 Dry-run mode enabled');
}

/**
 * Disable dry-run mode.
 */
async function disableDryRun(): Promise<void> {
    await request('/api/dry-run/disable', 'POST');
    console.log('🚀 Dry-run mode disabled (live mode)');
}

// Note: Server starts via dynamic import in switch statement, this function is not needed

/**
 * Main CLI entry point.
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'start':
            // Import and run the server
            await import('./index.js');
            break;

        case 'stats':
            if (args.includes('--week')) {
                await showStats('week');
            } else if (args.includes('--month')) {
                await showStats('month');
            } else if (args.includes('--all')) {
                await showStats('all');
            } else {
                await showStats('today');
            }
            break;

        case 'log':
            await showLog();
            break;

        case 'config':
            await showConfig();
            break;

        case 'enable':
            await enableClawRoute();
            break;

        case 'disable':
            await disableClawRoute();
            break;

        case 'dry-run':
            await enableDryRun();
            break;

        case 'live':
            await disableDryRun();
            break;

        case 'help':
        case '--help':
        case '-h':
            printHelp();
            break;

        case 'billing':
            await showBilling();
            break;

        case 'license':
            await handleLicense(args);
            break;

        default:
            if (command) {
                console.error(`Unknown command: ${command}`);
            }
            printHelp();
            process.exit(command ? 1 : 0);
    }
}

// === v1.1 Billing & License Commands ===

interface BillingSummary {
    monthStart: string;
    monthEnd: string;
    savingsUsd: number;
    originalCostUsd: number;
    actualCostUsd: number;
    percentSavings: number;
    proRatePercent: number;
    minMonthlyUsd: number;
    suggestedUsd: number;
    plan: string;
    graceActive: boolean;
    requests: number;
}

interface LicenseStatus {
    enabled: boolean;
    plan: string;
    graceUntil: string | null;
    graceActive: boolean;
}

async function showBilling(): Promise<void> {
    const data = await request('/billing/summary') as BillingSummary;

    console.log('\n💰 ClawRoute Billing Summary\n');
    console.log(`  Plan:                ${data.plan.toUpperCase()}${data.graceActive ? ' (Trial)' : ''}`);
    console.log(`  This Month Savings:  $${data.savingsUsd.toFixed(2)}`);
    console.log(`  This Month Requests: ${data.requests}`);
    console.log(`  Savings Rate:        ${data.percentSavings.toFixed(1)}%`);
    console.log('');
    console.log(`  Pro Rate:            ${(data.proRatePercent * 100).toFixed(0)}% of savings`);
    console.log(`  Minimum Monthly:     $${data.minMonthlyUsd.toFixed(2)}`);
    console.log(`  Suggested Payment:   $${data.suggestedUsd.toFixed(2)}`);
    console.log('');

    if (data.graceActive) {
        console.log('  ⏳ Trial period active. Pro features enabled.');
    } else if (data.plan === 'free') {
        console.log('  💡 Upgrade to Pro for full routing capabilities.');
    }
}

async function handleLicense(args: string[]): Promise<void> {
    const option = args[0];

    if (option === '--enable') {
        const token = args[1] || process.env['CLAWROUTE_LICENSE'] || 'pro-token';
        await request('/license/enable', 'POST', { token });
        console.log('✅ Pro license enabled');
        return;
    }

    if (option === '--disable') {
        await request('/license/disable', 'POST');
        console.log('✅ License disabled, grace period started');
        return;
    }

    // Default: show status
    const data = await request('/license/status') as LicenseStatus;

    console.log('\n🔑 ClawRoute License Status\n');
    console.log(`  Plan:         ${data.plan.toUpperCase()}`);
    console.log(`  Enabled:      ${data.enabled ? 'Yes' : 'No'}`);
    console.log(`  Grace Active: ${data.graceActive ? 'Yes' : 'No'}`);

    if (data.graceUntil) {
        console.log(`  Grace Until:  ${new Date(data.graceUntil).toLocaleDateString()}`);
    }
    console.log('');
}

main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
});
