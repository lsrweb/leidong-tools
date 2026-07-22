import vscode from 'vscode';
import { t } from '../i18n';
import type { ModelDefinition, PricingCurrency } from '../types';
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
	m: ModelDefinition,
	hasApiKey: boolean,
	pricingCurrency?: PricingCurrency,
): ModelPickerChatInformation {
	const modelDetail = resolveModelText(m, 'detail') ?? m.detail;
	const modelTooltip = resolveModelText(m, 'tooltip');
	const missingCredentialDetail =
		m.endpoint === 'mimo'
			? '请先在命令面板运行“设置 MiMo API Key”。'
			: t('auth.apiKeyRequiredDetail');
	return {
		id: m.id,
		name: m.name,
		family: m.family,
		version: m.version,
		detail: hasApiKey ? modelDetail : missingCredentialDetail,
		tooltip: hasApiKey ? modelTooltip : missingCredentialDetail,
		statusIcon: hasApiKey ? undefined : new vscode.ThemeIcon('warning'),
		maxInputTokens: m.maxInputTokens,
		maxOutputTokens: m.maxOutputTokens,
		isBYOK: true,
		isUserSelectable: true,
		capabilities: {
			toolCalling: m.capabilities.toolCalling,
			imageInput: m.capabilities.imageInput,
		},
		...toModelCostInfo(m, pricingCurrency),
		...(m.capabilities.thinking ? { configurationSchema: buildThinkingEffortSchema(m.endpoint) } : {}),
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

function buildThinkingEffortSchema(endpoint: ModelDefinition['endpoint']) {
	const isMiMo = endpoint === 'mimo';
	const values = isMiMo ? ['none', 'low', 'medium', 'high'] : ['none', 'high', 'max'];
	const labels = isMiMo ? ['关闭', '低', '中', '高'] : [t('thinking.none'), t('thinking.high'), t('thinking.max')];
	const descriptions = isMiMo
		? ['关闭 MiMo 深度思考。', '开启 MiMo 深度思考。MiMo 当前将低/中/高映射为开启。', '开启 MiMo 深度思考。MiMo 当前将低/中/高映射为开启。', '开启 MiMo 深度思考。MiMo 当前将低/中/高映射为开启。']
		: [t('thinking.none.desc'), t('thinking.high.desc'), t('thinking.max.desc')];
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

function resolveModelText(m: ModelDefinition, field: 'detail' | 'tooltip'): string | undefined {
	const suffix = m.id.startsWith('deepseek-v4-') ? m.id.slice('deepseek-v4-'.length) : m.id;
	const key = `model.${suffix}.${field}`;
	const translated = t(key);
	return translated !== key ? translated : undefined;
}
