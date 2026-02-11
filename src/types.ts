/**
 * ClawRoute Type Definitions
 *
 * All TypeScript types and interfaces for ClawRoute.
 * Every other module imports from this file.
 */

// === Task Classification ===

/**
 * Task complexity tiers for classification.
 * Used to determine which model should handle a request.
 */
export enum TaskTier {
    HEARTBEAT = 'heartbeat',
    SIMPLE = 'simple',
    MODERATE = 'moderate',
    COMPLEX = 'complex',
    FRONTIER = 'frontier',
}

/**
 * Numeric ordering for tier comparison and escalation.
 * Higher numbers = more capable (and expensive) models.
 */
export const TIER_ORDER: Record<TaskTier, number> = {
    [TaskTier.HEARTBEAT]: 0,
    [TaskTier.SIMPLE]: 1,
    [TaskTier.MODERATE]: 2,
    [TaskTier.COMPLEX]: 3,
    [TaskTier.FRONTIER]: 4,
};

/**
 * Result from the classifier.
 */
export interface ClassificationResult {
    /** The determined task tier */
    tier: TaskTier;
    /** Confidence score from 0.0 to 1.0 */
    confidence: number;
    /** Human-readable explanation */
    reason: string;
    /** List of classification rules that fired */
    signals: string[];
    /** Whether tool definitions were detected in the request */
    toolsDetected: boolean;
    /** Whether it's safe to retry if this model fails (no tool side-effects expected) */
    safeToRetry: boolean;
}

// === Model Registry ===

/**
 * Supported LLM providers.
 */
export type ProviderType = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'openrouter';

/**
 * Model entry with cost and capability information.
 */
export interface ModelEntry {
    /** Unique model identifier, e.g., "anthropic/claude-sonnet-4-5" */
    id: string;
    /** The provider for this model */
    provider: ProviderType;
    /** Cost in USD per 1M input tokens */
    inputCostPer1M: number;
    /** Cost in USD per 1M output tokens */
    outputCostPer1M: number;
    /** Maximum context window in tokens */
    maxContext: number;
    /** Whether the model reliably handles function/tool calling */
    toolCapable: boolean;
    /** Whether the model supports images/multimodal input */
    multimodal: boolean;
    /** Whether this model is enabled for routing */
    enabled: boolean;
}

// === Routing ===

/**
 * The routing decision made for a request.
 */
export interface RoutingDecision {
    /** The model the user originally configured */
    originalModel: string;
    /** The model ClawRoute chose to use */
    routedModel: string;
    /** The classification tier */
    tier: TaskTier;
    /** Reason for this routing decision */
    reason: string;
    /** Classification confidence */
    confidence: number;
    /** If true, this is a dry-run (routed to original, just logging) */
    isDryRun: boolean;
    /** If true, user forced this model via override */
    isOverride: boolean;
    /** If true, ClawRoute is disabled or errored - passthrough mode */
    isPassthrough: boolean;
    /** Estimated savings in USD */
    estimatedSavingsUsd: number;
    /** Whether it's safe to retry on failure */
    safeToRetry: boolean;
}

// === Execution ===

/**
 * Result from executing a request through ClawRoute.
 */
export interface ExecutionResult {
    /** The HTTP response to send back to the client */
    response: Response;
    /** The routing decision that was made */
    routingDecision: RoutingDecision;
    /** The final model used (may differ if escalated) */
    actualModel: string;
    /** Whether the request was escalated to a higher-tier model */
    escalated: boolean;
    /** Chain of models tried, e.g., ["flash-lite", "sonnet"] */
    escalationChain: string[];
    /** Number of input tokens used */
    inputTokens: number;
    /** Number of output tokens generated */
    outputTokens: number;
    /** What it would have cost with the original model */
    originalCostUsd: number;
    /** What it actually cost */
    actualCostUsd: number;
    /** Amount saved */
    savingsUsd: number;
    /** Response time in milliseconds */
    responseTimeMs: number;
    /** Whether the response contained tool calls */
    hadToolCalls: boolean;
}

// === Config ===

/**
 * Model configuration for a specific tier.
 */
export interface TierModelConfig {
    /** Primary model ID for this tier */
    primary: string;
    /** Fallback model ID if primary unavailable */
    fallback: string;
}

/**
 * Session-specific model override.
 */
export interface SessionOverride {
    /** Model to use for this session */
    model: string;
    /** Number of turns remaining (null = permanent) */
    remainingTurns: number | null;
    /** When the override was created */
    createdAt: string;
}

/**
 * Complete ClawRoute configuration.
 */
