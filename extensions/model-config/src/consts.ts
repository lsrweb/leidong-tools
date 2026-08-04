import type { ModelFamily } from './types';

/**
 * Compile-time constants shared across the extension.
 *
 * These do NOT depend on the VS Code runtime (no workspace configuration,
 * no secrets API). For run-time settings reads see `config.ts` and `models.ts`.
 */

/** VS Code configuration section prefix for all extension settings. */
export const CONFIG_SECTION = 'leidong-models';

/** Vendor id registered with vscode.lm.registerLanguageModelChatProvider. */
export const VENDOR = 'leidong-tools';

export const EXTERNAL_URLS = {
	deepseek: {
		apiKeys: 'https://platform.deepseek.com/api_keys',
		usage: 'https://platform.deepseek.com/usage',
		status: 'https://status.deepseek.com',
	},
} as const;

// VS Code's internal LanguageModelChatMessageRole.System is not exposed in @types/vscode.
export const LANGUAGE_MODEL_CHAT_SYSTEM_ROLE = 3;

// ---- Secret keys ----

/** SecretStorage key prefix for per-model API keys. */
const API_KEY_SECRET_PREFIX = 'leidong-models.apiKey.';

/** SecretStorage key for a model's API key. */
export function secretKeyFor(modelId: string): string {
	return API_KEY_SECRET_PREFIX + modelId;
}

/** memento key tracking whether the legacy settings migration has run. */
export const MIGRATION_SHOWN_KEY = 'leidong-models.migration.v1';

// ---- Legacy (pre-extraction) constants ----

/** Old config section of the leidong-tools main extension. */
export const LEGACY_CONFIG_SECTION = 'leidong-tools.copilot';

/** Old config section of the upstream deepseek-copilot extension. */
export const LEGACY_VISION_CONFIG_SECTION = 'deepseek-copilot';

// ---- Endpoint presets ----

/** Official endpoint presets offered by the model configuration panel. */
export interface EndpointPreset {
	id: string;
	label: string;
	family: ModelFamily;
	baseUrl: string;
	/** Expected API key prefix hint shown in the panel (tp- / sk-). */
	keyPrefixHint?: string;
}

export const ENDPOINT_PRESETS: readonly EndpointPreset[] = [
	{
		id: 'deepseek',
		label: 'DeepSeek 官方',
		family: 'deepseek',
		baseUrl: 'https://api.deepseek.com',
		keyPrefixHint: 'sk-',
	},
	{
		id: 'mimo-payg',
		label: 'MiMo 按量计费',
		family: 'mimo',
		baseUrl: 'https://api.xiaomimimo.com/v1',
		keyPrefixHint: 'sk-',
	},
	{
		id: 'mimo-tp-cn',
		label: 'MiMo TokenPlan 中国区',
		family: 'mimo',
		baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
		keyPrefixHint: 'tp-',
	},
	{
		id: 'mimo-tp-sgp',
		label: 'MiMo TokenPlan 新加坡',
		family: 'mimo',
		baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
		keyPrefixHint: 'tp-',
	},
	{
		id: 'mimo-tp-ams',
		label: 'MiMo TokenPlan 欧洲',
		family: 'mimo',
		baseUrl: 'https://token-plan-ams.xiaomimimo.com/v1',
		keyPrefixHint: 'tp-',
	},
];
