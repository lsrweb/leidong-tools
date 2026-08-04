/**
 * Shared types for the DeepSeek Copilot extension.
 */

// ---- API request/response types ----

export interface DeepSeekMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	tool_call_id?: string;
	tool_calls?: DeepSeekToolCall[];
	reasoning_content?: string;
}

export interface DeepSeekToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface DeepSeekTool {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface DeepSeekUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
}

export interface DeepSeekRequest {
	model: string;
	messages: DeepSeekMessage[];
	stream: boolean;
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	tools?: DeepSeekTool[];
	tool_choice?: 'none' | 'auto' | 'required';
	thinking?: { type: 'enabled' | 'disabled' };
	reasoning_effort?: 'high' | 'max';
	stream_options?: {
		include_usage: boolean;
	};
}

export interface DeepSeekStreamChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: {
			role?: string;
			content?: string;
			reasoning_content?: string;
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
		finish_reason: string | null;
	}>;
	usage?: DeepSeekUsage;
}

// ---- Stream callbacks ----

export interface StreamCallbacks {
	onContent: (content: string) => void;
	onThinking: (text: string) => void;
	onToolCall: (toolCall: DeepSeekToolCall) => void;
	onError: (error: Error) => void;
	onDone: () => void;
	onUsage?: (usage: DeepSeekUsage) => void;
}

// ---- Model definitions ----

export type PricingCurrency = 'USD' | 'CNY';

export type PriceCategory = 'low' | 'medium' | 'high' | 'very_high';

/**
 * Model family — a free-form platform tag (deepseek / mimo / openai / qwen / …).
 * It drives thinking-effort presets and which extra request parameters are sent.
 */
export type ModelFamily = string;

/**
 * Endpoint protocol of the model's baseUrl.
 * - chat-completions: OpenAI-style POST {base}/chat/completions (default, most compatible)
 * - responses:        OpenAI Responses API POST {base}/responses
 * - anthropic-messages: Anthropic Messages API POST {base}/messages (x-api-key auth)
 */
export type ModelApiType = 'chat-completions' | 'responses' | 'anthropic-messages';

export interface ModelPricing {
	cacheHitInput: number;
	cacheMissInput: number;
	output: number;
}

export interface ModelCapabilities {
	/** Max functions per request when a number; plain boolean otherwise. */
	toolCalling?: boolean | number;
	imageInput?: boolean;
	thinking?: boolean;
}

/**
 * User-configurable model definition (flat, one model = one endpoint).
 *
 * Kept in sync with the `leidong-models.models` default in package.json —
 * changes to one side MUST be mirrored in the other.
 */
export interface ChatModelConfig {
	/** Unique id — also the VS Code LanguageModelChatInformation id. */
	id: string;
	/** Display name shown in the Copilot Chat model picker. */
	name: string;
	family: ModelFamily;
	version?: string;
	/** Picker subtitle. */
	detail?: string;
	/** Endpoint base URL. */
	baseUrl: string;
	/** Endpoint protocol; defaults to 'chat-completions'. */
	apiType?: ModelApiType;
	/** Model id sent to the endpoint; empty → uses `id`. */
	apiModelId?: string;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	/** Per-request max output tokens cap; 0/absent → API default. */
	maxTokens?: number;
	capabilities?: ModelCapabilities;
	/** Default thinking effort (deepseek: none/high/max semantics; mimo: none/low/medium/high). */
	thinkingEffort?: 'none' | 'low' | 'medium' | 'high';
	/** Per-million-token prices for the picker cost hint. */
	pricing?: Readonly<Record<PricingCurrency, ModelPricing>>;
	priceCategory?: PriceCategory;
}
