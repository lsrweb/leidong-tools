import type { CancellationToken } from 'vscode';
import { safeStringify } from '../json';
import { logger } from '../logger';
import {
	toAnthropicMessages,
	toAnthropicTools,
	toResponsesInput,
	toResponsesTools,
} from '../provider/convert';
import type {
	DeepSeekRequest,
	DeepSeekStreamChunk,
	DeepSeekToolCall,
	DeepSeekUsage,
	ModelApiType,
	StreamCallbacks,
} from '../types';
import { createHttpError, formatRequestError, normalizeRequestError } from './error';

/**
 * Lightweight SSE-streaming chat API client.
 * No external dependencies — uses Node's built-in fetch.
 *
 * Supports three endpoint protocols:
 * - chat-completions  → POST {base}/chat/completions (Bearer auth)
 * - responses         → POST {base}/responses (Bearer auth)
 * - anthropic-messages→ POST {base}/messages (x-api-key + anthropic-version)
 *
 * All protocols normalize streamed output back to the canonical callbacks
 * (content / thinking / tool call / usage / done), so the provider layer
 * stays protocol-agnostic.
 */
export class DeepSeekClient {
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
	) {}

	async streamChatCompletion(
		request: DeepSeekRequest,
		apiType: ModelApiType,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		try {
			if (apiType === 'responses') {
				await this.streamResponses(request, callbacks, cancellationToken);
			} else if (apiType === 'anthropic-messages') {
				await this.streamAnthropicMessages(request, callbacks, cancellationToken);
			} else {
				await this.streamChatCompletions(request, callbacks, cancellationToken);
			}
		} catch (error) {
			if (isAbortError(error) && cancellationToken?.isCancellationRequested) {
				return;
			}
			const normalizedError = normalizeRequestError(error, { baseUrl: this.baseUrl, request });
			logger.error('Chat request failed:', formatRequestError(normalizedError));
			callbacks.onError(normalizedError);
		}
	}

	// ---- OpenAI Chat Completions ----

	private async streamChatCompletions(
		request: DeepSeekRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		// Tool calls stream as index-keyed deltas; emit once the call completes.
		const pendingToolCalls = new Map<number, DeepSeekToolCall>();
		const accumulateToolCall = (tc: {
			index: number;
			id?: string;
			function?: { name?: string; arguments?: string };
		}): void => {
			let pending = pendingToolCalls.get(tc.index);
			if (!pending && tc.id) {
				pending = {
					id: tc.id,
					type: 'function',
					function: { name: '', arguments: '' },
				};
				pendingToolCalls.set(tc.index, pending);
			}
			if (pending) {
				if (tc.function?.name) {
					pending.function.name += tc.function.name;
				}
				if (tc.function?.arguments) {
					pending.function.arguments += tc.function.arguments;
				}
			}
		};
		const flushToolCalls = (): void => {
			for (const tc of pendingToolCalls.values()) {
				callbacks.onToolCall(tc);
			}
			pendingToolCalls.clear();
		};

		const requestBody = {
			...request,
			stream_options: { include_usage: true },
		};

		const latestUsage = await this.streamSse(
			'/chat/completions',
			{ Authorization: `Bearer ${this.apiKey}` },
			requestBody,
			request,
			cancellationToken,
			(chunk) => {
				if (!chunk.data) {
					return undefined;
				}
				const parsed = chunk.data as DeepSeekStreamChunk;
				const choice = parsed.choices?.[0];

				// Some OpenAI-compatible providers emit usage on every streaming chunk.
				// Keep only the latest value and report it once when the stream completes.
				if (parsed.usage) {
					return parsed.usage;
				}

				if (!choice) {
					return undefined;
				}

				// Thinking content → report with correct field name so VS Code renders collapsible blocks
				const reasoning = choice.delta.reasoning_content;
				if (reasoning) {
					callbacks.onThinking(reasoning);
				}

				// Regular content
				if (choice.delta.content) {
					callbacks.onContent(choice.delta.content);
				}

				// Tool calls — accumulate deltas by index
				if (choice.delta.tool_calls) {
					for (const tc of choice.delta.tool_calls) {
						accumulateToolCall(tc);
					}
				}

				// Flush pending tool calls on finish
				if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
					flushToolCalls();
				}
				return undefined;
			},
		);

		// Flush any remaining tool calls
		flushToolCalls();
		reportFinalUsage(callbacks, latestUsage);
		callbacks.onDone();
	}

	// ---- OpenAI Responses ----

	private async streamResponses(
		request: DeepSeekRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const requestBody: Record<string, unknown> = {
			model: request.model,
			input: toResponsesInput(request.messages),
			stream: true,
		};
		const tools = toResponsesTools(request.tools);
		if (tools) {
			requestBody.tools = tools;
		}
		if (request.max_tokens !== undefined) {
			requestBody.max_output_tokens = request.max_tokens;
		}
		if (request.thinking?.type === 'enabled') {
			requestBody.thinking = { type: 'enabled' };
		}

		let latestUsage: DeepSeekUsage | undefined;
		let seenDone = false;

		await this.streamSse(
			'/responses',
			{ Authorization: `Bearer ${this.apiKey}` },
			requestBody,
			request,
			cancellationToken,
			(chunk) => {
				const event = chunk.data as
					| { type?: string; delta?: string; output?: unknown; response?: unknown }
					| undefined;
				if (!event?.type) {
					return undefined;
				}

				if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
					callbacks.onContent(event.delta);
				} else if (
					event.type === 'response.reasoning_summary_text.delta' &&
					typeof event.delta === 'string'
				) {
					callbacks.onThinking(event.delta);
				} else if (event.type === 'response.output_item.done') {
					const output = asRecord(event.output);
					if (output.type === 'function_call' && typeof output.call_id === 'string') {
						callbacks.onToolCall({
							id: output.call_id,
							type: 'function',
							function: {
								name: typeof output.name === 'string' ? output.name : '',
								arguments: typeof output.arguments === 'string' ? output.arguments : '',
							},
						});
					}
				} else if (event.type === 'response.completed') {
					seenDone = true;
					const response = asRecord(event.response);
					const usage = normalizeResponsesUsage(response.usage);
					if (usage) {
						latestUsage = usage;
					}
				}
				return undefined;
			},
		);

		void seenDone;
		reportFinalUsage(callbacks, latestUsage);
		callbacks.onDone();
	}

	// ---- Anthropic Messages ----

	private async streamAnthropicMessages(
		request: DeepSeekRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const { messages, system } = toAnthropicMessages(request.messages);
		const maxTokens = request.max_tokens ?? 4096;

		const requestBody: Record<string, unknown> = {
			model: request.model,
			messages,
			max_tokens: maxTokens,
			stream: true,
		};
		if (system) {
			requestBody.system = system;
		}
		const tools = toAnthropicTools(request.tools);
		if (tools) {
			requestBody.tools = tools;
		}
		if (request.thinking?.type === 'enabled') {
			requestBody.thinking = {
				type: 'enabled',
				budget_tokens: Math.min(1024, Math.max(128, Math.floor(maxTokens / 2))),
			};
		}

		// Tool use blocks are streamed as content_block_start + input_json_delta.
		const pendingAnthropicToolUses = new Map<
			number,
			{ id: string; name: string; arguments: string }
		>();
		const toolUseOrder: number[] = [];

		let latestUsage: DeepSeekUsage | undefined;

		await this.streamSse(
			'/messages',
			{ 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
			requestBody,
			request,
			cancellationToken,
			(chunk) => {
				const event = chunk.data as {
					type?: string;
					index?: number;
					content_block?: { type?: string; id?: string; name?: string };
					delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
					usage?: unknown;
				} | undefined;
				if (!event?.type) {
					return undefined;
				}

				if (event.type === 'content_block_start' && typeof event.index === 'number') {
					const block = event.content_block;
					if (block?.type === 'tool_use') {
						pendingAnthropicToolUses.set(event.index, {
							id: block.id ?? '',
							name: block.name ?? '',
							arguments: '',
						});
						toolUseOrder.push(event.index);
					}
				} else if (event.type === 'content_block_delta' && typeof event.index === 'number') {
					const delta = event.delta;
					if (!delta) {
						return undefined;
					}
					if (delta.type === 'text_delta' && typeof delta.text === 'string') {
						callbacks.onContent(delta.text);
					} else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
						callbacks.onThinking(delta.thinking);
					} else if (
						delta.type === 'input_json_delta' &&
						typeof delta.partial_json === 'string'
					) {
						const pending = pendingAnthropicToolUses.get(event.index);
						if (pending) {
							pending.arguments += delta.partial_json;
						}
					}
				} else if (event.type === 'content_block_stop' && typeof event.index === 'number') {
					const pending = pendingAnthropicToolUses.get(event.index);
					if (pending) {
						callbacks.onToolCall({
							id: pending.id,
							type: 'function',
							function: { name: pending.name, arguments: pending.arguments },
						});
						pendingAnthropicToolUses.delete(event.index);
					}
				} else if (event.type === 'message_delta') {
					const usage = normalizeAnthropicUsage(event.usage);
					if (usage) {
						latestUsage = usage;
					}
				}
				return undefined;
			},
		);

		void toolUseOrder;
		reportFinalUsage(callbacks, latestUsage);
		callbacks.onDone();
	}

	// ---- Shared SSE plumbing ----

	/**
	 * POST an SSE stream and dispatch each `data:` JSON payload to onEvent.
	 * Returns the latest usage-shaped value collected by the handler, if any.
	 */
	private async streamSse(
		endpointPath: string,
		authHeaders: Record<string, string>,
		body: unknown,
		request: DeepSeekRequest,
		cancellationToken: CancellationToken | undefined,
		onEvent: (chunk: { type?: string; data?: unknown }) => DeepSeekUsage | undefined,
	): Promise<DeepSeekUsage | undefined> {
		const controller = new AbortController();
		const cancelListener = cancellationToken?.onCancellationRequested(() => {
			controller.abort();
		});
		if (cancellationToken?.isCancellationRequested) {
			controller.abort();
		}

		let latestUsage: DeepSeekUsage | undefined;

		try {
			const response = await fetch(`${this.baseUrl}${endpointPath}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...authHeaders,
				},
				body: safeStringify(body),
				signal: controller.signal,
			});

			if (!response.ok) {
				throw await createHttpError(response, { baseUrl: this.baseUrl, request });
			}

			if (!response.body) {
				throw new Error('No response body received');
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				if (cancellationToken?.isCancellationRequested) {
					controller.abort();
					return latestUsage;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();

					if (!trimmed || trimmed.startsWith(':')) {
						continue;
					}

					if (trimmed === 'data: [DONE]') {
						return latestUsage;
					}

					if (!trimmed.startsWith('data: ')) {
						// `event:` lines carry no payload beyond the data line itself.
						continue;
					}

					const jsonStr = trimmed.slice(6);
					try {
						const parsed: unknown = JSON.parse(jsonStr);
						const usage = onEvent({
							type: isRecord(parsed) ? String(parsed.type ?? '') : undefined,
							data: parsed,
						});
						if (usage) {
							latestUsage = usage;
						}
					} catch (e) {
						logger.error('Failed to parse SSE chunk:', jsonStr.slice(0, 200), e);
					}
				}
			}

			return latestUsage;
		} finally {
			cancelListener?.dispose();
		}
	}
}

function reportFinalUsage(callbacks: StreamCallbacks, usage: DeepSeekUsage | undefined): void {
	if (!usage || !callbacks.onUsage) {
		return;
	}
	callbacks.onUsage(usage);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function normalizeResponsesUsage(value: unknown): DeepSeekUsage | undefined {
	const usage = asRecord(value);
	const inputTokens = asNumber(usage.input_tokens);
	const outputTokens = asNumber(usage.output_tokens);
	if (inputTokens === undefined && outputTokens === undefined) {
		return undefined;
	}
	const details = asRecord(usage.input_tokens_details);
	const cached = asNumber(details.cached_tokens) ?? 0;
	return {
		prompt_tokens: inputTokens ?? 0,
		completion_tokens: outputTokens ?? 0,
		total_tokens: asNumber(usage.total_tokens) ?? (inputTokens ?? 0) + (outputTokens ?? 0),
		prompt_cache_hit_tokens: cached,
		prompt_cache_miss_tokens: Math.max(0, (inputTokens ?? 0) - cached),
	};
}

function normalizeAnthropicUsage(value: unknown): DeepSeekUsage | undefined {
	const usage = asRecord(value);
	const inputTokens = asNumber(usage.input_tokens);
	const outputTokens = asNumber(usage.output_tokens);
	if (inputTokens === undefined && outputTokens === undefined) {
		return undefined;
	}
	const cached = asNumber(usage.cache_read_input_tokens) ?? 0;
	return {
		prompt_tokens: inputTokens ?? 0,
		completion_tokens: outputTokens ?? 0,
		total_tokens: (inputTokens ?? 0) + (outputTokens ?? 0),
		prompt_cache_hit_tokens: cached,
		prompt_cache_miss_tokens: Math.max(0, (inputTokens ?? 0) - cached),
	};
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
