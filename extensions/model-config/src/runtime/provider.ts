import vscode from 'vscode';
import { VENDOR } from '../consts';
import { logger } from '../logger';
import { getChatModels } from '../models';
import { DeepSeekChatProvider } from '../provider';

export async function registerProvider(
	context: vscode.ExtensionContext,
): Promise<DeepSeekChatProvider> {
	const provider = new DeepSeekChatProvider(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('leidong-models.setApiKey', async () => {
			const modelId = await pickModelId();
			if (modelId) {
				await provider.configureApiKeyForModel(modelId);
			}
		}),
		vscode.commands.registerCommand('leidong-models.setVisionModel', () =>
			provider.setVisionModel(),
		),
		vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
	);

	// Copilot Chat can serve cached model info without configurationSchema.
	// Activate it first so this refresh reaches a live listener and re-queries the provider.
	await activateCopilotChat();
	provider.refreshModelPicker();

	return provider;
}

async function pickModelId(): Promise<string | undefined> {
	const models = getChatModels();
	if (models.length === 0) {
		vscode.window.showWarningMessage('模型列表为空，请先在"配置自定义模型"面板中添加模型。');
		return undefined;
	}

	const picked = await vscode.window.showQuickPick(
		models.map((model) => ({
			label: model.name,
			description: model.id,
			detail: model.baseUrl,
			modelId: model.id,
		})),
		{
			title: '选择要设置 API Key 的模型',
			placeHolder: '选择模型',
		},
	);
	return picked?.modelId;
}

async function activateCopilotChat(): Promise<void> {
	try {
		await vscode.extensions.getExtension('github.copilot-chat')?.activate();
	} catch (error) {
		logger.warn('Copilot Chat activation unavailable; model picker refresh may be delayed', error);
	}
}
