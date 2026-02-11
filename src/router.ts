import {
    ChatCompletionRequest,
    ClassificationResult,
    ClawRouteConfig,
    RoutingDecision,
    TaskTier,
} from './types.js';
import { hasApiKey } from './config.js';
import { calculateCost, getProviderForModel } from './models.js';
import { estimateMessagesTokens } from './utils.js';

// === Plan Feature Gating (v1.1) ===

/**
 * Check if Pro features are enabled.
 * Pro is enabled if license is active OR within grace period.
 *
 * @param config - The ClawRoute configuration
 * @returns True if Pro features should be available
 */
export function isProEnabled(config: ClawRouteConfig): boolean {
    // Explicit Pro license
    if (config.license.enabled) {
        return true;
    }

    // Within grace period
    if (config.license.graceUntil) {
        const graceEnd = new Date(config.license.graceUntil);
        if (graceEnd > new Date()) {
            return true;
        }
    }

    return false;
}

/**
 * Check if MODERATE tier should use restricted routing (Free plan).
 * On Free: MODERATE routes to mid-tier only if no tools detected.
 *
 * @param tier - The task tier
 * @param toolsDetected - Whether tools were detected in request
 * @param config - The config
 * @returns True if should fall back to original model
 */
function shouldFreeModerateUseOriginal(
    tier: TaskTier,
    toolsDetected: boolean,
    config: ClawRouteConfig
): boolean {
    if (isProEnabled(config)) {
        return false; // Pro has full routing
    }
    if (tier !== TaskTier.MODERATE) {
        return false;
    }
    // Free + MODERATE + tools = use original
    return toolsDetected;
}

/**
 * Check if tier should use fallback routing on Free plan.
 * COMPLEX and FRONTIER on Free → fallback to original model.
 *
 * @param tier - The task tier
 * @param config - The config
 * @returns True if should fall back to original
 */
function shouldFreeTierUseOriginal(tier: TaskTier, config: ClawRouteConfig): boolean {
    if (isProEnabled(config)) {
        return false; // Pro has full routing
    }
    // Free plan: COMPLEX and FRONTIER fall back to original
    return tier === TaskTier.COMPLEX || tier === TaskTier.FRONTIER;
}

/**
 * Make a routing decision based on classification.
 *
 * @param request - The original request
 * @param classification - The classification result
 * @param config - The ClawRoute configuration
 * @returns The routing decision
 */
export function routeRequest(
    request: ChatCompletionRequest,
    classification: ClassificationResult,
    config: ClawRouteConfig
): RoutingDecision {
    const originalModel = request.model;
    const estimatedTokens = estimateMessagesTokens(request.messages);

    // Estimate output tokens (assume similar to input for estimation)
    const estimatedOutputTokens = Math.min(estimatedTokens, 4000);

    // Default decision structure
    let routedModel = originalModel;
    let reason = 'passthrough';
    let isOverride = false;
    let isDryRun = config.dryRun;
    let isPassthrough = false;

    // 1. Check if ClawRoute is disabled
    if (!config.enabled) {
        return {
            originalModel,
            routedModel: originalModel,
            tier: classification.tier,
            reason: 'ClawRoute disabled',
            confidence: classification.confidence,
            isDryRun: false,
            isOverride: false,
            isPassthrough: true,
            estimatedSavingsUsd: 0,
            safeToRetry: classification.safeToRetry,
        };
    }

    // 2. Check global force override
    if (config.overrides.globalForceModel) {
        routedModel = config.overrides.globalForceModel;
        reason = `global override: ${routedModel}`;
        isOverride = true;
    }

    // 3. Check session override (would need session ID from request - skip for now)
    // Session overrides would be handled via headers or other mechanisms

    // 4. Normal routing based on tier (if no override)
    if (!isOverride) {
        const tier = classification.tier;
        const tierConfig = config.models[tier];

        // v1.1: Check Free/Pro plan gating
        const proEnabled = isProEnabled(config);

        // Free plan: COMPLEX and FRONTIER fall back to original
        if (shouldFreeTierUseOriginal(tier, config)) {
            routedModel = originalModel;
            reason = `tier ${tier}: Free plan - complex routing requires Pro`;
            isPassthrough = true;
        }
        // Free plan: MODERATE with tools falls back to original
        else if (shouldFreeModerateUseOriginal(tier, classification.toolsDetected, config)) {
            routedModel = originalModel;
            reason = `tier ${tier}: Free plan - tool-aware routing requires Pro`;
            isPassthrough = true;
        }
        // Normal tier routing (Free HEARTBEAT/SIMPLE or Pro any tier)
        else if (tierConfig) {
            // Try primary model
            const primaryProvider = getProviderForModel(tierConfig.primary);
            if (hasApiKey(config, primaryProvider)) {
                routedModel = tierConfig.primary;
                reason = `tier ${tier}: primary model${proEnabled ? '' : ' (Free)'}`;
            } else {
                // Try fallback model
                const fallbackProvider = getProviderForModel(tierConfig.fallback);
                if (hasApiKey(config, fallbackProvider)) {
                    routedModel = tierConfig.fallback;
                    reason = `tier ${tier}: fallback model (primary unavailable)`;
                } else {
                    // No models available for this tier, passthrough
                    routedModel = originalModel;
                    reason = `tier ${tier}: no API keys for configured models, passthrough`;
                    isPassthrough = true;
                }
            }
        } else {
            // No tier config, passthrough
            routedModel = originalModel;
            reason = `tier ${tier}: no config, passthrough`;
            isPassthrough = true;
        }
    }

    // 5. Dry-run mode: use original model but log what would have been used
    if (isDryRun) {
        const wouldHaveRouted = routedModel;
        routedModel = originalModel;
        reason = `dry-run: would route to ${wouldHaveRouted}`;
    }

    // 6. Calculate estimated savings
    const originalCost = calculateCost(originalModel, estimatedTokens, estimatedOutputTokens);
    const routedCost = calculateCost(routedModel, estimatedTokens, estimatedOutputTokens);
    const estimatedSavingsUsd = Math.max(0, originalCost - routedCost);

    return {
        originalModel,
        routedModel,
        tier: classification.tier,
        reason,
        confidence: classification.confidence,
        isDryRun,
        isOverride,
        isPassthrough,
        estimatedSavingsUsd,
        safeToRetry: classification.safeToRetry,
    };
}

