/**
 * ClawRoute Configuration
 *
 * Handles loading and validating configuration from:
 * 1. config/default.json (bundled defaults)
 * 2. config/clawroute.json (user customizations, if exists)
 * 3. Environment variables (highest priority)
 *
 * API keys are ONLY loaded from environment variables.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    ClawRouteConfig,
    TaskTier,
    TierModelConfig,
    ProviderType,
    DonationConfig,
    AlertsConfig,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Get the project root directory.
 */
function getProjectRoot(): string {
    // Go up from src/ or dist/ to project root
    return join(__dirname, '..');
}

/**
 * Load JSON config file safely.
 *
 * @param path - Path to the config file
 * @returns Parsed JSON or null if not found/invalid
 */
function loadJsonConfig(path: string): Record<string, unknown> | null {
    try {
        if (!existsSync(path)) {
            return null;
        }
        const content = readFileSync(path, 'utf-8');
        return JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
        console.warn(`Warning: Failed to load config from ${path}:`, error);
        return null;
    }
}

/**
 * Parse a boolean from environment variable.
 *
 * @param value - String value from env
 * @param defaultValue - Default if not set or invalid
 * @returns Parsed boolean
 */
function parseBoolEnv(value: string | undefined, defaultValue: boolean): boolean {
    if (value === undefined || value === '') return defaultValue;
    return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Parse an integer from environment variable.
 *
 * @param value - String value from env
 * @param defaultValue - Default if not set or invalid
 * @returns Parsed integer
 */
function parseIntEnv(value: string | undefined, defaultValue: number): number {
    if (value === undefined || value === '') return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Deep merge two objects.
 *
 * @param target - Target object
 * @param source - Source object to merge
 * @returns Merged object
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
    if (target === null || target === undefined) return source as T;
    if (source === null || source === undefined) return target;

    const result = { ...target } as T;

    for (const key of Object.keys(source) as Array<keyof T>) {
        const sourceValue = source[key];
        const targetValue = (target as Record<string, unknown>)[key as string];

        if (
            sourceValue !== null &&
            typeof sourceValue === 'object' &&
            !Array.isArray(sourceValue) &&
            targetValue !== null &&
            typeof targetValue === 'object' &&
            !Array.isArray(targetValue)
        ) {
            (result as Record<string, unknown>)[key as string] = deepMerge(
                targetValue,
                sourceValue as Partial<typeof targetValue>
            );
        } else if (sourceValue !== undefined) {
            (result as Record<string, unknown>)[key as string] = sourceValue;
        }
    }

    return result;
}

/**
 * Default tier model configurations.
 */
const DEFAULT_TIER_MODELS: Record<TaskTier, TierModelConfig> = {
    [TaskTier.HEARTBEAT]: {
        primary: 'google/gemini-2.5-flash-lite',
        fallback: 'deepseek/deepseek-chat',
    },
    [TaskTier.SIMPLE]: {
        primary: 'deepseek/deepseek-chat',
        fallback: 'google/gemini-2.5-flash',
    },
    [TaskTier.MODERATE]: {
        primary: 'google/gemini-2.5-flash',
        fallback: 'openai/gpt-4o-mini',
    },
    [TaskTier.COMPLEX]: {
        primary: 'anthropic/claude-sonnet-4-5',
        fallback: 'openai/gpt-4o',
    },
    [TaskTier.FRONTIER]: {
        primary: 'anthropic/claude-sonnet-4-5',
        fallback: 'openai/gpt-4o',
    },
};

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Omit<ClawRouteConfig, 'apiKeys' | 'overrides'> = {
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

    models: DEFAULT_TIER_MODELS,

    logging: {
        dbPath: './data/clawroute.db',
        logContent: false,
        logSystemPrompts: false,
        debugMode: false,
        retentionDays: 30,
    },

    dashboard: {
        enabled: true,
    },

    // v1.1: Donation defaults
    donations: {
        minMonthlyUsd: 9,
        enabled: true,
    },

    // v1.1: Alerts defaults (disabled)
    alerts: {},
};

/**
 * Load donation config from environment.
 *
 * @returns DonationConfig
 */
function loadDonationConfig(): DonationConfig {
    return {
        minMonthlyUsd: parseFloat(process.env['CLAWROUTE_DONATION_SUGGESTED'] ?? '9'),
        stripeCheckoutUrl: process.env['CLAWROUTE_DONATION_STRIPE_URL'],
        usdcAddress: process.env['CLAWROUTE_DONATION_USDC_ADDR'],
        buyMeCoffeeUrl: process.env['CLAWROUTE_DONATION_BMC_URL'],
        nowPaymentsApiKey: process.env['CLAWROUTE_NOWPAYMENTS_API_KEY'],
        enabled: true,
    };
}

/**
 * Load alerts config from environment.
 *
 * @returns AlertsConfig
 */
function loadAlertsConfig(): AlertsConfig {
    return {
        email: process.env['CLAWROUTE_ALERT_EMAIL'],
        slackWebhook: process.env['CLAWROUTE_ALERT_SLACK_WEBHOOK'],
    };
}

/**
 * Load API keys from environment variables.
 *
 * @returns Record of provider to API key
 */
function loadApiKeys(): Record<ProviderType, string> {
    return {
        anthropic: process.env['ANTHROPIC_API_KEY'] ?? '',
        openai: process.env['OPENAI_API_KEY'] ?? '',
        google: process.env['GOOGLE_API_KEY'] ?? '',
        deepseek: process.env['DEEPSEEK_API_KEY'] ?? '',
        openrouter: process.env['OPENROUTER_API_KEY'] ?? '',
    };
}

/**
 * Check if at least one API key is configured.
 *
 * @param apiKeys - The API keys record
 * @returns True if at least one key is set
 */
function hasAnyApiKey(apiKeys: Record<ProviderType, string>): boolean {
    return Object.values(apiKeys).some((key) => key && key.length > 0);
}

/**
 * Validate the configuration.
 *
 * @param config - The configuration to validate
 * @throws Error if configuration is invalid
 */
function validateConfig(config: ClawRouteConfig): void {
    // Check for at least one API key
    if (!hasAnyApiKey(config.apiKeys)) {
        throw new Error(
            'No API keys configured. Set at least one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, DEEPSEEK_API_KEY'
        );
    }

    // Validate port
    if (config.proxyPort < 1 || config.proxyPort > 65535) {
        throw new Error(`Invalid port: ${config.proxyPort}. Must be between 1 and 65535.`);
    }

    // Validate retention days
    if (config.logging.retentionDays < 1) {
        throw new Error(`Invalid retention days: ${config.logging.retentionDays}. Must be at least 1.`);
    }

    // Validate min confidence
    if (config.classification.minConfidence < 0 || config.classification.minConfidence > 1) {
        throw new Error(
            `Invalid minConfidence: ${config.classification.minConfidence}. Must be between 0 and 1.`
        );
    }

    // Validate model configs
    for (const tier of Object.values(TaskTier)) {
        const tierConfig = config.models[tier];
        if (!tierConfig) {
            throw new Error(`Missing model configuration for tier: ${tier}`);
        }
        if (!tierConfig.primary) {
            throw new Error(`Missing primary model for tier: ${tier}`);
        }
        if (!tierConfig.fallback) {
            throw new Error(`Missing fallback model for tier: ${tier}`);
        }
    }
}

/**
 * Load the complete ClawRoute configuration.
 *
 * Priority order:
 * 1. Default values (lowest)
 * 2. config/default.json
 * 3. config/clawroute.json (user customizations)
 * 4. Environment variables (highest)
 *
 * @returns The loaded configuration
 * @throws Error if configuration is invalid
 */
export function loadConfig(): ClawRouteConfig {
    const projectRoot = getProjectRoot();

    // Start with defaults
    let config: ClawRouteConfig = {
        ...DEFAULT_CONFIG,
        apiKeys: loadApiKeys(),
        overrides: {
            globalForceModel: null,
            sessions: {},
        },
    };

    // Load bundled default config
    const defaultConfigPath = join(projectRoot, 'config', 'default.json');
    const defaultJson = loadJsonConfig(defaultConfigPath);
    if (defaultJson) {
        config = deepMerge(config, defaultJson as Partial<ClawRouteConfig>);
    }

    // Load user config (if exists)
    const userConfigPath = join(projectRoot, 'config', 'clawroute.json');
    const userJson = loadJsonConfig(userConfigPath);
    if (userJson) {
        config = deepMerge(config, userJson as Partial<ClawRouteConfig>);
    }

    // Apply environment variable overrides
    config.enabled = parseBoolEnv(process.env['CLAWROUTE_ENABLED'], config.enabled);
    config.dryRun = parseBoolEnv(process.env['CLAWROUTE_DRY_RUN'], config.dryRun);
    config.proxyPort = parseIntEnv(process.env['CLAWROUTE_PORT'], config.proxyPort);

    if (process.env['CLAWROUTE_HOST']) {
        config.proxyHost = process.env['CLAWROUTE_HOST'];
    }

    if (process.env['CLAWROUTE_TOKEN']) {
        config.authToken = process.env['CLAWROUTE_TOKEN'];
    }

    config.logging.debugMode = parseBoolEnv(
        process.env['CLAWROUTE_DEBUG'],
        config.logging.debugMode
    );

    config.logging.logContent = parseBoolEnv(
        process.env['CLAWROUTE_LOG_CONTENT'],
        config.logging.logContent
    );

    // Reload API keys (in case they were updated)
    config.apiKeys = loadApiKeys();

    // v1.1: Load donation configuration from environment
    config.donations = loadDonationConfig();

    // v1.1: Load alerts configuration from environment
    config.alerts = loadAlertsConfig();

    // Validate the final configuration
    validateConfig(config);

    return config;
}

/**
 * Get a redacted version of the config for display.
 * Removes API keys and sensitive values.
 *
 * @param config - The configuration to redact
 * @returns Redacted configuration
 */
export function getRedactedConfig(
    config: ClawRouteConfig
): Omit<ClawRouteConfig, 'apiKeys'> & { apiKeys: Record<ProviderType, string> } {
    const redactedKeys: Record<ProviderType, string> = {
        anthropic: config.apiKeys.anthropic ? '[REDACTED]' : '',
        openai: config.apiKeys.openai ? '[REDACTED]' : '',
        google: config.apiKeys.google ? '[REDACTED]' : '',
        deepseek: config.apiKeys.deepseek ? '[REDACTED]' : '',
        openrouter: config.apiKeys.openrouter ? '[REDACTED]' : '',
    };

    return {
        ...config,
        authToken: config.authToken ? '[REDACTED]' : null,
        apiKeys: redactedKeys,
    };
}

/**
 * Check if a specific provider's API key is available.
 *
 * @param config - The configuration
 * @param provider - The provider to check
 * @returns True if the provider's API key is set
 */
export function hasApiKey(config: ClawRouteConfig, provider: ProviderType): boolean {
    const key = config.apiKeys[provider];
    return key !== undefined && key.length > 0;
}

/**
 * Get the API key for a provider.
 *
 * @param config - The configuration
 * @param provider - The provider
 * @returns The API key or empty string
 */
export function getApiKey(config: ClawRouteConfig, provider: ProviderType): string {
    return config.apiKeys[provider] ?? '';
}

// Singleton config instance
let configInstance: ClawRouteConfig | null = null;

/**
 * Get the global configuration instance.
 * Loads the config on first call.
 *
 * @returns The configuration
 */
export function getConfig(): ClawRouteConfig {
    if (!configInstance) {
        configInstance = loadConfig();
    }
    return configInstance;
}

/**
 * Reset the config instance (for testing).
 */
export function resetConfig(): void {
    configInstance = null;
}

/**
 * Update the runtime configuration.
 * Only updates runtime-modifiable fields.
 *
 * @param updates - Partial config updates
 */
export function updateConfig(updates: Partial<Pick<ClawRouteConfig, 'enabled' | 'dryRun' | 'overrides'>>): void {
    const config = getConfig();

    if (updates.enabled !== undefined) {
        config.enabled = updates.enabled;
    }

    if (updates.dryRun !== undefined) {
        config.dryRun = updates.dryRun;
    }

    if (updates.overrides !== undefined) {
        config.overrides = updates.overrides;
    }
}
