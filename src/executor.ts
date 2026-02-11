/**
 * ClawRoute Request Executor
 *
 * Handles LLM API calls with proper safety for streaming and tool calls.
 * Implements escalation logic with strict rules:
 * - Streaming responses are NEVER interrupted once started
 * - Tool calls in responses block retry (no duplicate side effects)
 */

import {
    ChatCompletionRequest,
    ChatCompletionResponse,
    ClawRouteConfig,
    ExecutionResult,
    RoutingDecision,
    ClassificationResult,
    TaskTier,
} from './types.js';
import { getApiBaseUrl, getAuthHeader, calculateCost, getProviderForModel } from './models.js';
import { getApiKey } from './config.js';
import { getEscalatedModel, isProEnabled } from './router.js';
import { validateResponse } from './validator.js';
import { pipeStream, getSSEHeaders, StreamResult } from './streaming.js';
import { sleep, estimateMessagesTokens, safeJsonParse } from './utils.js';

/**
 * Check if escalation is allowed based on plan and tier.
 * Free plan can only escalate within cheap tiers (HEARTBEAT → SIMPLE).
 *
 * @param currentTier - The current tier
 * @param config - The config
 * @returns True if escalation is allowed
 */
function canEscalate(currentTier: TaskTier, config: ClawRouteConfig): boolean {
    // Pro can always escalate (subject to other rules)
    if (isProEnabled(config)) {
        return true;
    }

    // Free plan: Only allow escalation from HEARTBEAT to SIMPLE
    // SIMPLE and beyond cannot escalate on Free
    return currentTier === TaskTier.HEARTBEAT;
}

/**
 * Execute a request through the routing layer.
 *
 * @param request - The original chat completion request
 * @param routingDecision - The routing decision made
 * @param classification - The classification result
 * @param config - The ClawRoute configuration
 * @returns Execution result with response and metadata
 */
