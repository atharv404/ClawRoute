/**
 * ClawRoute Request Classifier
 *
 * 100% local classification of requests based on heuristics.
 * No external API calls, <5ms per classification.
 *
 * Classification tiers:
 * - HEARTBEAT: ping/status checks, simple greetings
 * - SIMPLE: acknowledgments, short questions
 * - MODERATE: general conversation (default)
 * - COMPLEX: analytical tasks, tool usage
 * - FRONTIER: code generation, multi-step reasoning, forced tool use
 */

import {
    ChatCompletionRequest,
    ClassificationResult,
    TaskTier,
    TIER_ORDER,
    ClawRouteConfig,
} from './types.js';
import {
    getLastUserMessage,
    estimateMessagesTokens,
} from './utils.js';

// === Classification Patterns ===

/**
 * Patterns for heartbeat/ping detection.
 */
const HEARTBEAT_PATTERNS = [
    /^(ping|status|alive|check|heartbeat|hey|hi|hello|test|yo)\s*[?!.]*$/i,
    /^are you (there|up|alive|ok|ready)\s*[?!.]*$/i,
    /^(can you hear me|you there|testing)\s*[?!.]*$/i,
];

/**
 * Patterns for simple acknowledgments.
 */
const ACKNOWLEDGMENT_PATTERNS = [
    /^(thanks|thank you|thx|ty)\s*[!.]*$/i,
    /^(ok|okay|k|kk|alright|sure|yes|no|yep|nope|yeah|nah)\s*[!.]*$/i,
    /^(got it|sounds good|cool|great|nice|perfect|awesome|agreed|right)\s*[!.]*$/i,
    /^(lol|haha|hehe|lmao|rofl)\s*[!.]*$/i,
    /^[👍🙏😊👌✅❤️]+$/,
];

/**
 * Keywords indicating frontier-level complexity.
 */
const FRONTIER_KEYWORDS =
    /\b(implement|architect|design|refactor|debug|optimize|prove|derive|analyze.{0,20}(code|system|architecture|algorithm))\b/i;

/**
 * Keywords indicating complex analytical tasks.
 */
const COMPLEX_KEYWORDS =
    /\b(explain|compare|analyze|research|summarize|evaluate|assess|review|write.{0,10}(essay|report|article|doc|documentation))\b/i;

/**
 * Detect code blocks in text.
 */
const CODE_BLOCK_PATTERN = /```[\s\S]*?```/;

/**
 * Pattern for simple questions.
 */
const SIMPLE_QUESTION_PATTERN = /^[^?]{0,100}\?$/;

// === Classification Functions ===

/**
 * Check if the message matches heartbeat patterns.
 */
function isHeartbeat(
    lastMessage: string,
    messageCount: number,
    hasTools: boolean
): { match: boolean; confidence: number } {
    // Check explicit heartbeat patterns
    for (const pattern of HEARTBEAT_PATTERNS) {
        if (pattern.test(lastMessage.trim())) {
            return { match: true, confidence: 0.95 };
        }
    }

    // Short message + few messages + no tools
    if (
        lastMessage.length < 30 &&
        messageCount <= 2 &&
        !hasTools
    ) {
        return { match: true, confidence: 0.8 };
    }

    return { match: false, confidence: 0 };
}

/**
 * Check if the message is a simple acknowledgment.
 */
function isSimple(
    lastMessage: string,
    messageCount: number,
    hasTools: boolean
): { match: boolean; confidence: number } {
    const trimmed = lastMessage.trim();

    // Check acknowledgment patterns
    for (const pattern of ACKNOWLEDGMENT_PATTERNS) {
        if (pattern.test(trimmed)) {
            return { match: true, confidence: 0.9 };
        }
    }

    // Short message without tools
    if (trimmed.length < 80 && !hasTools) {
        // Simple question ending with ?
        if (
            SIMPLE_QUESTION_PATTERN.test(trimmed) &&
            messageCount <= 2
        ) {
            return { match: true, confidence: 0.8 };
        }
    }

    return { match: false, confidence: 0 };
}

/**
 * Check if the request is frontier-level complexity.
 */
