/**
 * ClawRoute Model Registry
 *
 * Static registry of supported models with their costs and capabilities.
 * Users can override via config, but these are sensible defaults.
 */

import { ModelEntry, ProviderType } from './types.js';

/**
 * Default models with their costs and capabilities.
 * Costs are in USD per 1M tokens (as of February 2026).
 */
export const DEFAULT_MODELS: ModelEntry[] = [
    // Ultra-cheap tier (heartbeat/simple)
    {
        id: 'google/gemini-2.5-flash-lite',
        provider: 'google',
        inputCostPer1M: 0.10,
        outputCostPer1M: 0.40,
        maxContext: 1000000,
        toolCapable: false,
        multimodal: false,
        enabled: true,
    },
    {
        id: 'deepseek/deepseek-chat',
        provider: 'deepseek',
        inputCostPer1M: 0.28,
        outputCostPer1M: 1.12,
        maxContext: 64000,
        toolCapable: true,
        multimodal: false,
        enabled: true,
    },

    // Mid-tier (moderate)
    {
        id: 'google/gemini-2.5-flash',
        provider: 'google',
        inputCostPer1M: 0.30,
        outputCostPer1M: 2.50,
        maxContext: 1000000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'openai/gpt-5-mini',
        provider: 'openai',
        inputCostPer1M: 0.25,
        outputCostPer1M: 2.00,
        maxContext: 128000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },

    // High-tier (complex)
    {
        id: 'anthropic/claude-sonnet-4-6',
        provider: 'anthropic',
        inputCostPer1M: 3.00,
        outputCostPer1M: 15.00,
        maxContext: 200000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'google/gemini-2.5-pro',
        provider: 'google',
        inputCostPer1M: 1.25,
        outputCostPer1M: 10.00,
        maxContext: 1000000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'openai/gpt-5.2',
        provider: 'openai',
        inputCostPer1M: 1.75,
        outputCostPer1M: 14.00,
        maxContext: 128000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },

    // Frontier tier
    {
        id: 'openai/o3',
        provider: 'openai',
        inputCostPer1M: 2.00,
        outputCostPer1M: 8.00,
        maxContext: 200000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
    {
        id: 'anthropic/claude-opus-4-6',
        provider: 'anthropic',
        inputCostPer1M: 15.00,
        outputCostPer1M: 75.00,
        maxContext: 200000,
        toolCapable: true,
        multimodal: true,
        enabled: true,
    },
];

/**
 * Model registry mapping model IDs to their entries.
 */
const modelRegistry = new Map<string, ModelEntry>();

// Initialize the registry with default models
for (const model of DEFAULT_MODELS) {
    modelRegistry.set(model.id, model);
}

/**
 * Get a model entry by its ID.
 *
 * @param modelId - The model ID to look up
 * @returns The model entry or null if not found
 */
export function getModelEntry(modelId: string): ModelEntry | null {
    // First try exact match
    const exact = modelRegistry.get(modelId);
    if (exact) return exact;

    // Try without provider prefix
    for (const [id, entry] of modelRegistry) {
        if (id.endsWith(`/${modelId}`) || modelId.endsWith(`/${id.split('/')[1]}`)) {
            return entry;
        }
    }

    // Try fuzzy match on model name
    const normalizedId = modelId.toLowerCase();
    for (const [id, entry] of modelRegistry) {
        const normalizedEntryId = id.toLowerCase();
        if (normalizedEntryId.includes(normalizedId) || normalizedId.includes(normalizedEntryId)) {
            return entry;
        }
    }

    return null;
}

/**
 * Extract the provider from a model ID.
 *
 * @param modelId - The model ID (e.g., "anthropic/claude-sonnet-4-6")
 * @returns The provider type
 */
export function getProviderForModel(modelId: string): ProviderType {
    // Check if model ID has provider prefix
    if (modelId.includes('/')) {
        const prefix = modelId.split('/')[0]?.toLowerCase();
        if (prefix === 'anthropic' || prefix === 'openai' || prefix === 'google' || prefix === 'deepseek' || prefix === 'openrouter') {
            return prefix as ProviderType;
        }
    }

    // Look up in registry
    const entry = getModelEntry(modelId);
    if (entry) return entry.provider;

    // Default heuristics based on model name
    const lowerModelId = modelId.toLowerCase();
    if (lowerModelId.includes('claude')) return 'anthropic';
    if (lowerModelId.includes('gpt') || lowerModelId.includes('o3') || lowerModelId.includes('o1')) return 'openai';
    if (lowerModelId.includes('gemini')) return 'google';
    if (lowerModelId.includes('deepseek')) return 'deepseek';

    // Default to OpenAI-compatible
    return 'openai';
}

/**
 * Calculate the cost for a request.
 *
 * @param modelId - The model ID
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @returns Cost in USD
 */
export function calculateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number
): number {
    const entry = getModelEntry(modelId);

    if (!entry) {
        // Unknown model - use a conservative estimate (GPT-5.2 pricing)
        const defaultInputCost = 1.75;
        const defaultOutputCost = 14.00;
        return (inputTokens / 1_000_000) * defaultInputCost + (outputTokens / 1_000_000) * defaultOutputCost;
    }

    const inputCost = (inputTokens / 1_000_000) * entry.inputCostPer1M;
    const outputCost = (outputTokens / 1_000_000) * entry.outputCostPer1M;

    return inputCost + outputCost;
}

/**
 * Get the API base URL for a provider.
 *
 * @param provider - The provider type
 * @returns The API base URL
 */
export function getApiBaseUrl(provider: ProviderType): string {
    switch (provider) {
        case 'anthropic':
            return 'https://api.anthropic.com/v1';
        case 'openai':
            return 'https://api.openai.com/v1';
        case 'google':
            return 'https://generativelanguage.googleapis.com/v1beta/openai';
        case 'deepseek':
            return 'https://api.deepseek.com/v1';
        case 'openrouter':
            return 'https://openrouter.ai/api/v1';
        default:
            return 'https://api.openai.com/v1';
    }
}

/**
 * Get the authentication headers for a provider.
 *
 * @param provider - The provider type
 * @param apiKey - The API key
 * @returns Headers object
 */
export function getAuthHeader(
    provider: ProviderType,
    apiKey: string
): Record<string, string> {
    switch (provider) {
        case 'anthropic':
            return {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            };
        case 'openai':
        case 'deepseek':
        case 'openrouter':
        case 'google':
        default:
            return {
                'Authorization': `Bearer ${apiKey}`,
            };
    }
}

/**
 * Check if a model is tool-capable.
 *
 * @param modelId - The model ID
 * @returns Whether the model supports tool calling
 */
export function isToolCapable(modelId: string): boolean {
    const entry = getModelEntry(modelId);
    return entry?.toolCapable ?? true; // Assume capable if unknown
}

/**
 * Register a custom model.
 *
 * @param model - The model entry to register
 */
export function registerModel(model: ModelEntry): void {
    modelRegistry.set(model.id, model);
}

/**
 * Get all registered models.
 *
 * @returns Array of all model entries
 */
export function getAllModels(): ModelEntry[] {
    return Array.from(modelRegistry.values());
}