export async function executeRequest(
    request: ChatCompletionRequest,
    routingDecision: RoutingDecision,
    _classification: ClassificationResult,
    config: ClawRouteConfig
): Promise<ExecutionResult> {
    const startTime = Date.now();
    const escalationChain: string[] = [];
    let currentModel = routingDecision.routedModel;
    let escalated = false;
    let response: Response;
    let hadToolCalls = false;
    let inputTokens = estimateMessagesTokens(request.messages);
    let outputTokens = 0;

    // Track current tier for escalation
    let currentTier = routingDecision.tier;

    // Add initial model to chain
    escalationChain.push(currentModel);

    if (request.stream) {
        // STREAMING REQUEST
        // We can only retry BEFORE streaming starts
        // Once we start streaming, we're committed

        let retryCount = 0;
        const maxRetries = config.escalation.enabled ? config.escalation.maxRetries : 0;

        while (retryCount <= maxRetries) {
            try {
                // Make the request to the current model
                response = await makeProviderRequest(request, currentModel, config);

                // Check if we got an error BEFORE streaming starts
                if (!response.ok) {
                    // Can retry if we haven't started streaming
                    // v1.1: Also check canEscalate for Free plan restrictions
                    if (
                        config.escalation.enabled &&
                        retryCount < maxRetries &&
                        routingDecision.safeToRetry &&
                        canEscalate(currentTier, config)
                    ) {
                        const escalation = getEscalatedModel(currentTier, config);
                        if (escalation) {
                            await sleep(config.escalation.retryDelayMs);
                            currentModel = escalation.model;
                            currentTier = escalation.tier;
                            escalationChain.push(currentModel);
                            escalated = true;
                            retryCount++;
                            continue;
                        }
                    }

                    // Can't retry or no escalation available
                    // Fall back to original model if configured
                    if (config.escalation.alwaysFallbackToOriginal && currentModel !== routingDecision.originalModel) {
                        currentModel = routingDecision.originalModel;
                        escalationChain.push(currentModel);
                        response = await makeProviderRequest(request, currentModel, config);
                    }
                }

                // We have a response (success or final failure)
                // For streaming, we need to pipe it through
                break;
            } catch (error) {
                // Network error or similar
                if (
                    config.escalation.enabled &&
                    retryCount < maxRetries &&
                    routingDecision.safeToRetry
                ) {
                    const escalation = getEscalatedModel(currentTier, config);
                    if (escalation) {
                        await sleep(config.escalation.retryDelayMs);
                        currentModel = escalation.model;
                        currentTier = escalation.tier;
                        escalationChain.push(currentModel);
                        escalated = true;
                        retryCount++;
                        continue;
                    }
                }

                // Fall back to original model
                if (config.escalation.alwaysFallbackToOriginal) {
                    currentModel = routingDecision.originalModel;
                    escalationChain.push(currentModel);
                    try {
                        response = await makeProviderRequest(request, currentModel, config);
                        break;
                    } catch {
                        // Even original model failed - return error response
                        response = createErrorResponse('All models failed to respond');
                        break;
                    }
                }

                response = createErrorResponse(error instanceof Error ? error.message : 'Request failed');
                break;
            }
        }

        // Create streaming response with token counting
        if (response!.ok && response!.body) {
            const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
            const writer = writable.getWriter();

            // Start piping in the background
            const streamPromise = pipeStream(response!, writer).then(async (result: StreamResult) => {
                hadToolCalls = result.hadToolCalls;
                if (result.inputTokens > 0) inputTokens = result.inputTokens;
                if (result.outputTokens > 0) outputTokens = result.outputTokens;
                await writer.close();
            });

            // Don't await - let it stream in the background
            streamPromise.catch(() => {
                // Errors are handled in pipeStream
            });

            const streamResponse = new Response(readable, {
                status: response!.status,
                statusText: response!.statusText,
                headers: {
                    ...getSSEHeaders(),
                    'X-ClawRoute-Model': currentModel,
                    'X-ClawRoute-Tier': currentTier,
                    'X-ClawRoute-Escalated': String(escalated),
                },
            });

            return buildExecutionResult(
                streamResponse,
                routingDecision,
                currentModel,
                escalated,
                escalationChain,
                inputTokens,
                outputTokens,
                hadToolCalls,
                startTime
            );
        }

        // Non-streaming response or error
        return buildExecutionResult(
            response!,
            routingDecision,
            currentModel,
            escalated,
            escalationChain,
            inputTokens,
            outputTokens,
            hadToolCalls,
            startTime
        );
    } else {
        // NON-STREAMING REQUEST
        // We can fully validate and retry since nothing has been sent to the client

        let retryCount = 0;
        const maxRetries = config.escalation.enabled ? config.escalation.maxRetries : 0;
        let responseBody: ChatCompletionResponse | null = null;

        while (retryCount <= maxRetries) {
            try {
                response = await makeProviderRequest(request, currentModel, config);

                // Parse response body for validation
                if (response.ok) {
                    const bodyText = await response.text();
                    responseBody = safeJsonParse<ChatCompletionResponse>(bodyText);

                    // Validate the response
                    const validation = validateResponse(response, responseBody, request, currentTier);
                    hadToolCalls = validation.hadToolCalls;

                    if (!validation.valid) {
                        // Response is invalid - can we retry?
                        // CRITICAL: Don't retry if there were tool calls
                        if (
                            validation.hadToolCalls ||
                            !routingDecision.safeToRetry ||
                            !config.escalation.onlyRetryWithoutToolCalls
                        ) {
                            // Can't retry - tool calls may have been executed
                            // Return the response as-is
                            break;
                        }

                        if (config.escalation.enabled && retryCount < maxRetries) {
                            const escalation = getEscalatedModel(currentTier, config);
                            if (escalation) {
                                await sleep(config.escalation.retryDelayMs);
                                currentModel = escalation.model;
                                currentTier = escalation.tier;
                                escalationChain.push(currentModel);
                                escalated = true;
                                retryCount++;
                                continue;
                            }
                        }
                    }

                    // Valid response or can't retry
                    // Recreate response from body text (since we consumed it)
                    response = new Response(bodyText, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });
                    break;
                } else {
                    // HTTP error
                    if (
                        config.escalation.enabled &&
                        retryCount < maxRetries &&
                        routingDecision.safeToRetry
                    ) {
                        const escalation = getEscalatedModel(currentTier, config);
                        if (escalation) {
                            await sleep(config.escalation.retryDelayMs);
                            currentModel = escalation.model;
                            currentTier = escalation.tier;
                            escalationChain.push(currentModel);
                            escalated = true;
                            retryCount++;
                            continue;
                        }
                    }

                    // Fall back to original
                    if (config.escalation.alwaysFallbackToOriginal && currentModel !== routingDecision.originalModel) {
                        currentModel = routingDecision.originalModel;
                        escalationChain.push(currentModel);
                        response = await makeProviderRequest(request, currentModel, config);
                    }
                    break;
                }
            } catch (error) {
                // Network error
                if (
                    config.escalation.enabled &&
                    retryCount < maxRetries &&
                    routingDecision.safeToRetry
                ) {
                    const escalation = getEscalatedModel(currentTier, config);
                    if (escalation) {
                        await sleep(config.escalation.retryDelayMs);
                        currentModel = escalation.model;
                        currentTier = escalation.tier;
                        escalationChain.push(currentModel);
                        escalated = true;
                        retryCount++;
                        continue;
                    }
                }

                // Fall back to original
                if (config.escalation.alwaysFallbackToOriginal) {
                    currentModel = routingDecision.originalModel;
                    escalationChain.push(currentModel);
                    try {
                        response = await makeProviderRequest(request, currentModel, config);
                        break;
                    } catch {
                        response = createErrorResponse('All models failed');
                        break;
                    }
                }

                response = createErrorResponse(error instanceof Error ? error.message : 'Request failed');
                break;
            }
        }

        // Extract token counts from response
        if (responseBody?.usage) {
            inputTokens = responseBody.usage.prompt_tokens;
            outputTokens = responseBody.usage.completion_tokens;
        }

        // Check for tool calls in response
        if (responseBody?.choices?.[0]?.message?.tool_calls) {
            hadToolCalls = true;
        }

        // Add headers to response
        const headers = new Headers(response!.headers);
        headers.set('X-ClawRoute-Model', currentModel);
        headers.set('X-ClawRoute-Tier', currentTier);
        headers.set('X-ClawRoute-Escalated', String(escalated));

        const finalResponse = new Response(response!.body, {
            status: response!.status,
            statusText: response!.statusText,
            headers,
        });

        return buildExecutionResult(
            finalResponse,
            routingDecision,
            currentModel,
            escalated,
            escalationChain,
            inputTokens,
            outputTokens,
            hadToolCalls,
            startTime
        );
    }
}