function isFrontier(
    request: ChatCompletionRequest,
    lastMessage: string,
    estimatedTokens: number
): { match: boolean; confidence: number; signals: string[] } {
    const signals: string[] = [];

    // Tools defined + tool_choice set = definitely frontier
    const hasTools = request.tools && request.tools.length > 0;
    const hasToolChoice =
        request.tool_choice !== undefined &&
        request.tool_choice !== null &&
        request.tool_choice !== 'none';

    if (hasTools && hasToolChoice) {
        signals.push('tools_with_tool_choice');
        return { match: true, confidence: 0.9, signals };
    }

    // Code blocks present
    if (CODE_BLOCK_PATTERN.test(lastMessage)) {
        signals.push('code_blocks');
        return { match: true, confidence: 0.85, signals };
    }

    // Long message with frontier keywords
    if (lastMessage.length > 1000 && FRONTIER_KEYWORDS.test(lastMessage)) {
        signals.push('long_with_frontier_keywords');
        return { match: true, confidence: 0.8, signals };
    }

    // Massive context
    if (estimatedTokens > 8000) {
        signals.push('massive_context');
        return { match: true, confidence: 0.75, signals };
    }

    // Check for multimodal content (images)
    const hasImages = request.messages.some((m) => {
        if (typeof m.content === 'object' && Array.isArray(m.content)) {
            return m.content.some(
                (c: unknown) =>
                    typeof c === 'object' && c !== null && 'type' in c && (c as Record<string, unknown>).type === 'image_url'
            );
        }
        return false;
    });

    if (hasImages) {
        signals.push('multimodal_images');
        return { match: true, confidence: 0.8, signals };
    }

    return { match: false, confidence: 0, signals };
}

/**
 * Check if the request is complex-level.
 */
function isComplex(
    request: ChatCompletionRequest,
    lastMessage: string,
    messageCount: number,
    estimatedTokens: number
): { match: boolean; confidence: number; signals: string[] } {
    const signals: string[] = [];

    // Tools present (without explicit tool_choice)
    if (request.tools && request.tools.length > 0) {
        signals.push('tools_present');
        return { match: true, confidence: 0.85, signals };
    }

    // Analytical keywords with moderate length
    if (
        lastMessage.length >= 500 &&
        lastMessage.length <= 1000 &&
        COMPLEX_KEYWORDS.test(lastMessage)
    ) {
        signals.push('analytical_keywords');
        return { match: true, confidence: 0.8, signals };
    }

    // Deep conversation
    if (messageCount > 8) {
        signals.push('deep_conversation');
        return { match: true, confidence: 0.75, signals };
    }

    // Medium-large context
    if (estimatedTokens >= 4000 && estimatedTokens <= 8000) {
        signals.push('medium_context');
        return { match: true, confidence: 0.7, signals };
    }

    return { match: false, confidence: 0, signals };
}

/**
 * Classify a chat completion request.
 *
 * @param request - The chat completion request
 * @param config - The ClawRoute configuration
 * @returns Classification result with tier, confidence, and signals
 */
