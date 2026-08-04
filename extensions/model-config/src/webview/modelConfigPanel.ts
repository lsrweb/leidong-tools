import vscode from 'vscode';
import { CONFIG_SECTION, ENDPOINT_PRESETS, secretKeyFor } from '../consts';
import { getChatModels, normalizeChatModel } from '../models';
import { getModelConfigPanelHtml, type ModelConfigPanelState } from './ui/html';

let currentPanel: vscode.WebviewPanel | undefined;

/** Register the panel command plus live refresh listeners. */
export function registerModelConfigPanel(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('leidong-models.openModelPanel', () =>
			openModelConfigPanel(context),
		),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(CONFIG_SECTION) && currentPanel) {
				void postState(currentPanel, context);
			}
		}),
		context.secrets.onDidChange((e) => {
			if (e.key.startsWith('leidong-models.apiKey.') && currentPanel) {
				void postState(currentPanel, context);
			}
		}),
	);
}

function openModelConfigPanel(context: vscode.ExtensionContext): void {
	if (currentPanel) {
		currentPanel.reveal();
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'leidongModelsConfig',
		'自定义模型配置',
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: false,
		},
	);
	currentPanel = panel;

	panel.onDidDispose(() => {
		currentPanel = undefined;
	});

	panel.webview.onDidReceiveMessage((message: unknown) => {
		void handleMessage(panel, context, message);
	});

	void renderPanel(panel, context);
}

async function renderPanel(
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
): Promise<void> {
	panel.webview.html = getModelConfigPanelHtml(panel.webview, await getState(context));
}

async function postState(
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
): Promise<void> {
	await panel.webview.postMessage({ type: 'state', value: await getState(context) });
}

async function getState(context: vscode.ExtensionContext): Promise<ModelConfigPanelState> {
	const models = getChatModels();
	const hasApiKeys: Record<string, boolean> = {};
	await Promise.all(
		models.map(async (model) => {
			hasApiKeys[model.id] = (await context.secrets.get(secretKeyFor(model.id))) !== undefined;
		}),
	);
	return { models, hasApiKeys, presets: ENDPOINT_PRESETS };
}

function postStatus(
	panel: vscode.WebviewPanel,
	message: string,
	tone: 'info' | 'success' | 'error' = 'info',
): void {
	void panel.webview.postMessage({
		type: 'status',
		value: {
			message,
			error: tone === 'error',
			success: tone === 'success',
		},
	});
}

async function handleMessage(
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
	message: unknown,
): Promise<void> {
	if (!isWebviewMessage(message)) {
		return;
	}

	try {
		if (message.type === 'save') {
			await handleSave(panel, context, message.value);
			return;
		}
		if (message.type === 'delete') {
			await handleDelete(panel, context, message.value);
			return;
		}
		if (message.type === 'clearApiKey') {
			await handleClearApiKey(panel, context, message.value);
			return;
		}
	} catch (error) {
		postStatus(panel, error instanceof Error ? error.message : String(error), 'error');
	}
}

async function handleSave(
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
	value: unknown,
): Promise<void> {
	const payload = asRecord(value);
	const model = normalizeChatModel(payload.model);
	const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';

	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const current = config.get<unknown>('models', []);
	const list = Array.isArray(current) ? current.slice() : [];
	const existingIndex = list.findIndex((entry) => isRecord(entry) && entry.id === model.id);
	if (existingIndex >= 0) {
		list[existingIndex] = model;
	} else {
		if (list.some((entry) => isRecord(entry) && entry.id === model.id)) {
			throw new Error(`模型 ID "${model.id}" 已存在。`);
		}
		list.push(model);
	}

	await config.update('models', list, vscode.ConfigurationTarget.Global);
	if (apiKey) {
		await context.secrets.store(secretKeyFor(model.id), apiKey);
	}

	await postState(panel, context);
	postStatus(panel, `模型 "${model.name}" 已保存。`, 'success');
}

async function handleDelete(
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
	value: unknown,
): Promise<void> {
	const id = asRecord(value).id;
	if (typeof id !== 'string' || id.length === 0) {
		throw new Error('删除请求缺少模型 ID。');
	}

	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const current = config.get<unknown>('models', []);
	const list = (Array.isArray(current) ? current : []).filter(
		(entry) => !(isRecord(entry) && entry.id === id),
	);
	await config.update('models', list, vscode.ConfigurationTarget.Global);
	await context.secrets.delete(secretKeyFor(id));

	await postState(panel, context);
	postStatus(panel, `模型 "${id}" 已删除。`, 'success');
}

async function handleClearApiKey(
	panel: vscode.WebviewPanel,
	context: vscode.ExtensionContext,
	value: unknown,
): Promise<void> {
	const id = asRecord(value).id;
	if (typeof id !== 'string' || id.length === 0) {
		throw new Error('清除请求缺少模型 ID。');
	}

	await context.secrets.delete(secretKeyFor(id));
	await postState(panel, context);
	postStatus(panel, `模型 "${id}" 的 API Key 已清除。`, 'success');
}

function isWebviewMessage(value: unknown): value is { type: string; value?: unknown } {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		typeof (value as { type: unknown }).type === 'string'
	);
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
