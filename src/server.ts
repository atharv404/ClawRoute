/**
 * ClawRoute HTTP Server
 *
 * Hono-based HTTP proxy server with all routes.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import {
    ChatCompletionRequest,
    ClawRouteConfig,
    LogEntry,
} from './types.js';
import { createAuthMiddleware } from './auth.js';
import { classifyRequest, explainClassification } from './classifier.js';
import { routeRequest } from './router.js';
import { executeRequest, executePassthrough } from './executor.js';
import { logRouting, recordPayment } from './logger.js';
import { getStatsResponse, getDonationSummary } from './stats.js';
import { getRedactedConfig } from './config.js';
import { generateRequestId, nowIso } from './utils.js';
import { getAllModels } from './models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json at startup
const _require = createRequire(import.meta.url);
const PKG_VERSION: string = (_require('../package.json') as { version: string }).version ?? '1.2.0';

/**
 * Create the Hono application.
 *
 * @param config - The ClawRoute configuration
 * @returns Configured Hono app
 */
export function createApp(config: ClawRouteConfig): Hono {
    const app = new Hono();

    // CORS for dashboard
    app.use('*', cors());

    // Auth middleware
    app.use('/v1/*', createAuthMiddleware(config));
    app.use('/api/*', createAuthMiddleware(config));

    // Health check
    app.get('/health', (c) => {
        return c.json({
            status: 'ok',
            version: PKG_VERSION,
            enabled: config.enabled,
            dryRun: config.dryRun,
            timestamp: nowIso(),
        });
    });

    // OpenAI-compatible model list — required by OpenClaw, Cursor, Continue.dev etc.
    // to verify the provider during configuration.
    app.get('/v1/models', (c) => {
        const now = Math.floor(Date.now() / 1000);
        const registeredModels = getAllModels();

        // Collect the unique models actively used in tier config
        const tierModelIds = new Set<string>();
        for (const tierCfg of Object.values(config.models)) {
            if (tierCfg.primary)  tierModelIds.add(tierCfg.primary);
            if (tierCfg.fallback) tierModelIds.add(tierCfg.fallback);
        }

        // Build the OpenAI-spec model list from the registry + active tier models
        const allIds = new Set([
            ...registeredModels.map((m) => m.id),
            ...tierModelIds,
        ]);

        const data = Array.from(allIds).map((id) => ({
            id,
            object: 'model',
            created: now,
            owned_by: id.includes('/') ? id.split('/')[0] : 'clawroute',
        }));

        return c.json({ object: 'list', data });
    });

    // Single model lookup — some clients call GET /v1/models/:model
    app.get('/v1/models/:model', (c) => {
        const modelId = c.req.param('model');
        const now = Math.floor(Date.now() / 1000);
        return c.json({
            id: modelId,
            object: 'model',
            created: now,
            owned_by: modelId.includes('/') ? modelId.split('/')[0] : 'clawroute',
        });
    });

    // Stats API
    app.get('/stats', (c) => {
        const stats = getStatsResponse(config);
        return c.json(stats);
    });

    // Dashboard
    app.get('/dashboard', (c) => {
        try {
            // Try to load from web/ directory
            const dashboardPath = join(__dirname, '..', 'web', 'dashboard.html');
            if (existsSync(dashboardPath)) {
                const html = readFileSync(dashboardPath, 'utf-8');
                return c.html(html);
            }

            // Fallback: try dist/web
            const distPath = join(__dirname, '..', 'dist', 'web', 'dashboard.html');
            if (existsSync(distPath)) {
                const html = readFileSync(distPath, 'utf-8');
                return c.html(html);
            }

            return c.html('<html><body><h1>Dashboard not found</h1><p>Please ensure web/dashboard.html exists.</p></body></html>');
        } catch (error) {
            return c.html('<html><body><h1>Error loading dashboard</h1></body></html>');
        }
    });

    // Config API (redacted)
    app.get('/api/config', (c) => {
        const redacted = getRedactedConfig(config);
        return c.json(redacted);
    });

    // Enable/disable controls
    app.post('/api/enable', (c) => {
        config.enabled = true;
        console.log('✅ ClawRoute enabled');
        return c.json({ success: true, enabled: true });
    });

    app.post('/api/disable', (c) => {
        config.enabled = false;
        console.log('⏸️  ClawRoute disabled (passthrough mode)');
        return c.json({ success: true, enabled: false });
    });

    // Dry-run controls
    app.post('/api/dry-run/enable', (c) => {
        config.dryRun = true;
        console.log('🔬 Dry-run mode enabled');
        return c.json({ success: true, dryRun: true });
    });

    app.post('/api/dry-run/disable', (c) => {
        config.dryRun = false;
        console.log('🚀 Dry-run mode disabled (live mode)');
        return c.json({ success: true, dryRun: false });
    });

    // Global override
    app.post('/api/override/global', async (c) => {
        try {
            const body = await c.req.json() as { model?: string; enabled?: boolean };

            if (body.enabled === false) {
                config.overrides.globalForceModel = null;
                console.log('🔄 Global override removed');
                return c.json({ success: true, globalForceModel: null });
            }

            if (body.model) {
                config.overrides.globalForceModel = body.model;
                console.log(`🎯 Global override set: ${body.model}`);
                return c.json({ success: true, globalForceModel: body.model });
            }

            return c.json({ error: 'Provide model or enabled: false' }, 400);
        } catch {
            return c.json({ error: 'Invalid JSON body' }, 400);
        }
    });

    // Session override
    app.post('/api/override/session', async (c) => {
        try {
            const body = await c.req.json() as {
                sessionId?: string;
                model?: string;
                turns?: number;
            };

            if (!body.sessionId || !body.model) {
                return c.json({ error: 'Provide sessionId and model' }, 400);
            }

            config.overrides.sessions[body.sessionId] = {
                model: body.model,
                remainingTurns: body.turns ?? null,
                createdAt: nowIso(),
            };

            console.log(`📌 Session override set: ${body.sessionId} → ${body.model}`);
            return c.json({ success: true, sessionId: body.sessionId, model: body.model });
        } catch {
            return c.json({ error: 'Invalid JSON body' }, 400);
        }
    });

    app.delete('/api/override/session', async (c) => {
        try {
            const body = await c.req.json() as { sessionId?: string };

            if (!body.sessionId) {
                return c.json({ error: 'Provide sessionId' }, 400);
            }

            delete config.overrides.sessions[body.sessionId];
            console.log(`🗑️  Session override removed: ${body.sessionId}`);
            return c.json({ success: true, sessionId: body.sessionId });
        } catch {
            return c.json({ error: 'Invalid JSON body' }, 400);
        }
    });

    // Main proxy endpoint - OpenAI compatible
    app.post('/v1/chat/completions', async (c) => {
        const requestId = generateRequestId();

        try {
            // Parse request body
            const body = await c.req.json() as ChatCompletionRequest;

            if (config.logging.debugMode) {
                console.log(`[${requestId}] Incoming request for model: ${body.model}`);
            }

            // If ClawRoute is disabled, passthrough
            if (!config.enabled) {
                if (config.logging.debugMode) {
                    console.log(`[${requestId}] Passthrough (disabled)`);
                }
                const response = await executePassthrough(body, config);
                return response;
            }

            // Classify the request
            const classification = classifyRequest(body, config);

            if (config.logging.debugMode) {
                console.log(`[${requestId}] Classification: ${explainClassification(classification)}`);
            }

            // Route to model
            const routing = routeRequest(body, classification, config);

            if (config.logging.debugMode) {
                console.log(
                    `[${requestId}] Routing: ${routing.originalModel} → ${routing.routedModel} (${routing.reason})`
                );
            }

            // Execute the request
            const result = await executeRequest(body, routing, classification, config);

            // Log asynchronously (don't block response)
            setImmediate(() => {
                const logEntry: LogEntry = {
                    timestamp: nowIso(),
                    original_model: routing.originalModel,
                    routed_model: routing.routedModel,
                    actual_model: result.actualModel,
                    tier: routing.tier,
                    classification_reason: classification.reason,
                    confidence: classification.confidence,
                    input_tokens: result.inputTokens,
                    output_tokens: result.outputTokens,
                    original_cost_usd: result.originalCostUsd,
                    actual_cost_usd: result.actualCostUsd,
                    savings_usd: result.savingsUsd,
                    escalated: result.escalated,
                    escalation_chain: JSON.stringify(result.escalationChain),
                    response_time_ms: result.responseTimeMs,
                    had_tool_calls: result.hadToolCalls,
                    is_dry_run: routing.isDryRun,
                    is_override: routing.isOverride,
                    session_id: null,
                    error: null,
                };
                logRouting(logEntry);

                if (config.logging.debugMode) {
                    console.log(
                        `[${requestId}] Complete: ${result.responseTimeMs}ms, saved $${result.savingsUsd.toFixed(4)}`
                    );
                }
            });

            return result.response;
        } catch (error) {
            // Any error in ClawRoute logic → fall back to passthrough
            console.error(`[${requestId}] Error in ClawRoute, falling back to passthrough:`, error);

            try {
                const body = await c.req.json() as ChatCompletionRequest;
                const response = await executePassthrough(body, config);
                return response;
            } catch {
                return c.json(
                    {
                        error: {
                            message: 'Failed to process request',
                            type: 'server_error',
                            code: 'internal_error',
                        },
                    },
                    500
                );
            }
        }
    });

    // Anthropic-compatible endpoint placeholder
    app.post('/v1/messages', async (c) => {
        // For now, return a helpful error
        // Full Anthropic format support coming in v1.1
        return c.json(
            {
                error: {
                    message:
                        'Anthropic native format not yet supported in v1.0. Use OpenAI-compatible format or OpenRouter.',
                    type: 'invalid_request_error',
                    code: 'unsupported_format',
                },
            },
            400
        );
    });

    // === Donation & Billing Endpoints (v1.1) ===

    // Get donation summary
    app.get('/billing/summary', (c) => {
        const summary = getDonationSummary(config);
        return c.json(summary);
    });

    // Acknowledge donation
    app.post('/billing/acknowledge', async (c) => {
        try {
            const body = await c.req.json() as {
                amountUsd?: number;
                method?: 'stripe' | 'usdc' | 'manual';
                note?: string;
            };

            if (!body.amountUsd || !body.method) {
                return c.json({ error: 'Provide amountUsd and method' }, 400);
            }

            // Record payment in database (as a donation)
            recordPayment(body.amountUsd, body.method, body.note);

            console.log(`💰 Donation acknowledged: $${body.amountUsd} via ${body.method}`);

            // Return updated summary
            const summary = getDonationSummary(config);
            return c.json({ success: true, ...summary });
        } catch {
            return c.json({ error: 'Invalid JSON body' }, 400);
        }
    });

    // Get payment links
    app.get('/billing/paylinks', (c) => {
        return c.json({
            stripeUrl: config.donations.stripeCheckoutUrl ?? null,
            usdcAddress: config.donations.usdcAddress ?? null,
            buyMeCoffeeUrl: config.donations.buyMeCoffeeUrl ?? null,
            nowPaymentsEnabled: !!config.donations.nowPaymentsApiKey,
        });
    });

    // Create NOWPayments invoice for donation
    app.post('/billing/nowpayments/invoice', async (c) => {
        if (!config.donations.nowPaymentsApiKey) {
            return c.json({ error: 'NOWPayments not configured' }, 400);
        }

        try {
            const body = await c.req.json() as { amountUsd?: number };
            const amount = body.amountUsd ?? config.donations.minMonthlyUsd;

            const response = await fetch('https://api.nowpayments.io/v1/invoice', {
                method: 'POST',
                headers: {
                    'x-api-key': config.donations.nowPaymentsApiKey,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    price_amount: amount,
                    price_currency: 'usd',
                    order_id: `clawroute-donation-${Date.now()}`,
                    order_description: `ClawRoute Donation - $${amount}`,
                    success_url: `http://${config.proxyHost}:${config.proxyPort}/dashboard?payment=success`,
                    cancel_url: `http://${config.proxyHost}:${config.proxyPort}/dashboard?payment=cancelled`,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('NOWPayments error:', errorText);
                return c.json({ error: 'Failed to create invoice' }, 502);
            }

            const invoice = await response.json() as { invoice_url?: string; id?: string };
            console.log(`🪙 Donation invoice created: ${invoice.id}`);
            return c.json({ success: true, invoiceUrl: invoice.invoice_url, invoiceId: invoice.id });
        } catch (error) {
            console.error('NOWPayments error:', error);
            return c.json({ error: 'Failed to create invoice' }, 500);
        }
    });

    // Legacy license endpoints removed via Donationware refactor



    // Catch-all for unknown routes
    app.all('*', (c) => {
        return c.json(
            {
                error: {
                    message: `Unknown endpoint: ${c.req.method} ${c.req.path}`,
                    type: 'invalid_request_error',
                    code: 'unknown_endpoint',
                },
            },
            404
        );
    });

    return app;
}