export interface ClawRouteConfig {
    /** Whether ClawRoute routing is enabled */
    enabled: boolean;
    /** Dry-run mode: classify + log, but use original model */
    dryRun: boolean;
    /** Port to listen on */
    proxyPort: number;
    /** Host to bind to (always 127.0.0.1 by default) */
    proxyHost: string;
    /** Optional shared secret for authentication */
    authToken: string | null;

    /** Classification settings */
    classification: {
        /** If true, low confidence → escalate UP */
        conservativeMode: boolean;
        /** Minimum confidence threshold (below this → escalate) */
        minConfidence: number;
        /** If tools present → minimum COMPLEX tier */
        toolAwareRouting: boolean;
    };

    /** Escalation settings */
    escalation: {
        /** Whether to enable automatic escalation */
        enabled: boolean;
        /** Maximum retry attempts */
        maxRetries: number;
        /** Delay between retries in ms */
        retryDelayMs: number;
        /** CRITICAL: Only retry before streaming starts */
        onlyRetryBeforeStreaming: boolean;
        /** CRITICAL: Only retry if no tool calls in response */
        onlyRetryWithoutToolCalls: boolean;
        /** Final safety net: always use original model if all else fails */
        alwaysFallbackToOriginal: boolean;
    };

    /** Model mappings for each tier */
    models: Record<TaskTier, TierModelConfig>;

    /** Logging settings */
    logging: {
        /** Path to SQLite database */
        dbPath: string;
        /** DEFAULT FALSE: never log prompts unless opted in */
        logContent: boolean;
        /** DEFAULT FALSE: never log system prompts */
        logSystemPrompts: boolean;
        /** Debug mode: truncated logs to console */
        debugMode: boolean;
        /** Days to retain log entries */
        retentionDays: number;
    };

    /** Dashboard settings */
    dashboard: {
        /** Whether the dashboard is enabled */
        enabled: boolean;
    };

    /** Runtime overrides (not persisted) */
    overrides: {
        /** Force all traffic to this model */
        globalForceModel: string | null;
        /** Per-session overrides */
        sessions: Record<string, SessionOverride>;
    };

    /** API keys from environment (NEVER stored in config files) */
    apiKeys: Record<ProviderType, string>;

    /** Donation configuration (v1.1) */
    donations: DonationConfig;

    /** Alerts configuration (v1.1) */
    alerts: AlertsConfig;
}

// === LLM API Types (OpenAI-compatible) ===

/**
 * A content part for multimodal messages.
 */
export interface ContentPart {
    /** The type of content */
    type: 'text' | 'image_url';
    /** Text content (for type: 'text') */
    text?: string;
    /** Image URL content (for type: 'image_url') */
    image_url?: {
        url: string;
        detail?: 'auto' | 'low' | 'high';
    };
}

/**
 * A message in a chat completion request.
 */
export interface ChatMessage {
    /** The role of the message author */
    role: 'system' | 'user' | 'assistant' | 'tool';
    /** The content of the message - can be string or array for multimodal */
    content: string | null | ContentPart[];
    /** Tool calls made by the assistant */
    tool_calls?: ToolCall[];
    /** ID of the tool call this message is responding to */
    tool_call_id?: string;
    /** Additional properties */
    [key: string]: unknown;
}

/**
 * A tool/function definition.
 */
export interface ToolDefinition {
    /** The type of tool (always "function" for now) */
    type: 'function';
    /** Function details */
    function: {
        /** Name of the function */
        name: string;
        /** Description of what the function does */
        description?: string;
        /** JSON Schema for the function parameters */
        parameters?: object;
    };
}

/**
 * A tool call made by the model.
 */
export interface ToolCall {
    /** Unique ID for this tool call */
    id: string;
    /** Type of tool (always "function") */
    type: 'function';
    /** Function call details */
    function: {
        /** Name of the function to call */
        name: string;
        /** JSON string of arguments */
        arguments: string;
    };
}

/**
 * A chat completion request (OpenAI-compatible format).
 */
export interface ChatCompletionRequest {
    /** The model to use */
    model: string;
    /** The messages in the conversation */
    messages: ChatMessage[];
    /** Tool definitions */
    tools?: ToolDefinition[];
    /** How/whether to use tools */
    tool_choice?: string | object;
    /** Whether to stream the response */
    stream?: boolean;
    /** Sampling temperature */
    temperature?: number;
    /** Maximum tokens to generate */
    max_tokens?: number;
    /** Pass through any other fields */
    [key: string]: unknown;
}

/**
 * A chat completion response (OpenAI-compatible format).
 */
