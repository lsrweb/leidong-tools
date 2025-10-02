import * as vscode from 'vscode';
import { resolveVueIndexForHtml, findDefinitionInIndex, findChainedRootDefinition } from '../parsers/parseDocument';
import { findTemplateVar } from '../finders/templateIndexer';

export class VueHoverProvider implements vscode.HoverProvider {
    private hoverTimeout: NodeJS.Timeout | null = null;

    provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | null> {
        return new Promise((resolve) => {
            // 清除之前的定时器
            if (this.hoverTimeout) {
                clearTimeout(this.hoverTimeout);
            }

            // 读取配置的延迟时间
            const config = vscode.workspace.getConfiguration('leidong-tools');
            const delay = config.get<number>('hoverDelay', 300);

            // 设置延迟
            this.hoverTimeout = setTimeout(() => {
                if (token.isCancellationRequested) {
                    resolve(null);
                    return;
                }

                const hover = this.getHoverContent(document, position);
                resolve(hover);
            }, delay);
        });
    }

    private getHoverContent(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
        // 检查功能是否启用
        const config = vscode.workspace.getConfiguration('leidong-tools');
        const isEnabled = config.get<boolean>('enableDefinitionJump', true);
        if (!isEnabled) {
            return null;
        }

        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);
        const line = document.lineAt(position.line).text;

        // 检查是否在模板中
        if (document.languageId === 'html') {
            const templateVar = findTemplateVar(document, position, word);
            if (templateVar) {
                return new vscode.Hover(`**Template Variable**: ${word}\n\nDefined at line ${templateVar.range.start.line + 1}`, wordRange);
            }

            // 检查Vue索引
            const vueIndex = resolveVueIndexForHtml(document);
            if (vueIndex) {
                const def = findDefinitionInIndex(word, vueIndex);
                if (def) {
                    return new vscode.Hover(`**Vue Variable**: ${word}\n\nDefined at ${def.uri.fsPath}:${def.range.start.line + 1}`, wordRange);
                }
            }
        }

        // 检查JavaScript/TypeScript
        if (document.languageId === 'javascript' || document.languageId === 'typescript') {
            const vueIndex = resolveVueIndexForHtml(document);
            if (vueIndex) {
                const def = findDefinitionInIndex(word, vueIndex);
                if (def) {
                    return new vscode.Hover(`**Vue Variable**: ${word}\n\nDefined at ${def.uri.fsPath}:${def.range.start.line + 1}`, wordRange);
                }
            }
        }

        return null;
    }
}
