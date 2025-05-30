/**
 * Vue HTML 定义提供器
 */
import * as vscode from 'vscode';
import { findVueDefinition } from '../utils';

export class VueHtmlDefinitionProvider implements vscode.DefinitionProvider {
    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Location | null> {
        // Call the shared helper function
        return await findVueDefinition(document, position);
    }
}
