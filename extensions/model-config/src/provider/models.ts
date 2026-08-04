import vscode from 'vscode';
import { t } from '../i18n';
import type { ChatModelConfig, PricingCurrency } from '../types';
import { toModelCostInfo, type ModelCostInformation } from './pricing/costs';

/**
 * NOTE: Non-public API surface.
 *
 * The fields below (`configurationSchema` on chat info, cost metadata,
 * `modelConfiguration` on response options, plus `isBYOK` / `isUserSelectable` /
 * `statusIcon`)
 * are not part of the stable `vscode.LanguageModelChat*` typings yet. They are
 * the same shape currently consumed by GitHub Copilot Chat to render model picker
 * metadata and per-model configuration controls.
 */

export type ThinkingEffort = 'none' | 'low' | 'medium' | 'high' | 'max';

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

type ThinkingEffortConfigurationSchema = ReturnType<typeof buildThinkingEffortSchema>;

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation &
	ModelCostInformation & {
		readonly isUserSelectable: boolean;
		readonly isBYOK: true;
		readonly statusIcon?: vscode.ThemeIcon;
		readonly configurationSchema?: ThinkingEffortConfigurationSchema;
	};

export function toChatInfo(
	m: ChatModelConfig,
	hasApiKey: boolean,
	pricingCurrency?: PricingCurrency,
): ModelPickerChatInformation {
	const modelDetail = m.detail;
	const modelTooltip = resolveModelText(m, 'tooltip');
	const missingCredentialDetail = t('auth.apiKeyRequiredDetail');
	return {
		id: m.id,
		name: m.name,
		family: m.family,
		version: m.version ?? '',
		detail: hasApiKey ? modelDetail : missingCredentialDetail,
		tooltip: hasApiKey ? modelTooltip : missingCredentialDetail,
		statusIcon: hasApiKey ? undefined : new vscode.ThemeIcon('warning'),
		maxInputTokens: m.maxInputTokens ?? 0,
		maxOutputTokens: m.maxOutputTokens ?? 0,
		isBYOK: true,
		isUserSelectable: true,
		capabilities: {
			toolCalling: m.capabilities?.toolCalling ?? true,
			imageInput: m.capabilities?.imageInput ?? false,
		},
		...toModelCostInfo(m, pricingCurrency),
		...(m.capabilities?.thinking ?? true
			? { configurationSchema: buildThinkingEffortSchema(m.family) }
			: {}),
	};
}

export function getConfiguredThinkingEffort(
	options: ModelConfigurationOptions,
	fallback: ThinkingEffort = 'high',
): ThinkingEffort {
	const configuredEffort =
		options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort;

	if (configuredEffort === 'none') {
		return 'none';
	}

	return configuredEffort === 'low' || configuredEffort === 'medium' || configuredEffort === 'high' || configuredEffort === 'max'
		? configuredEffort
		: fallback;
}

function buildThinkingEffortSchema(family: ChatModelConfig['family']) {
	// deepseek exposes a dedicated reasoning_effort; mimo maps low/medium/high
	// to thinking.enabled; other OpenAI-compatible platforms use the generic set.
	const isMiMo = family === 'mimo';
	const isDeepSeek = family === 'deepseek';
	const values = isDeepSeek
		? ['none', 'high', 'max']
		: isMiMo
			? ['none', 'low', 'medium', 'high']
			: ['none', 'low', 'medium', 'high'];
	const labels = isDeepSeek
		? [t('thinking.none'), t('thinking.high'), t('thinking.max')]
		: ['关闭', '低', '中', '高'];
	const descriptions = isDeepSeek
		? [t('thinking.none.desc'), t('thinking.high.desc'), t('thinking.max.desc')]
		: isMiMo
			? ['关闭 MiMo 深度思考。', '开启 MiMo 深度思考。MiMo 当前将低/中/高映射为开启。', '开启 MiMo 深度思考。MiMo 当前将低/中/高映射为开启。', '开启 MiMo 深度思考。MiMo 当前将低/中/高映射为开启。']
			: ['关闭深度思考，响应更快。', '开启深度思考。', '开启深度思考。', '开启深度思考。'];
	return {
		properties: {
			reasoningEffort: {
				type: 'string',
				title: t('status.thinking'),
				enum: values,
				enumItemLabels: labels,
				enumDescriptions: descriptions,
				default: 'high',
				group: 'navigation',
			},
		},
	} as const;
}

function resolveModelText(m: ChatModelConfig, field: 'detail' | 'tooltip'): string | undefined {
	const suffix = m.id.startsWith('deepseek-v4-') ? m.id.slice('deepseek-v4-'.length) : m.id;
	const key = `model.${suffix}.${field}`;
	const translated = t(key);
	return translated !== key ? translated : undefined;
}