/**
 * Make a request to an LLM provider.
 */
async function makeProviderRequest(
    request: ChatCompletionRequest,
    modelId: string,
    config: ClawRouteConfig
): Promise<Response> {
    const provider = getProviderForModel(modelId);
    const apiKey = getApiKey(config, provider);

    if (!apiKey) {
        throw new Error(`No API key configured for provider: ${provider}`);
    }

    const baseUrl = getApiBaseUrl(provider);
    const authHeaders = getAuthHeader(provider, apiKey);

    // Build the request body with the routed model
    const body = {
        ...request,
        model: extractModelName(modelId),
    };

    // Determine the endpoint
    let url = `${baseUrl}/chat/completions`;

    // Handle Anthropic's different endpoint
    if (provider === 'anthropic') {
        // For Anthropic, we need to use the messages endpoint
        // and handle the format differently
        // For now, we'll use OpenAI-compatible format
        // Users should use OpenRouter for Anthropic models
        url = `${baseUrl}/messages`;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
        },
        body: JSON.stringify(body),
    });

    return response;
}

/**
 * Extract the model name without provider prefix.
 */
function extractModelName(modelId: string): string {
    if (modelId.includes('/')) {
        return modelId.split('/').slice(1).join('/');
    }
    return modelId;
}

/**
 * Create an error response.
 */
function createErrorResponse(message: string): Response {
    return new Response(
        JSON.stringify({
            error: {
                message,
                type: 'server_error',
                code: 'internal_error',
            },
        }),
        {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
            },
        }
    );
}

/**
 * Build the execution result from response and metadata.
 */
function buildExecutionResult(
    response: Response,
    routingDecision: RoutingDecision,
    actualModel: string,
    escalated: boolean,
    escalationChain: string[],
    inputTokens: number,
    outputTokens: number,
    hadToolCalls: boolean,
    startTime: number
): ExecutionResult {
    const responseTimeMs = Date.now() - startTime;

    const originalCostUsd = calculateCost(
        routingDecision.originalModel,
        inputTokens,
        outputTokens
    );
    const actualCostUsd = calculateCost(actualModel, inputTokens, outputTokens);
    const savingsUsd = Math.max(0, originalCostUsd - actualCostUsd);

    return {
        response,
        routingDecision,
        actualModel,
        escalated,
        escalationChain,
        inputTokens,
        outputTokens,
        originalCostUsd,
        actualCostUsd,
        savingsUsd,
        responseTimeMs,
        hadToolCalls,
    };
}

/**
 * Execute a passthrough request (when ClawRoute is disabled or errored).
 */
export async function executePassthrough(
    request: ChatCompletionRequest,
    config: ClawRouteConfig
): Promise<Response> {
    const provider = getProviderForModel(request.model);
    const apiKey = getApiKey(config, provider);

    if (!apiKey) {
        return createErrorResponse(`No API key for provider: ${provider}`);
    }

    try {
        return await makeProviderRequest(request, request.model, config);
    } catch (error) {
        return createErrorResponse(error instanceof Error ? error.message : 'Passthrough failed');
    }
}
