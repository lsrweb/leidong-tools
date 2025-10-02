/**
 * Vue HTML 定义提供器
 * 统一使用增强解析器
 */
import * as vscode from 'vscode';
import { EnhancedDefinitionLogic } from '../finders/enhancedDefinitionLogic';

export class VueHtmlDefinitionProvider implements vscode.DefinitionProvider {
    private definitionLogic: EnhancedDefinitionLogic;

    constructor() {
        this.definitionLogic = new EnhancedDefinitionLogic();
    }

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Location | null> {
        return await this.definitionLogic.provideDefinition(document, position);
    }
}
