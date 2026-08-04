import vscode from 'vscode';
import { safeStringify } from '../json';
import type { DeepSeekMessage, DeepSeekTool, DeepSeekToolCall } from '../types';
import { parseFirstReplayMarker } from './replay';

/**
 * Convert VS Code chat messages to DeepSeek format.
 * Injects marker-replayed reasoning_content for assistant messages.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	isThinkingModel: boolean,
): DeepSeekMessage[] {
	const result: DeepSeekMessage[] = [];

	for (const message of messages) {
		const role = mapRole(message.role);

		let content = '';
		let thinkingContent = '';
		const toolCalls: DeepSeekToolCall[] = [];
		const toolResults: Array<{ callId: string; content: string }> = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				content += part.value;
			} else if (isLanguageModelThinkingPart(part)) {
				thinkingContent += normalizeThinkingPartText(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: {
						name: part.name,
						arguments: safeStringify(part.input),
					},
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				let toolContent = '';
				for (const item of part.content) {
					if (item instanceof vscode.LanguageModelTextPart) {
						toolContent += item.value;
					}
				}
				toolResults.push({
					callId: part.callId,
					content: toolContent || safeStringify(part.content),
				});
			}
		}

		if (role === 'assistant') {
			if (content || toolCalls.length > 0) {
				const replayMarker = isThinkingModel ? parseFirstReplayMarker(message) : undefined;
				const msg: DeepSeekMessage = {
					role: 'assistant' as const,
					content: content || '',
				};

				if (toolCalls.length > 0) {
					msg.tool_calls = toolCalls;
				}

				if (isThinkingModel) {
					msg.reasoning_content = getReasoningContent(replayMarker, thinkingContent);
				}

				result.push(msg);
			}
		} else {
			if (content) {
				result.push({
					role: role as 'user' | 'assistant',
					content: content,
				});
			}
		}

		// Tool result messages follow their associated assistant message
		for (const tr of toolResults) {
			result.push({
				role: 'tool',
				content: tr.content,
				tool_call_id: tr.callId,
			});
		}
	}

	return result;
}

function getReasoningContent(
	replayMarker: ReturnType<typeof parseFirstReplayMarker>,
	thinkingContent: string,
): string {
	if (replayMarker?.valid && replayMarker.reasoningText) {
		return replayMarker.reasoningText;
	}
	return thinkingContent;
}

function isLanguageModelThinkingPart(part: unknown): part is vscode.LanguageModelThinkingPart {
	return (
		typeof vscode.LanguageModelThinkingPart === 'function' &&
		part instanceof vscode.LanguageModelThinkingPart
	);
}

function normalizeThinkingPartText(value: string | string[]): string {
	return Array.isArray(value) ? value.join('') : value;
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' {
	switch (role) {
		case vscode.LanguageModelChatMessageRole.User:
			return 'user';
		case vscode.LanguageModelChatMessageRole.Assistant:
			return 'assistant';
		default:
			return 'user';
	}
}

/**
 * Convert VS Code tool definitions to DeepSeek format.
 */
export function convertTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): DeepSeekTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}

	return tools.map((tool) => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema as Record<string, unknown> | undefined,
		},
	}));
}

/**
 * Count total characters across all messages to calibrate chars-per-token ratio.
 */
export function countMessageChars(messages: DeepSeekMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		total += msg.content?.length ?? 0;
		total += msg.reasoning_content?.length ?? 0;
		if (msg.tool_calls) {
			for (const tc of msg.tool_calls) {
				total += tc.function?.name?.length ?? 0;
				total += tc.function?.arguments?.length ?? 0;
			}
		}
	}
	return total;
}

// ---- Protocol conversions (canonical DeepSeek shape → target API) ----

/**
 * Convert canonical messages to the OpenAI Responses `input` array
 * (messages format + function_call / function_call_output items).
 */
export function toResponsesInput(
	messages: readonly DeepSeekMessage[],
): unknown[] {
	const input: unknown[] = [];

	for (const message of messages) {
		if (message.role === 'tool') {
			input.push({
				type: 'function_call_output',
				call_id: message.tool_call_id,
				output: message.content || '',
			});
			continue;
		}

		const role = message.role === 'assistant' ? 'assistant' : 'user';
		const content: unknown[] = [];
		if (message.content) {
			content.push({
				type: role === 'assistant' ? 'output_text' : 'input_text',
				text: message.content,
			});
		}
		input.push({ role, content });

		for (const toolCall of message.tool_calls ?? []) {
			input.push({
				type: 'function_call',
				call_id: toolCall.id,
				name: toolCall.function?.name,
				arguments: toolCall.function?.arguments ?? '',
			});
		}
	}

	return input;
}

/**
 * Convert canonical messages to Anthropic Messages format.
 * Returns the messages array plus the extracted `system` prompt.
 * Tool results are grouped into a single user message with tool_result blocks.
 */
export function toAnthropicMessages(
	messages: readonly DeepSeekMessage[],
): { messages: unknown[]; system: string } {
	const converted: unknown[] = [];
	const systemParts: string[] = [];
	const pendingToolResults: Array<{ tool_use_id: string; content: string }> = [];

	const flushToolResults = (): void => {
		if (pendingToolResults.length === 0) {
			return;
		}
		converted.push({
			role: 'user',
			content: pendingToolResults.map((result) => ({
				type: 'tool_result',
				tool_use_id: result.tool_use_id,
				content: result.content,
			})),
		});
		pendingToolResults.length = 0;
	};

	for (const message of messages) {
		if (message.role === 'system') {
			if (message.content) {
				systemParts.push(message.content);
			}
			continue;
		}

		if (message.role === 'tool') {
			pendingToolResults.push({
				tool_use_id: message.tool_call_id ?? '',
				content: message.content || '',
			});
			continue;
		}

		// user / assistant
		flushToolResults();

		const role = message.role === 'assistant' ? 'assistant' : 'user';
		const content: unknown[] = [];
		if (message.content) {
			content.push({ type: 'text', text: message.content });
		}
		for (const toolCall of message.tool_calls ?? []) {
			content.push({
				type: 'tool_use',
				id: toolCall.id,
				name: toolCall.function?.name,
				input: parseToolArguments(toolCall.function?.arguments),
			});
		}
		if (content.length > 0) {
			converted.push({ role, content });
		}
	}
	flushToolResults();

	return {
		messages: converted,
		system: systemParts.join('\n\n'),
	};
}

function parseToolArguments(argumentsJson: string | undefined): unknown {
	if (!argumentsJson) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(argumentsJson);
		return typeof parsed === 'object' && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

/** Convert canonical tools to OpenAI Responses `tools`. */
export function toResponsesTools(
	tools: readonly DeepSeekTool[] | undefined,
): unknown[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map((tool) => ({
		type: 'function',
		name: tool.function.name,
		description: tool.function.description,
		parameters: tool.function.parameters,
	}));
}

/** Convert canonical tools to Anthropic `tools`. */
export function toAnthropicTools(
	tools: readonly DeepSeekTool[] | undefined,
): unknown[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map((tool) => ({
		name: tool.function.name,
		description: tool.function.description,
		input_schema: tool.function.parameters,
	}));
}
