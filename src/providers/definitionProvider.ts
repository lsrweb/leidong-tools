/**
 * Vue HTML 定义提供器 - 重构版本
 */
import * as vscode from 'vscode';
import { DefinitionLogic } from '../utils';

export class VueHtmlDefinitionProvider implements vscode.DefinitionProvider {
    private definitionLogic: DefinitionLogic;

    constructor() {
        this.definitionLogic = new DefinitionLogic();
    }

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Location | null> {
        return await this.definitionLogic.provideDefinition(document, position);
    }
}