export interface ChatCompletionResponse {
    /** Unique ID for this completion */
    id: string;
    /** Object type */
    object: 'chat.completion';
    /** Timestamp of creation */
    created: number;
    /** Model used */
    model: string;
    /** Completion choices */
    choices: Array<{
        index: number;
        message: ChatMessage;
        finish_reason: string | null;
    }>;
    /** Token usage */
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

// === Stats ===

/**
 * Statistics for a time period.
 */
export interface PeriodStats {
    /** Total number of requests */
    requests: number;
    /** What it would have cost originally */
    originalCostUsd: number;
    /** What it actually cost */
    actualCostUsd: number;
    /** Amount saved */
    savingsUsd: number;
    /** Savings as a percentage */
    savingsPercent: number;
    /** Request count per tier */
    tierBreakdown: Record<TaskTier, number>;
    /** Number of escalations */
    escalations: number;
    /** Number of dry-run requests */
    dryRunRequests: number;
}

/**
 * Complete stats response for the API.
 */
export interface StatsResponse {
    /** Stats for today */
    today: PeriodStats;
    /** Stats for this week */
    thisWeek: PeriodStats;
    /** Stats for this month */
    thisMonth: PeriodStats;
    /** All-time stats */
    allTime: PeriodStats;
    /** Recent routing decisions */
    recentDecisions: RecentDecision[];
    /** Current configuration summary */
    config: {
        enabled: boolean;
        dryRun: boolean;
        modelMap: Record<TaskTier, string>;
        activeOverrides: number;
    };
}

/**
 * A recent routing decision for display.
 */
export interface RecentDecision {
    /** When the decision was made */
    timestamp: string;
    /** The classification tier */
    tier: TaskTier;
    /** Original model requested */
    originalModel: string;
    /** Model actually used */
    routedModel: string;
    /** Savings in USD */
    savingsUsd: number;
    /** Whether escalation occurred */
    escalated: boolean;
    /** Classification reason */
    reason: string;
    /** Response time in ms */
    responseTimeMs: number;
}

// === Logging DB ===

/**
 * A log entry in the SQLite database.
 */
export interface LogEntry {
    /** ISO timestamp */
    timestamp: string;
    /** Original model from request */
    original_model: string;
    /** Model ClawRoute chose */
    routed_model: string;
    /** Model actually used (may differ if escalated) */
    actual_model: string;
    /** Classification tier */
    tier: string;
    /** Why this classification was made */
    classification_reason: string;
    /** Classification confidence */
    confidence: number;
    /** Input token count */
    input_tokens: number;
    /** Output token count */
    output_tokens: number;
    /** What it would have cost */
    original_cost_usd: number;
    /** What it actually cost */
    actual_cost_usd: number;
    /** Savings */
    savings_usd: number;
    /** Whether escalation occurred */
    escalated: boolean;
    /** JSON array of models tried */
    escalation_chain: string;
    /** Response time in ms */
    response_time_ms: number;
    /** Whether response had tool calls */
    had_tool_calls: boolean;
    /** Whether this was a dry-run */
    is_dry_run: boolean;
    /** Whether an override was active */
    is_override: boolean;
    /** Session ID if present */
    session_id: string | null;
    /** Error message if any */
    error: string | null;
}

// === Validation ===

/**
 * Result from validating an LLM response.
 */
export interface ValidationResult {
    /** Whether the response is valid */
    valid: boolean;
    /** Reason for invalidity (if any) */
    reason: string;
    /** Whether the response contained tool calls */
    hadToolCalls: boolean;
}

// === Plan & Billing (v1.1) ===

/**
 * Plan types for ClawRoute.
 */


/**
 * Monthly donation summary.
 */
export interface DonationSummary {
    /** ISO timestamp - first day of month */
    monthStart: string;
    /** ISO timestamp - last day of month or now */
    monthEnd: string;
    /** Total savings in USD */
    savingsUsd: number;
    /** Total original cost in USD */
    originalCostUsd: number;
    /** Total actual cost in USD */
    actualCostUsd: number;
    /** Savings as percentage of original cost */
    percentSavings: number;
    /** Suggested donation amount in USD */
    suggestedUsd: number;
    /** Total requests this month */
    requests: number;
}
/**
 * Donation configuration.
 */
export interface DonationConfig {
    /** Suggested monthly donation in USD (default 9) */
    minMonthlyUsd: number;
    /** Optional Stripe checkout URL */
    stripeCheckoutUrl?: string;
    /** Optional USDC payment address */
    usdcAddress?: string;
    /** Optional Buy Me a Coffee URL */
    buyMeCoffeeUrl?: string;
    /** Optional NOWPayments API key */
    nowPaymentsApiKey?: string;
    /** Whether donations are enabled */
    enabled: boolean;
}

/**
 * Alerts configuration (Pro feature).
 */
export interface AlertsConfig {
    /** Email for daily/weekly savings alerts */
    email?: string;
    /** Slack webhook URL for alerts */
    slackWebhook?: string;
}