export function classifyRequest(
    request: ChatCompletionRequest,
    config: ClawRouteConfig
): ClassificationResult {
    const messages = request.messages;
    const lastMessage = getLastUserMessage(messages);
    const messageCount = messages.length;
    const estimatedTokens = estimateMessagesTokens(messages);
    const hasTools = Boolean(request.tools && request.tools.length > 0);

    const signals: string[] = [];
    let tier: TaskTier = TaskTier.MODERATE;
    let confidence = 0.85;
    let reason = 'default classification';

    // Check for model name hints (opportunistic)
    const modelLower = request.model.toLowerCase();
    if (
        modelLower.includes('heartbeat') ||
        modelLower.includes('cron') ||
        modelLower.includes('health')
    ) {
        signals.push('model_name_hint');
        tier = TaskTier.HEARTBEAT;
        confidence = 0.85;
        reason = 'model name indicates heartbeat';
    }

    // RULE GROUP 1: HEARTBEAT
    if (tier === TaskTier.MODERATE) {
        const heartbeatCheck = isHeartbeat(lastMessage, messageCount, hasTools);
        if (heartbeatCheck.match) {
            tier = TaskTier.HEARTBEAT;
            confidence = heartbeatCheck.confidence;
            reason = 'heartbeat pattern detected';
            signals.push('heartbeat_pattern');
        }
    }

    // RULE GROUP 2: FRONTIER (check BEFORE simple to catch complex cases)
    if (tier === TaskTier.MODERATE || tier === TaskTier.HEARTBEAT) {
        const frontierCheck = isFrontier(request, lastMessage, estimatedTokens);
        if (frontierCheck.match) {
            tier = TaskTier.FRONTIER;
            confidence = frontierCheck.confidence;
            reason = `frontier: ${frontierCheck.signals.join(', ')}`;
            signals.push(...frontierCheck.signals);
        }
    }

    // RULE GROUP 3: COMPLEX
    if (tier === TaskTier.MODERATE) {
        const complexCheck = isComplex(request, lastMessage, messageCount, estimatedTokens);
        if (complexCheck.match) {
            tier = TaskTier.COMPLEX;
            confidence = complexCheck.confidence;
            reason = `complex: ${complexCheck.signals.join(', ')}`;
            signals.push(...complexCheck.signals);
        }
    }

    // RULE GROUP 4: SIMPLE
    if (tier === TaskTier.MODERATE) {
        const simpleCheck = isSimple(lastMessage, messageCount, hasTools);
        if (simpleCheck.match) {
            tier = TaskTier.SIMPLE;
            confidence = simpleCheck.confidence;
            reason = 'simple acknowledgment or question';
            signals.push('simple_pattern');
        }
    }

    // RULE GROUP 5: MODERATE (already default)
    if (tier === TaskTier.MODERATE && signals.length === 0) {
        reason = 'general conversation';
        signals.push('default_moderate');
    }

    // === POST-CLASSIFICATION ADJUSTMENTS ===

    // Tool-aware routing: if tools present and tier < COMPLEX, escalate
    if (config.classification.toolAwareRouting && hasTools) {
        if (TIER_ORDER[tier] < TIER_ORDER[TaskTier.COMPLEX]) {
            const oldTier = tier;
            tier = TaskTier.COMPLEX;
            reason = `escalated from ${oldTier}: tool schemas present`;
            signals.push('tool_aware_escalation');
            confidence = Math.min(confidence, 0.8);
        }
    }

    // Conservative mode: low confidence -> escalate
    if (config.classification.conservativeMode) {
        if (confidence < config.classification.minConfidence) {
            // Escalate one tier
            const currentOrder = TIER_ORDER[tier];
            const nextOrder = Math.min(currentOrder + 1, TIER_ORDER[TaskTier.FRONTIER]);
            const nextTier = (Object.entries(TIER_ORDER).find(
                ([, order]) => order === nextOrder
            )?.[0] ?? TaskTier.FRONTIER) as TaskTier;

            if (nextTier !== tier) {
                const oldTier = tier;
                tier = nextTier;
                reason = `escalated from ${oldTier}: low confidence (${confidence.toFixed(2)})`;
                signals.push('low_confidence_escalation');
            }
        }

        // Very low confidence -> escalate to frontier
        if (confidence < 0.5 && tier !== TaskTier.FRONTIER) {
            tier = TaskTier.FRONTIER;
            reason = `escalated to frontier: very low confidence (${confidence.toFixed(2)})`;
            signals.push('very_low_confidence_escalation');
        }
    }

    // Determine if safe to retry
    // Safe only for HEARTBEAT or SIMPLE (no tool side-effects expected)
    let safeToRetry = tier === TaskTier.HEARTBEAT || tier === TaskTier.SIMPLE;

    // If tools are present, never safe to retry (tools might have side effects)
    if (hasTools) {
        safeToRetry = false;
    }

    return {
        tier,
        confidence,
        reason,
        signals,
        toolsDetected: hasTools,
        safeToRetry,
    };
}

/**
 * Get a human-readable explanation of the classification.
 *
 * @param result - The classification result
 * @returns Human-readable description
 */
export function explainClassification(result: ClassificationResult): string {
    const tierNames: Record<TaskTier, string> = {
        [TaskTier.HEARTBEAT]: 'Heartbeat (ping/status)',
        [TaskTier.SIMPLE]: 'Simple (acknowledgment/short question)',
        [TaskTier.MODERATE]: 'Moderate (general conversation)',
        [TaskTier.COMPLEX]: 'Complex (analytical/tools)',
        [TaskTier.FRONTIER]: 'Frontier (code/reasoning)',
    };

    return `${tierNames[result.tier]} - ${result.reason} (confidence: ${(result.confidence * 100).toFixed(0)}%)`;
}
