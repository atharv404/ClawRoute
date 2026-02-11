/**
 * ClawRoute Streaming Handler
 *
 * SSE (Server-Sent Events) transparent passthrough with zero-latency streaming.
 * Parses chunks to extract token counts for logging.
 */

import { safeJsonParse } from './utils.js';

/**
 * Result of streaming a response.
 */
export interface StreamResult {
    /** Estimated input tokens (from usage in final chunk if available) */
    inputTokens: number;
    /** Estimated output tokens (from usage or chunk count) */
    outputTokens: number;
    /** Whether tool calls were detected in the stream */
    hadToolCalls: boolean;
    /** Any error that occurred during streaming */
    error: string | null;
}

/**
 * Stream an SSE response from upstream to the client.
 *
 * This function pipes chunks with zero buffering delay.
 *
 * @param upstreamResponse - The response from the upstream LLM provider
 * @param writer - The writable stream to write to
 * @returns Streaming result with token counts
 */
export async function pipeStream(
    upstreamResponse: Response,
    writer: WritableStreamDefaultWriter<Uint8Array>
): Promise<StreamResult> {
    const result: StreamResult = {
        inputTokens: 0,
        outputTokens: 0,
        hadToolCalls: false,
        error: null,
    };

    const body = upstreamResponse.body;
    if (!body) {
        result.error = 'No response body';
        return result;
    }

    const reader = body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let chunkCount = 0;
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                // Process any remaining buffer
                if (buffer.trim()) {
                    processSSEBuffer(buffer, result);
                }
                break;
            }

            // Write immediately to client (zero buffering)
            await writer.write(value);

            // Decode and process for token counting
            buffer += decoder.decode(value, { stream: true });
            chunkCount++;

            // Process complete SSE messages from buffer
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

            for (const line of lines) {
                processSSELine(line, result);
            }
        }
    } catch (error) {
        result.error = error instanceof Error ? error.message : 'Stream error';

        // Try to send a [DONE] marker to cleanly close the stream
        try {
            await writer.write(encoder.encode('data: [DONE]\n\n'));
        } catch {
            // Ignore errors closing the stream
        }
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // Ignore
        }
    }

    // If no usage data was found, estimate from chunk count
    if (result.outputTokens === 0 && chunkCount > 0) {
        // Rough estimate: ~1-2 tokens per chunk on average
        result.outputTokens = Math.ceil(chunkCount * 1.5);
    }

    return result;
}

/**
 * Process a single SSE line for token counting.
 */
function processSSELine(line: string, result: StreamResult): void {
    const trimmed = line.trim();

    if (!trimmed.startsWith('data:')) {
        return;
    }

    const data = trimmed.slice(5).trim();

    if (data === '[DONE]') {
        return;
    }

    const parsed = safeJsonParse<StreamChunk>(data);
    if (!parsed) {
        return;
    }

    // Check for tool calls
    const delta = parsed.choices?.[0]?.delta;
    if (delta?.tool_calls && delta.tool_calls.length > 0) {
        result.hadToolCalls = true;
    }

    // Check for usage (usually in the final chunk)
    if (parsed.usage) {
        if (parsed.usage.prompt_tokens) {
            result.inputTokens = parsed.usage.prompt_tokens;
        }
        if (parsed.usage.completion_tokens) {
            result.outputTokens = parsed.usage.completion_tokens;
        }
    }
}

/**
 * Process remaining buffer for any usage data.
 */
function processSSEBuffer(buffer: string, result: StreamResult): void {
    const lines = buffer.split('\n');
    for (const line of lines) {
        processSSELine(line, result);
    }
}

/**
 * Streaming chunk structure (partial).
 */
interface StreamChunk {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    choices?: Array<{
        index: number;
        delta: {
            content?: string;
            role?: string;
            tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: {
                    name?: string;
                    arguments?: string;
                };
            }>;
        };
        finish_reason?: string | null;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
}

/**
 * Get SSE headers for streaming responses.
 *
 * @returns Headers object for SSE
 */
export function getSSEHeaders(): Record<string, string> {
    return {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // Prevents nginx buffering
    };
}

/**
 * Create a streaming response from a readable stream.
 *
 * @param stream - The readable stream
 * @param headers - Additional headers to include
 * @returns A Response object
 */
export function createStreamingResponse(
    stream: ReadableStream<Uint8Array>,
    headers: Record<string, string> = {}
): Response {
    return new Response(stream, {
        status: 200,
        headers: {
            ...getSSEHeaders(),
            ...headers,
        },
    });
}

/**
 * Create a TransformStream that counts tokens while passing through data.
 *
 * @param onChunk - Callback for each chunk (for token counting)
 * @returns TransformStream
 */
export function createTokenCountingStream(
    onChunk: (text: string) => void
): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();

    return new TransformStream({
        transform(chunk, controller) {
            // Pass through immediately
            controller.enqueue(chunk);

            // Decode for counting (async after passthrough)
            const text = decoder.decode(chunk, { stream: true });
            onChunk(text);
        },
    });
}
