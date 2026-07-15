import vscode from 'vscode';
import { getMiMoAccessMode } from '../config';
import { logger } from '../logger';
import { DeepSeekChatProvider } from '../provider';

export async function registerProvider(
	context: vscode.ExtensionContext,
): Promise<DeepSeekChatProvider> {
	const provider = new DeepSeekChatProvider(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('leidong-tools.copilot.setDeepSeekApiKey', () => provider.configureApiKey('deepseek')),
		vscode.commands.registerCommand('leidong-tools.copilot.clearDeepSeekApiKey', () => provider.clearApiKey('deepseek')),
		vscode.commands.registerCommand('leidong-tools.copilot.setMiMoApiKey', () =>
			provider.configureApiKey(getMiMoAccessMode() === 'tokenPlan' ? 'mimo-token-plan' : 'mimo'),
		),
		vscode.commands.registerCommand('leidong-tools.copilot.setMiMoTokenPlanApiKey', () => provider.configureApiKey('mimo-token-plan')),
		vscode.commands.registerCommand('leidong-tools.copilot.setMiMoPayAsYouGoApiKey', () => provider.configureApiKey('mimo')),
		vscode.commands.registerCommand('leidong-tools.copilot.clearMiMoApiKey', () => provider.clearApiKey('mimo')),
		vscode.commands.registerCommand('leidong-tools.copilot.setVisionModel', () =>
			provider.setVisionModel(),
		),
		vscode.lm.registerLanguageModelChatProvider('leidong-tools', provider),
	);

	// Copilot Chat can serve cached model info without configurationSchema.
	// Activate it first so this refresh reaches a live listener and re-queries the provider.
	await activateCopilotChat();
	provider.refreshModelPicker();

	return provider;
}

async function activateCopilotChat(): Promise<void> {
	try {
		await vscode.extensions.getExtension('github.copilot-chat')?.activate();
	} catch (error) {
		logger.warn('Copilot Chat activation unavailable; model picker refresh may be delayed', error);
	}
}
