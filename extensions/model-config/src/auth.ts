import vscode from 'vscode';
import { secretKeyFor } from './consts';
import { t } from './i18n';
import type { ModelFamily } from './types';

/**
 * Manages per-model API keys via VS Code SecretStorage.
 *
 * Keys are scoped to this extension's SecretStorage, keyed by model id
 * (`leidong-models.apiKey.<modelId>`). Legacy keys from the old extension
 * cannot be read here — users must re-enter them (see the migration notice).
 */
export class AuthManager {
	private readonly secretStorage: vscode.SecretStorage;

	constructor(context: vscode.ExtensionContext) {
		this.secretStorage = context.secrets;
	}

	async getApiKey(modelId: string): Promise<string | undefined> {
		const key = await this.secretStorage.get(secretKeyFor(modelId));
		return key?.trim() ? key.trim() : undefined;
	}

	async setApiKey(modelId: string, apiKey: string): Promise<void> {
		await this.secretStorage.store(secretKeyFor(modelId), apiKey.trim());
	}

	async deleteApiKey(modelId: string): Promise<void> {
		await this.secretStorage.delete(secretKeyFor(modelId));
	}

	async hasApiKey(modelId: string): Promise<boolean> {
		return (await this.getApiKey(modelId)) !== undefined;
	}

	/**
	 * Prompt the user to enter an API key for a model via input box.
	 * Returns true when a key was saved.
	 */
	async promptForApiKey(
		modelId: string,
		options?: { family?: ModelFamily; prefixHint?: string },
	): Promise<boolean> {
		const prefixHint = options?.prefixHint ?? (options?.family === 'mimo' ? 'tp- / sk-' : 'sk-');
		const apiKey = await vscode.window.showInputBox({
			prompt: `请输入 ${modelId} 的 API Key（通常以 ${prefixHint} 开头）`,
			placeHolder: `${prefixHint.split(' / ')[0]}xxxxxxx`,
			password: true,
			ignoreFocusOut: true,
			validateInput: (value: string) => {
				if (!value?.trim()) {
					return t('auth.emptyValidation');
				}
				return undefined;
			},
		});

		if (apiKey) {
			if (
				options?.family === 'mimo' &&
				!apiKey.trim().startsWith('tp-') &&
				!apiKey.trim().startsWith('sk-')
			) {
				void vscode.window.showWarningMessage(
					'MiMo 密钥通常以 tp-（TokenPlan）或 sk-（按量计费）开头，请确认没有误填。',
				);
			}
			await this.setApiKey(modelId, apiKey);
			vscode.window.showInformationMessage(t('auth.saved'));
			return true;
		}

		return false;
	}
}
