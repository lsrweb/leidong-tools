import vscode from 'vscode';
import {
	CONFIG_SECTION,
	LEGACY_CONFIG_SECTION,
	LEGACY_VISION_CONFIG_SECTION,
	MIGRATION_SHOWN_KEY,
	secretKeyFor,
} from './consts';
import { DEFAULT_MODELS } from './models';
import type { ChatModelConfig } from './types';

export type DebugMode = 'minimal' | 'metadata' | 'verbose';

/**
 * Diagnostic mode. `verbose` also enables metadata logs.
 *
 * The legacy boolean `debug` setting is still read as a fallback so old
 * settings keep working even if migration cannot update every scope.
 */
export function getDebugMode(): DebugMode {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const mode = getConfiguredDebugMode(config);
	if (mode) return mode;

	// Read-only fallback to the pre-extraction section.
	const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION);
	const legacyMode = getConfiguredDebugMode(legacy);
	if (legacyMode) return legacyMode;
	if (legacy.get<boolean>('debug', false)) return 'metadata';

	return config.get<boolean>('debug', false) ? 'metadata' : 'minimal';
}

/**
 * Whether to log privacy-preserving diagnostic debug information.
 */
export function getDebugLoggingEnabled(): boolean {
	return getDebugMode() !== 'minimal';
}

/**
 * Whether to write full request payloads to disk.
 */
export function getRequestDumpEnabled(): boolean {
	return getDebugMode() === 'verbose';
}

export function getStabilizeToolListEnabled(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	if (config.get<boolean>('experimental.stabilizeToolList', false)) {
		return true;
	}
	// Read-only fallback to the pre-extraction section.
	return vscode.workspace
		.getConfiguration(LEGACY_CONFIG_SECTION)
		.get<boolean>('experimental.stabilizeToolList', false);
}

/**
 * Migrate the legacy boolean `debug` setting to `debugMode`.
 *
 * `debug: true` maps to `debugMode: metadata`; `debug: false` maps to the
 * default `minimal`, so it only needs cleanup.
 */
export async function migrateLegacyDebugSetting(): Promise<void> {
	await migrateLegacyDebugSettingAtScope(vscode.ConfigurationTarget.Global);
	if (vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length) {
		await migrateLegacyDebugSettingAtScope(vscode.ConfigurationTarget.Workspace);
	}
}

/**
 * One-time migration of the pre-extraction settings
 * (`leidong-tools.copilot.*` and `deepseek-copilot.visionModel`).
 *
 * Folded into the new `leidong-models.models` list when the user has not
 * customized it yet. API keys cannot be migrated (SecretStorage is scoped
 * per extension) — the plain-text `deepseekApiKey` setting fallback CAN be,
 * which also upgrades its storage security.
 */
export async function migrateLegacySettings(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(MIGRATION_SHOWN_KEY, false)) {
		return;
	}

	const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION);
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const legacyVision = vscode.workspace.getConfiguration(LEGACY_VISION_CONFIG_SECTION);

	const legacyKeys: ReadonlyArray<string> = [
		'deepseekBaseUrl',
		'mimoBaseUrl',
		'mimoAccessMode',
		'mimoTokenPlanRegion',
		'mimoThinkingEffort',
		'deepseekModelIdOverrides',
		'mimoModelIdOverrides',
		'maxTokens',
		'debug',
		'debugMode',
		'experimental.stabilizeToolList',
	];
	const hasLegacySettings = legacyKeys.some((key) => isConfigured(legacy, key));
	const legacyVisionModel = getConfiguredString(legacyVision, 'visionModel');
	const legacyDeepSeekApiKey = getConfiguredString(legacy, 'deepseekApiKey');

	if (!hasLegacySettings && !legacyVisionModel && !legacyDeepSeekApiKey) {
		await context.globalState.update(MIGRATION_SHOWN_KEY, true);
		return;
	}

	let migrated = false;

	if (hasLegacySettings) {
		const models = migrateModels(DEFAULT_MODELS, legacy);
		await config.update('models', models, vscode.ConfigurationTarget.Global);
		migrated = true;
	}

	if (legacyVisionModel) {
		await config.update('visionModel', legacyVisionModel, vscode.ConfigurationTarget.Global);
		migrated = true;
	}

	if (legacyDeepSeekApiKey) {
		const target = DEFAULT_MODELS.find((model) => model.id === 'deepseek-v4-flash') ?? DEFAULT_MODELS[0];
		if (target) {
			await context.secrets.store(secretKeyFor(target.id), legacyDeepSeekApiKey.trim());
			migrated = true;
		}
	}

	const legacyStabilizeToolList = getConfigured(legacy, 'experimental.stabilizeToolList');
	if (legacyStabilizeToolList === true) {
		await config.update(
			'experimental.stabilizeToolList',
			true,
			vscode.ConfigurationTarget.Global,
		);
	}

	await context.globalState.update(MIGRATION_SHOWN_KEY, true);

	if (migrated) {
		void vscode.window.showInformationMessage(
			'已把旧版自定义端点设置迁移到"雷动模型配置"扩展：模型名称与端点已保留。' +
				'旧 API Key 与视觉代理配置因扩展安全隔离无法自动迁移，请打开"配置自定义模型"面板重新设置。',
		);
	}
}

