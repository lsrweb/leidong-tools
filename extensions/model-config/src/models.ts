import vscode from 'vscode';
import { CONFIG_SECTION } from './consts';
import { normalizeBaseUrl } from './endpoint';
import { logger } from './logger';
import type {
	ChatModelConfig,
	ModelApiType,
	ModelCapabilities,
	ModelFamily,
	PriceCategory,
} from './types';

/**
 * Model registry.
 *
 * The model list is user-configurable via the `leidong-models.models` setting
 * (defaults mirror package.json). This module normalizes raw settings entries
 * into `ChatModelConfig` and drops invalid ones with a warning.
 */

/**
 * Default model list.
 *
 * KEPT IN SYNC with the `leidong-models.models` default in package.json —
 * changes to one side MUST be mirrored in the other.
 */
export const DEFAULT_MODELS: ChatModelConfig[] = [
	{
		id: 'deepseek-v4-flash',
		name: 'DeepSeek V4 Flash',
		family: 'deepseek',
		version: 'v4',
		baseUrl: 'https://api.deepseek.com',
		maxInputTokens: 655360,
		maxOutputTokens: 393216,
		capabilities: {
			toolCalling: 128,
			imageInput: true,
			thinking: true,
		},
		thinkingEffort: 'high',
		pricing: {
			USD: { cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 },
			CNY: { cacheHitInput: 0.02, cacheMissInput: 1, output: 2 },
		},
		priceCategory: 'low',
	},
	{
		id: 'deepseek-v4-pro',
		name: 'DeepSeek V4 Pro',
		family: 'deepseek',
		version: 'v4',
		baseUrl: 'https://api.deepseek.com',
		maxInputTokens: 655360,
		maxOutputTokens: 393216,
		capabilities: {
			toolCalling: 128,
			imageInput: true,
			thinking: true,
		},
		thinkingEffort: 'high',
		pricing: {
			USD: { cacheHitInput: 0.003625, cacheMissInput: 0.435, output: 0.87 },
			CNY: { cacheHitInput: 0.025, cacheMissInput: 3, output: 6 },
		},
		priceCategory: 'low',
	},
	{
		id: 'mimo-v2.5-pro',
		name: 'MiMo V2.5 Pro',
		family: 'mimo',
		version: 'v2.5',
		baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
		maxInputTokens: 1048576,
		maxOutputTokens: 65536,
		capabilities: {
			toolCalling: true,
			imageInput: true,
			thinking: true,
		},
		thinkingEffort: 'high',
		// 2026-05-27 官方永久降价后与 DeepSeek V4 Pro 同价。
		pricing: {
			USD: { cacheHitInput: 0.003625, cacheMissInput: 0.435, output: 0.87 },
			CNY: { cacheHitInput: 0.025, cacheMissInput: 3, output: 6 },
		},
		priceCategory: 'low',
	},
];