/**
 * Get the next tier model for escalation.
 *
 * @param currentTier - The current tier
 * @param config - The ClawRoute configuration
 * @returns The next tier's primary model, or null if at maximum
 */
export function getEscalatedModel(
    currentTier: TaskTier,
    config: ClawRouteConfig
): { model: string; tier: TaskTier } | null {
    const tierOrder: TaskTier[] = [
        TaskTier.HEARTBEAT,
        TaskTier.SIMPLE,
        TaskTier.MODERATE,
        TaskTier.COMPLEX,
        TaskTier.FRONTIER,
    ];

    const currentIndex = tierOrder.indexOf(currentTier);
    if (currentIndex === -1 || currentIndex >= tierOrder.length - 1) {
        // Already at max tier or unknown tier
        return null;
    }

    // Try each higher tier until we find one with an available model
    for (let i = currentIndex + 1; i < tierOrder.length; i++) {
        const nextTier = tierOrder[i];
        if (!nextTier) continue;

        const tierConfig = config.models[nextTier];
        if (!tierConfig) continue;

        // Try primary
        const primaryProvider = getProviderForModel(tierConfig.primary);
        if (hasApiKey(config, primaryProvider)) {
            return { model: tierConfig.primary, tier: nextTier };
        }

        // Try fallback
        const fallbackProvider = getProviderForModel(tierConfig.fallback);
        if (hasApiKey(config, fallbackProvider)) {
            return { model: tierConfig.fallback, tier: nextTier };
        }
    }

    return null;
}

/**
 * Check if a model can be used (has API key).
 *
 * @param modelId - The model ID
 * @param config - The ClawRoute configuration
 * @returns Whether the model can be used
 */
export function canUseModel(modelId: string, config: ClawRouteConfig): boolean {
    const provider = getProviderForModel(modelId);
    return hasApiKey(config, provider);
}

/**
 * Get all available models for routing.
 *
 * @param config - The ClawRoute configuration
 * @returns Array of available model IDs
 */
export function getAvailableModels(config: ClawRouteConfig): string[] {
    const models: string[] = [];

    for (const tier of Object.values(TaskTier)) {
        const tierConfig = config.models[tier];
        if (!tierConfig) continue;

        const primaryProvider = getProviderForModel(tierConfig.primary);
        if (hasApiKey(config, primaryProvider)) {
            if (!models.includes(tierConfig.primary)) {
                models.push(tierConfig.primary);
            }
        }

        const fallbackProvider = getProviderForModel(tierConfig.fallback);
        if (hasApiKey(config, fallbackProvider)) {
            if (!models.includes(tierConfig.fallback)) {
                models.push(tierConfig.fallback);
            }
        }
    }

    return models;
}

/**
 * Get the model map configuration for display.
 *
 * @param config - The ClawRoute configuration
 * @returns Map of tier to primary model
 */
export function getModelMap(config: ClawRouteConfig): Record<TaskTier, string> {
    const map: Record<TaskTier, string> = {
        [TaskTier.HEARTBEAT]: config.models[TaskTier.HEARTBEAT]?.primary ?? 'unknown',
        [TaskTier.SIMPLE]: config.models[TaskTier.SIMPLE]?.primary ?? 'unknown',
        [TaskTier.MODERATE]: config.models[TaskTier.MODERATE]?.primary ?? 'unknown',
        [TaskTier.COMPLEX]: config.models[TaskTier.COMPLEX]?.primary ?? 'unknown',
        [TaskTier.FRONTIER]: config.models[TaskTier.FRONTIER]?.primary ?? 'unknown',
    };

    return map;
}
