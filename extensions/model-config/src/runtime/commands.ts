import vscode from 'vscode';
import { logger } from '../logger';
import { registerModelConfigPanel } from '../webview/modelConfigPanel';

export function registerCommands(context: vscode.ExtensionContext): void {
	registerModelConfigPanel(context);
	context.subscriptions.push(
		vscode.commands.registerCommand('leidong-models.showLogs', () => logger.show()),
		vscode.commands.registerCommand('leidong-models.openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', 'leidong-models'),
		),
	);
}