/** Read the configured model list, normalizing entries and dropping invalid ones. */
export function getChatModels(): ChatModelConfig[] {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<unknown>('models', DEFAULT_MODELS);
	if (!Array.isArray(raw)) {
		logger.warn('leidong-models.models is not an array; falling back to defaults');
		return DEFAULT_MODELS;
	}

	const models: ChatModelConfig[] = [];
	const seenIds = new Set<string>();
	for (const entry of raw) {
		try {
			const model = normalizeChatModel(entry);
			if (seenIds.has(model.id)) {
				logger.warn(`Duplicate model id dropped: ${model.id}`);
				continue;
			}
			seenIds.add(model.id);
			models.push(model);
		} catch (error) {
			logger.warn(
				`Invalid model entry dropped (${describeEntry(entry)}): ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return models;
}

/** Look up a configured model by its VS Code model id. */
export function getChatModelById(id: string): ChatModelConfig | undefined {
	return getChatModels().find((model) => model.id === id);
}

/**
 * Validate and normalize a raw settings entry into a `ChatModelConfig`.
 * Throws a user-facing Error when the entry is invalid.
 */
export function normalizeChatModel(value: unknown): ChatModelConfig {
	if (!isRecord(value)) {
		throw new Error('模型配置必须是对象');
	}

	const id = asString(value.id);
	if (!id) {
		throw new Error('模型 ID 不能为空');
	}
	if (!/^[A-Za-z0-9._-]+$/u.test(id)) {
		throw new Error('模型 ID 只能包含字母、数字以及 . _ -');
	}

	const name = asString(value.name);
	if (!name) {
		throw new Error('模型名称不能为空');
	}

	const baseUrl = normalizeBaseUrl(asString(value.baseUrl));
	if (!baseUrl) {
		throw new Error('端点地址不能为空');
	}
	if (!isHttpUrl(baseUrl)) {
		throw new Error('端点地址必须是 http(s) 地址');
	}

	const family: ModelFamily = asString(value.family) || 'deepseek';
	const apiType = normalizeApiType(value.apiType);
	const thinkingEffort = normalizeThinkingEffort(value.thinkingEffort);
	const capabilities = normalizeCapabilities(value.capabilities, family);
	const maxInputTokens = normalizePositiveInt(value.maxInputTokens);
	const maxOutputTokens = normalizePositiveInt(value.maxOutputTokens);
	const maxTokens = normalizeNonNegativeInt(value.maxTokens);
	const pricing = normalizePricing(value.pricing);
	const priceCategory = normalizePriceCategory(value.priceCategory);

	return {
		id,
		name,
		family,
		...(asString(value.version) && { version: asString(value.version) }),
		...(asString(value.detail) && { detail: asString(value.detail) }),
		baseUrl,
		...(asString(value.apiModelId) && { apiModelId: asString(value.apiModelId) }),
		...(apiType !== 'chat-completions' && { apiType }),
		...(maxInputTokens !== undefined && { maxInputTokens }),
		...(maxOutputTokens !== undefined && { maxOutputTokens }),
		...(maxTokens !== undefined && { maxTokens }),
		capabilities,
		thinkingEffort,
		...(pricing !== undefined && { pricing }),
		...(priceCategory !== undefined && { priceCategory }),
	};
}

function describeEntry(value: unknown): string {
	if (isRecord(value)) {
		const id = asString(value.id);
		return id ? id : '<无 id>';
	}
	return String(value);
}

function normalizeApiType(value: unknown): ModelApiType {
	if (value === 'responses' || value === 'anthropic-messages') {
		return value;
	}
	return 'chat-completions';
}

function normalizeThinkingEffort(value: unknown): 'none' | 'low' | 'medium' | 'high' {
	if (value === 'none' || value === 'low' || value === 'medium' || value === 'high') {
		return value;
	}
	return 'high';
}

function normalizeCapabilities(value: unknown, family: ModelFamily): ModelCapabilities {
	const source = isRecord(value) ? value : {};
	const toolCalling = normalizeToolCalling(source.toolCalling);
	return {
		toolCalling,
		imageInput: typeof source.imageInput === 'boolean' ? source.imageInput : false,
		thinking: typeof source.thinking === 'boolean' ? source.thinking : true,
	};
}

function normalizeToolCalling(value: unknown): boolean | number {
	if (typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
		return value;
	}
	return true;
}

function normalizePositiveInt(value: unknown): number | undefined {
	return normalizeNonNegativeInt(value);
}

function normalizeNonNegativeInt(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined;
	}
	const int = Math.trunc(value);
	if (int < 0) {
		return undefined;
	}
	return int;
}

function normalizePriceCategory(value: unknown): PriceCategory | undefined {
	if (value === 'low' || value === 'medium' || value === 'high' || value === 'very_high') {
		return value;
	}
	return undefined;
}

function normalizePricing(
	value: unknown,
): Readonly<Record<'USD' | 'CNY', { cacheHitInput: number; cacheMissInput: number; output: number }>> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const normalized: Record<'USD' | 'CNY', { cacheHitInput: number; cacheMissInput: number; output: number }> = {} as never;
	let any = false;
	for (const currency of ['USD', 'CNY'] as const) {
		const pricing = isRecord(value[currency]) ? value[currency] : {};
		const cacheHitInput = asNumber(pricing.cacheHitInput);
		const cacheMissInput = asNumber(pricing.cacheMissInput);
		const output = asNumber(pricing.output);
		if (cacheHitInput === undefined || cacheMissInput === undefined || output === undefined) {
			continue;
		}
		normalized[currency] = { cacheHitInput, cacheMissInput, output };
		any = true;
	}
	return any ? normalized : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isHttpUrl(value: string): boolean {
	try {
		const protocol = new URL(value).protocol;
		return protocol === 'http:' || protocol === 'https:';
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}
