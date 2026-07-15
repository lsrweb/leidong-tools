import vscode from 'vscode';
import { API_KEY_SECRET, MIMO_API_KEY_SECRET, MIMO_TOKEN_PLAN_API_KEY_SECRET } from './consts';
import { t } from './i18n';

/**
 * Manages DeepSeek API key via VS Code SecretStorage (secure) with
 * fallback to extension settings (less secure, for CI/automation).
 */
export class AuthManager {
	private readonly secretStorage: vscode.SecretStorage;

	constructor(context: vscode.ExtensionContext) {
		this.secretStorage = context.secrets;
	}

	/**
	 * Get API key. Tries SecretStorage first, then falls back to settings.
	 */
	async getApiKey(endpoint: CredentialSet = 'deepseek'): Promise<string | undefined> {
		const secretKey = await this.secretStorage.get(this.getSecretKey(endpoint));
		if (secretKey) {
			return secretKey;
		}

		const config = vscode.workspace.getConfiguration('leidong-tools.copilot');
		const settingsKey = endpoint === 'deepseek' ? config.get<string>('deepseekApiKey') : undefined;
		if (settingsKey?.trim()) {
			return settingsKey.trim();
		}

		return undefined;
	}

	/**
	 * Store API key in SecretStorage.
	 */
	async setApiKey(apiKey: string, endpoint: CredentialSet = 'deepseek'): Promise<void> {
		await this.secretStorage.store(this.getSecretKey(endpoint), apiKey.trim());
	}

	/**
	 * Delete stored API key.
	 */
	async deleteApiKey(endpoint: CredentialSet = 'deepseek'): Promise<void> {
		await this.secretStorage.delete(this.getSecretKey(endpoint));
	}

	/**
	 * Check if an API key is configured.
	 */
	async hasApiKey(endpoint: CredentialSet = 'deepseek'): Promise<boolean> {
		const key = await this.getApiKey(endpoint);
		return key !== undefined && key.length > 0;
	}

	/**
	 * Prompt user to enter API key via input box.
	 */
	async promptForApiKey(endpoint: CredentialSet = 'deepseek'): Promise<boolean> {
		const apiKey = await vscode.window.showInputBox({
			prompt: endpoint === 'mimo-token-plan' ? '请输入 MiMo TokenPlan API Key（以 tp- 开头）' : endpoint === 'mimo' ? '请输入 MiMo 按量计费 API Key（以 sk- 开头）' : t('auth.prompt'),
			placeHolder: endpoint === 'mimo-token-plan' ? 'tp-xxxxxxxx' : endpoint === 'mimo' ? 'sk-xxxxxxxx' : t('auth.placeholder'),
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
			if (endpoint === 'mimo-token-plan' && !apiKey.trim().startsWith('tp-')) {
				void vscode.window.showWarningMessage('MiMo TokenPlan 密钥通常以 tp- 开头，请确认没有误填按量计费密钥。');
			}
			await this.setApiKey(apiKey, endpoint);
			vscode.window.showInformationMessage(endpoint !== 'deepseek' ? 'MiMo API Key 已安全保存。' : t('auth.saved'));
			return true;
		}

		return false;
	}

	private getSecretKey(endpoint: CredentialSet): string {
		return endpoint === 'mimo-token-plan' ? MIMO_TOKEN_PLAN_API_KEY_SECRET : endpoint === 'mimo' ? MIMO_API_KEY_SECRET : API_KEY_SECRET;
	}
}

export type CredentialSet = 'deepseek' | 'mimo' | 'mimo-token-plan';
