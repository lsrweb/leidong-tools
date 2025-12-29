import * as vscode from 'vscode';
import { resolveVueIndexForHtml, findDefinitionInIndex } from '../parsers/parseDocument';
import { findTemplateVar } from '../finders/templateIndexer';
import { getXTemplateIdAtPosition } from '../helpers/templateContext';

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

        const buildVueHover = (def: vscode.Location, vueIndex: ReturnType<typeof resolveVueIndexForHtml>) => {
            if (!vueIndex) { return null; }
            const methodMeta = vueIndex.methodMeta.get(word);
            const computedMeta = vueIndex.computedMeta.get(word);
            const isMethod = vueIndex.methods.has(word) || vueIndex.mixinMethods.has(word) || !!methodMeta;
            const isComputed = vueIndex.computed.has(word) || vueIndex.mixinComputed.has(word) || !!computedMeta;
            const label = isMethod ? 'Vue Method' : isComputed ? 'Vue Computed' : 'Vue Variable';
            const meta = methodMeta || computedMeta;
            const params = meta?.params?.length ? `(${meta.params.join(', ')})` : isMethod ? '()' : '';
            const header = `**${label}**: ${word}${params}`;
            const parts: string[] = [header];
            if (meta?.doc) {
                parts.push(meta.doc);
            }
            parts.push(`Defined at ${def.uri.fsPath}:${def.range.start.line + 1}`);
            return new vscode.Hover(new vscode.MarkdownString(parts.join('\n\n')), wordRange);
        };

        // 检查是否在模板中
        if (document.languageId === 'html') {
            const templateVar = findTemplateVar(document, position, word);
            if (templateVar) {
                return new vscode.Hover(new vscode.MarkdownString(`**Template Variable**: ${word}\n\nDefined at line ${templateVar.range.start.line + 1}`), wordRange);
            }

            // 检查Vue索引
            let vueIndex = resolveVueIndexForHtml(document);
            const templateId = getXTemplateIdAtPosition(document, position);
            if (templateId && vueIndex?.componentsByTemplateId?.has(templateId)) {
                vueIndex = vueIndex.componentsByTemplateId.get(templateId)!;
            }
            if (vueIndex) {
                const def = findDefinitionInIndex(word, vueIndex);
                if (def) {
                    const hover = buildVueHover(def, vueIndex);
                    if (hover) { return hover; }
                }
            }
        }

        // 检查JavaScript/TypeScript
        if (document.languageId === 'javascript' || document.languageId === 'typescript') {
            const vueIndex = resolveVueIndexForHtml(document);
            if (vueIndex) {
                const def = findDefinitionInIndex(word, vueIndex);
                if (def) {
                    const hover = buildVueHover(def, vueIndex);
                    if (hover) { return hover; }
                }
            }
        }

        return null;
    }
}
