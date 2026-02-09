import * as vscode from 'vscode';
import { resolveVueIndexForHtml, findDefinitionInIndex, getOrCreateVueIndexFromContent } from '../parsers/parseDocument';
import { findTemplateVar } from '../finders/templateIndexer';
import { getXTemplateIdAtPosition } from '../helpers/templateContext';
import { jsSymbolParser } from '../parsers/jsSymbolParser';
import { getTemplateLiteralAtPosition } from '../helpers/templateLiteralHelper';

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
            this.hoverTimeout = setTimeout(async () => {
                if (token.isCancellationRequested) {
                    resolve(null);
                    return;
                }

                const hover = await this.getHoverContent(document, position);
                resolve(hover);
            }, delay);
        });
    }

    private async getHoverContent(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | null> {
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
            const dataMeta = vueIndex.dataMeta.get(word);
            const propMeta = vueIndex.propsMeta?.get(word);
            const watchMetaItem = vueIndex.watchMeta?.get(word);
            const filterMeta = vueIndex.filtersMeta?.get(word);
            const isMethod = vueIndex.methods.has(word);
            const isComputed = vueIndex.computed.has(word);
            const isData = vueIndex.data.has(word);
            const isProp = vueIndex.props?.has(word) ?? false;
            const isWatch = vueIndex.watch?.has(word) ?? false;
            const isFilter = vueIndex.filters?.has(word) ?? false;
            const isLifecycle = vueIndex.lifecycle?.has(word) ?? false;
            const isMixin = vueIndex.mixinMethods.has(word) || vueIndex.mixinComputed.has(word) || vueIndex.mixinData.has(word);
            const label = isProp ? 'Vue Prop' : isMethod ? 'Vue Method' : isComputed ? 'Vue Computed' : isData ? 'Vue Data' : isFilter ? 'Vue Filter' : isWatch ? 'Vue Watch' : isLifecycle ? 'Vue Lifecycle' : isMixin ? 'Vue Mixin' : 'Vue Variable';
            const meta = methodMeta || computedMeta || filterMeta;
            const params = meta?.params?.length ? `(${meta.params.join(', ')})` : isMethod || isFilter ? '()' : '';
            const header = `**${label}**: ${word}${params}`;
            const scopeLabel = isProp ? 'prop' : isMethod ? 'method' : isComputed ? 'computed' : isData ? 'data' : isFilter ? 'filter' : isWatch ? 'watch' : isLifecycle ? 'lifecycle' : isMixin ? 'mixin' : 'variable';
            const parts: string[] = [header];
            parts.push(`Scope: \`${scopeLabel}\``);
            if (isProp && propMeta) {
                const propParts: string[] = [];
                if (propMeta.type) { propParts.push(`Type: \`${propMeta.type}\``); }
                if (propMeta.default !== undefined) { propParts.push(`Default: \`${propMeta.default}\``); }
                if (propMeta.required) { propParts.push(`Required: \`true\``); }
                if (propParts.length > 0) { parts.push(propParts.join(' | ')); }
            }
            if (isWatch && watchMetaItem) {
                const watchParts: string[] = [];
                if (watchMetaItem.deep) { watchParts.push(`Deep: \`true\``); }
                if (watchMetaItem.immediate) { watchParts.push(`Immediate: \`true\``); }
                if (watchMetaItem.handler) { watchParts.push(`Handler: \`${watchMetaItem.handler}\``); }
                if (watchParts.length > 0) { parts.push(watchParts.join(' | ')); }
            }
            // 如果一个 data 属性被 watch，额外标注
            if (isData && vueIndex.watch?.has(word)) {
                parts.push(`👁️ Watched`);
            }
            const doc = meta?.doc || dataMeta?.doc || propMeta?.doc;
            if (doc) {
                parts.push(doc);
            }
            parts.push(`Defined at ${def.uri.fsPath}:${def.range.start.line + 1}`);
            return new vscode.Hover(new vscode.MarkdownString(parts.join('\n\n')), wordRange);
        };

        // 检查是否在模板中
        if (document.languageId === 'html') {
            const templateVar = findTemplateVar(document, position, word);
            if (templateVar) {
                return new vscode.Hover(new vscode.MarkdownString(`**Template Variable**: ${word}\n\nScope: \`local\`\n\nDefined at line ${templateVar.range.start.line + 1}`), wordRange);
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
            // 检测是否在 template: `...` 模板字符串内
            const templateInfo = getTemplateLiteralAtPosition(document, position);
            if (templateInfo) {
                // 在模板字符串内，使用 Vue 索引提供悬停信息
                const content = document.getText();
                const vueIndex = getOrCreateVueIndexFromContent(content, document.uri, 0);
                if (vueIndex) {
                    const def = findDefinitionInIndex(word, vueIndex);
                    if (def) {
                        const hover = buildVueHover(def, vueIndex);
                        if (hover) { return hover; }
                    }
                }
            }

            const localSymbol = await jsSymbolParser.findLocalSymbol(document, position, word);
            if (localSymbol) {
                return new vscode.Hover(
                    new vscode.MarkdownString(`**Local Symbol**: ${word}\n\nScope: \`local\`\n\nDefined at ${document.uri.fsPath}:${localSymbol.range.start.line + 1}`),
                    wordRange
                );
            }
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
