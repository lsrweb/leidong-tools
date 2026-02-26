import * as vscode from 'vscode';
import { resolveVueIndexForHtml, findDefinitionInIndex, getOrCreateVueIndexFromContent, getExternalDevScriptPathsForHtml } from '../parsers/parseDocument';
import type { VueIndex } from '../parsers/parseDocument';
import { findTemplateVar } from '../finders/templateIndexer';
import { getXTemplateIdAtPosition } from '../helpers/templateContext';
import { jsSymbolParser } from '../parsers/jsSymbolParser';
import { getTemplateLiteralAtPosition } from '../helpers/templateLiteralHelper';
import { getRefCountAtLine } from './codeLensProvider';
import * as path from 'path';
import * as fs from 'fs';

export class VueHoverProvider implements vscode.HoverProvider {
    private hoverTimeout: NodeJS.Timeout | null = null;

    provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | null> {
        return new Promise((resolve) => {
            // 清除之前的定时器
            if (this.hoverTimeout) {
                clearTimeout(this.hoverTimeout);
                this.hoverTimeout = null;
            }

            // 如果已取消，直接返回
            if (token.isCancellationRequested) {
                resolve(null);
                return;
            }

            // 读取配置的延迟时间
            const config = vscode.workspace.getConfiguration('leidong-tools');
            const delay = config.get<number>('hoverDelay', 300);

            // 设置延迟
            this.hoverTimeout = setTimeout(async () => {
                this.hoverTimeout = null;
                if (token.isCancellationRequested) {
                    resolve(null);
                    return;
                }

                const hover = await this.getHoverContent(document, position);
                resolve(hover);
            }, delay);

            // 监听取消事件，避免不必要的计算
            token.onCancellationRequested(() => {
                if (this.hoverTimeout) {
                    clearTimeout(this.hoverTimeout);
                    this.hoverTimeout = null;
                }
                resolve(null);
            });
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
            // 类型推断信息
            if (isData && dataMeta) {
                const typeParts: string[] = [];
                if (dataMeta.initType) { typeParts.push(`Type: \`${dataMeta.initType}\``); }
                if (dataMeta.initValue) { typeParts.push(`Init: \`${dataMeta.initValue}\``); }
                if (typeParts.length > 0) { parts.push(typeParts.join(' | ')); }
            }
            const doc = meta?.doc || dataMeta?.doc || propMeta?.doc;
            if (doc) {
                parts.push(doc);
            }
            // hover 模式引用计数
            const refInfo = getRefCountAtLine(document, def.range.start.line);
            if (refInfo) {
                const refLabel = refInfo.count > 0 ? `📊 引用 ${refInfo.count} 次` : '📊 未引用';
                parts.push(refLabel);
            }
            parts.push(`Defined at ${def.uri.fsPath}:${def.range.start.line + 1}`);
            return new vscode.Hover(new vscode.MarkdownString(parts.join('\n\n')), wordRange);
        };

        // 检查是否在模板中
        if (document.languageId === 'html') {
            const templateVar = findTemplateVar(document, position, word);
            if (templateVar) {
                // 尝试推断 v-for 循环变量的类型
                const inferredType = this.inferTemplateVarType(document, position, word);
                const parts = [`**Template Variable**: ${word}`, `Scope: \`local\``];
                if (inferredType) { parts.push(inferredType); }
                parts.push(`Defined at line ${templateVar.range.start.line + 1}`);
                return new vscode.Hover(new vscode.MarkdownString(parts.join('\n\n')), wordRange);
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

            // JS 文件：先用 getOrCreateVueIndexFromContent 解析当前文件
            let jsVueIndex: VueIndex | null = null;
            try {
                jsVueIndex = getOrCreateVueIndexFromContent(document.getText(), document.uri, 0);
            } catch { /* ignore parse errors */ }

            // 回退：VueIndex 为空时通过关联 HTML 间接获取
            if (jsVueIndex && jsVueIndex.data.size === 0 && jsVueIndex.methods.size === 0
                && jsVueIndex.computed.size === 0 && jsVueIndex.mixinData.size === 0
                && jsVueIndex.mixinMethods.size === 0) {
                jsVueIndex = this.resolveVueIndexForJsViaHtml(document) || jsVueIndex;
            }

            if (jsVueIndex) {
                const def = findDefinitionInIndex(word, jsVueIndex);
                if (def) {
                    const hover = buildVueHover(def, jsVueIndex);
                    if (hover) { return hover; }
                }
            }
        }

        return null;
    }

    /**
     * 推断模板局部变量类型（v-for 迭代变量）
     * 例如 v-for="item in userList" → 查找 userList 的 dataMeta.initType
     */
    private inferTemplateVarType(document: vscode.TextDocument, position: vscode.Position, word: string): string | null {
        // 向上搜索找到定义该变量的 v-for
        const maxScanLines = 30;
        const startLine = Math.max(0, position.line - maxScanLines);
        for (let line = position.line; line >= startLine; line--) {
            const lineText = document.lineAt(line).text;
            // v-for="item in list" / v-for="(item, index) in list" / v-for="item of list"
            const vforMatch = /v-for\s*=\s*["'](?:\(?\s*(\w+)(?:\s*,\s*\w+)*\s*\)?\s+(?:in|of)\s+(\w[\w.]*))\s*["']/.exec(lineText);
            if (vforMatch) {
                const iterVar = vforMatch[1];
                const sourceVar = vforMatch[2];
                if (iterVar === word && sourceVar) {
                    // 查找 sourceVar 的类型
                    const vueIndex = resolveVueIndexForHtml(document);
                    if (vueIndex) {
                        const meta = vueIndex.dataMeta.get(sourceVar);
                        if (meta?.initType) {
                            const elementType = meta.initType.replace(/^Array<(.*)>$/, '$1').replace(/^Array$/, 'unknown');
                            return `Iterating \`${sourceVar}\`: \`${meta.initType}\`\n\nElement type: \`${elementType}\`${meta.initValue ? `\n\nInit: \`${meta.initValue}\`` : ''}`;
                        }
                        // 即使没有类型推断也显示来源
                        if (vueIndex.data.has(sourceVar)) {
                            return `Iterating \`${sourceVar}\` (data)`;
                        }
                        if (vueIndex.computed.has(sourceVar)) {
                            return `Iterating \`${sourceVar}\` (computed)`;
                        }
                    }
                }
            }
        }
        return null;
    }

    /**
     * 通过关联 HTML 文件间接获取 JS 文件的 VueIndex
     */
    private resolveVueIndexForJsViaHtml(document: vscode.TextDocument): VueIndex | null {
        const jsPath = document.uri.fsPath;
        const normalizedJs = path.normalize(jsPath).toLowerCase();

        // 方法 1：扫描已打开的 HTML 文档
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.languageId === 'html' && !doc.isClosed) {
                try {
                    const scriptPaths = getExternalDevScriptPathsForHtml(doc);
                    for (const sp of scriptPaths) {
                        if (path.normalize(sp).toLowerCase() === normalizedJs) {
                            const htmlIndex = resolveVueIndexForHtml(doc);
                            if (htmlIndex && (htmlIndex.data.size > 0 || htmlIndex.methods.size > 0 || htmlIndex.computed.size > 0)) {
                                return htmlIndex;
                            }
                        }
                    }
                } catch { /* ignore */ }
            }
        }

        // 方法 2：目录约定
        const dir = path.dirname(jsPath);
        const parentDir = path.dirname(dir);
        const baseName = path.basename(jsPath).replace(/\.dev\.js$/, '').replace(/\.js$/, '');
        const candidates = [
            path.join(parentDir, `${baseName}.html`),
            path.join(parentDir, 'index.html'),
        ];
        for (const htmlPath of candidates) {
            if (fs.existsSync(htmlPath)) {
                const openDoc = vscode.workspace.textDocuments.find(
                    d => path.normalize(d.uri.fsPath).toLowerCase() === path.normalize(htmlPath).toLowerCase() && !d.isClosed
                );
                if (openDoc) {
                    try {
                        const htmlIndex = resolveVueIndexForHtml(openDoc);
                        if (htmlIndex && (htmlIndex.data.size > 0 || htmlIndex.methods.size > 0 || htmlIndex.computed.size > 0)) {
                            return htmlIndex;
                        }
                    } catch { /* ignore */ }
                }
            }
        }
        return null;
    }
}