function migrateModels(base: readonly ChatModelConfig[], legacy: vscode.WorkspaceConfiguration): ChatModelConfig[] {
	const models = cloneModels(base);

	const deepseekBaseUrl = getConfiguredString(legacy, 'deepseekBaseUrl');
	if (deepseekBaseUrl) {
		for (const model of models) {
			if (model.family === 'deepseek') {
				model.baseUrl = deepseekBaseUrl;
			}
		}
	}

	const mimoBaseUrl = resolveLegacyMiMoBaseUrl(legacy);
	if (mimoBaseUrl) {
		for (const model of models) {
			if (model.family === 'mimo') {
				model.baseUrl = mimoBaseUrl;
			}
		}
	}

	const mimoThinkingEffort = getConfigured(legacy, 'mimoThinkingEffort');
	if (
		mimoThinkingEffort === 'none' ||
		mimoThinkingEffort === 'low' ||
		mimoThinkingEffort === 'medium' ||
		mimoThinkingEffort === 'high'
	) {
		for (const model of models) {
			if (model.family === 'mimo') {
				model.thinkingEffort = mimoThinkingEffort;
			}
		}
	}

	applyModelIdOverrides(models, getConfiguredRecord(legacy, 'deepseekModelIdOverrides'));
	applyModelIdOverrides(models, getConfiguredRecord(legacy, 'mimoModelIdOverrides'));

	const maxTokens = getConfigured(legacy, 'maxTokens');
	if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) {
		for (const model of models) {
			model.maxTokens = Math.trunc(maxTokens);
		}
	}

	return models;
}

function resolveLegacyMiMoBaseUrl(legacy: vscode.WorkspaceConfiguration): string | undefined {
	const accessMode = getConfigured(legacy, 'mimoAccessMode');
	if (accessMode === 'tokenPlan') {
		const region = getConfigured(legacy, 'mimoTokenPlanRegion');
		return `https://token-plan-${region === 'sgp' || region === 'ams' ? region : 'cn'}.xiaomimimo.com/v1`;
	}
	if (accessMode === 'payAsYouGo') {
		return 'https://api.xiaomimimo.com/v1';
	}
	// custom (or unset): explicit base URL
	return getConfiguredString(legacy, 'mimoBaseUrl');
}

function applyModelIdOverrides(
	models: ChatModelConfig[],
	overrides: Record<string, unknown> | undefined,
): void {
	if (!overrides) {
		return;
	}
	for (const model of models) {
		const override = overrides[model.id];
		if (typeof override === 'string' && override.trim().length > 0) {
			model.apiModelId = override.trim();
		}
	}
}

function cloneModels(models: readonly ChatModelConfig[]): ChatModelConfig[] {
	return JSON.parse(JSON.stringify(models)) as ChatModelConfig[];
}

function isConfigured(config: vscode.WorkspaceConfiguration, key: string): boolean {
	const inspection = config.inspect<unknown>(key);
	return (
		inspection?.globalValue !== undefined ||
		inspection?.workspaceValue !== undefined ||
		inspection?.workspaceFolderValue !== undefined
	);
}

function getConfigured<T>(config: vscode.WorkspaceConfiguration, key: string): T | undefined {
	const inspection = config.inspect<T>(key);
	return inspection?.workspaceValue ?? inspection?.globalValue;
}

function getConfiguredString(config: vscode.WorkspaceConfiguration, key: string): string | undefined {
	const value = getConfigured<unknown>(config, key);
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getConfiguredRecord(
	config: vscode.WorkspaceConfiguration,
	key: string,
): Record<string, unknown> | undefined {
	const value = getConfigured<unknown>(config, key);
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function getConfiguredDebugMode(config: vscode.WorkspaceConfiguration): DebugMode | undefined {
	const mode = config.inspect<unknown>('debugMode');
	return normalizeDebugMode(mode?.workspaceValue) ?? normalizeDebugMode(mode?.globalValue);
}

function normalizeDebugMode(value: unknown): DebugMode | undefined {
	if (value === 'minimal' || value === 'metadata' || value === 'verbose') {
		return value;
	}
	return undefined;
}

async function migrateLegacyDebugSettingAtScope(
	target: vscode.ConfigurationTarget,
	resource?: vscode.Uri,
): Promise<void> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
	const legacy = config.inspect<boolean>('debug');
	const mode = config.inspect<DebugMode>('debugMode');
	const legacyValue = getScopedValue(legacy, target);

	if (legacyValue === undefined) {
		return;
	}

	if (legacyValue === true && getScopedValue(mode, target) === undefined) {
		await config.update('debugMode', 'metadata', target);
	}
	await config.update('debug', undefined, target);
}

function getScopedValue<T>(
	inspection:
		| {
				globalValue?: T;
				workspaceValue?: T;
				workspaceFolderValue?: T;
		  }
		| undefined,
	target: vscode.ConfigurationTarget,
): T | undefined {
	if (!inspection) {
		return undefined;
	}

	if (target === vscode.ConfigurationTarget.Global) {
		return inspection.globalValue;
	}
	if (target === vscode.ConfigurationTarget.Workspace) {
		return inspection.workspaceValue;
	}
	return undefined;
}
