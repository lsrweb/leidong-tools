/**
 * 自动补全提供器
 * 
 * 参考实现: https://github.com/jaluik/dot-log
 * 使用 resolveCompletionItem + command 模式实现变量.log补全
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { CacheItem } from '../types';
import { parseDocument, resolveVueIndexForHtml, getExternalDevScriptPathsForHtml, getOrCreateVueIndexFromContent } from '../parsers/parseDocument';
import type { VueIndex } from '../parsers/parseDocument';
import { getXTemplateIdAtPosition } from '../helpers/templateContext';
import { inferObjectProperties } from '../helpers/propertyInference';
import { getTemplateLiteralAtPosition, isVueTemplateContext } from '../helpers/templateLiteralHelper';
import { getTemplateRefs } from '../finders/templateIndexer';
import * as fs from 'fs';

/**
 * 日志配置项接口
 */
interface LogConfigItem {
    trigger: string;       // 触发关键字，例如 "log", "err"
    description: string;   // 描述信息
    format: string;        // 日志格式，例如 "console.log"
    icon: string;          // 图标
    hideName?: boolean;    // 是否隐藏变量名（仅输出值）
}

/**
 * 快速日志补全提供器 (重写版)
 * 参考 jaluik/dot-log 实现，使用命令替换文本
 */
export class QuickLogCompletionProvider implements vscode.CompletionItemProvider {
    private position?: vscode.Position;
    private readonly configs: LogConfigItem[] = [
        {
            trigger: 'log',
            description: '🔥 Quick console.log with file info',
            format: 'console.log',
            icon: '🔥'
        },
        {
            trigger: 'err',
            description: '❌ Quick console.error with file info',
            format: 'console.error',
            icon: '❌'
        },
        {
            trigger: 'info',
            description: 'ℹ️ Quick console.info with file info',
            format: 'console.info',
            icon: 'ℹ️'
        },
        {
            trigger: 'dbg',
            description: '🐛 Quick console.debug with file info',
            format: 'console.debug',
            icon: '🐛'
        },
        {
            trigger: 'warn',
            description: '⚠️ Quick console.warn with file info',
            format: 'console.warn',
            icon: '⚠️'
        }
    ];

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        this.position = position;

        const linePrefix = document.lineAt(position).text.substring(0, position.character);
        const matchedTrigger = /(?:^|[^\w$])[^\s'"`]+\.([leidw])$/.exec(linePrefix)?.[1];
        if (!matchedTrigger) { return []; }

        const matchedConfig = this.configs.find((config) => config.trigger[0] === matchedTrigger);
        if (!matchedConfig) { return []; }

        const item = new vscode.CompletionItem(
            matchedConfig.trigger,
                vscode.CompletionItemKind.Method
        );
        item.detail = matchedConfig.description;
        item.documentation = new vscode.MarkdownString(matchedConfig.description);
        item.sortText = '0000'; // 最高优先级，但只在命中命令前缀时出现
        item.preselect = true;
        return [item];
    }

    resolveCompletionItem(
        item: vscode.CompletionItem,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CompletionItem> {
        const label = item.label;
        if (this.position && typeof label === 'string') {
            const config = this.configs.find((c) => c.trigger === label);
            if (config) {
                // 设置命令，触发文本替换
                item.command = {
                    command: 'leidong-tools.dotLogReplace',
                    title: 'Replace with log statement',
                    arguments: [this.position.translate(0, label.length + 1), config]
                };
            }
        }
        return item;
    }
}

/**
 * JavaScript 变量与函数补全提供器
 */
export class JavaScriptCompletionProvider implements vscode.CompletionItemProvider {
    // 存储解析结果的缓存
    private parseCache = new Map<string, CacheItem>();
    private propertyCache = new Map<string, { items: vscode.CompletionItem[]; updatedAt: number; docVersion: number }>();

    // 缓存有效期 (30秒)
    private cacheValidityPeriod = 30 * 1000;
    private propertyCacheTtlMs = 1500;

    private static readonly COMMON_HTML_TAGS = [
        'div', 'span', 'p', 'section', 'article', 'header', 'footer', 'main',
        'aside', 'nav', 'ul', 'ol', 'li', 'a', 'img', 'button', 'input',
        'textarea', 'select', 'option', 'label', 'form', 'template', 'slot'
    ];

    private static readonly COMMON_HTML_ATTRIBUTES = [
        'class', 'id', 'style', 'src', 'href', 'alt', 'title', 'type', 'value',
        'name', 'placeholder', 'disabled', 'readonly', 'checked', 'required',
        'rel', 'for', 'target', 'role', 'aria-label', 'aria-hidden'
    ];

    private static readonly COMMON_CSS_PROPERTIES = [
        'display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height',
        'margin', 'padding', 'color', 'background', 'background-color', 'font-size',
        'font-weight', 'line-height', 'text-align', 'justify-content', 'align-items',
        'gap', 'flex', 'flex-direction', 'flex-wrap', 'border', 'border-radius',
        'overflow', 'opacity', 'z-index', 'box-shadow', 'cursor'
    ];

    private static readonly COMMON_CSS_AT_RULES = [
        '@media', '@supports', '@keyframes', '@import', '@font-face', '@charset', '@page'
    ];

    private static readonly CSS_VALUE_MAP: Record<string, string[]> = {
        display: ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'none'],
        position: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
        'flex-direction': ['row', 'row-reverse', 'column', 'column-reverse'],
        'justify-content': ['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly'],
        'align-items': ['stretch', 'flex-start', 'flex-end', 'center', 'baseline'],
        'text-align': ['left', 'right', 'center', 'justify'],
        overflow: ['visible', 'hidden', 'scroll', 'auto'],
        cursor: ['default', 'pointer', 'text', 'move', 'not-allowed', 'grab'],
        'white-space': ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line'],
        'object-fit': ['fill', 'contain', 'cover', 'none', 'scale-down'],
        'font-weight': ['normal', 'bold', 'bolder', 'lighter', '100', '200', '300', '400', '500', '600', '700', '800', '900']
    };

    // 提供自动完成项目
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList> {
        try {
            if (token.isCancellationRequested) { return []; }
            // 检测是否在 template: `...` 模板字符串内
            const templateInfo = getTemplateLiteralAtPosition(document, position);
            if (templateInfo) {
                const linePrefix = document.lineAt(position).text.substring(0, position.character);
                if (this.isCssTemplateContext(templateInfo, linePrefix)) {
                    const cssItems = this.provideTemplateLiteralCssCompletions(linePrefix, templateInfo.content);
                    if (cssItems.length > 0) {
                        return new vscode.CompletionList(cssItems, false);
                    }
                }

                if (isVueTemplateContext(linePrefix)) {
                    return this.provideTemplateLiteralCompletions(document) || [];
                }

                const htmlItems = this.provideTemplateLiteralHtmlCompletions(document, linePrefix);
                if (htmlItems.length > 0) {
                    return new vscode.CompletionList(htmlItems, false);
                }

                // 模板字符串内没有匹配到更具体的上下文时，不拦截后续补全
                return [];
            }

            // 检查触发自动完成的字符
            const linePrefix = document.lineAt(position).text.substring(0, position.character);

            // 只在扩展真正能提供增量价值的上下文里参与补全。
            // 普通的 foo. / obj. 场景直接交给 VS Code 原生 JS/TS 语言服务，避免我们抢主线程。
            const aliasRootPattern = /(?:this|that|_this|self|_self|vm|_vm|me|ctx|app|this_)\.$/;
            const aliasPropertyPattern = /(?:this|that|_this|self|_self|vm|_vm|me|ctx|app|this_)\.[a-zA-Z_$][\w$]*\.$/;
            const refsPattern = /(?:this|that|_this|self|_self|vm|_vm|me|ctx|app|this_)\.\$refs\.\s*$/;
            const emitPattern = /(?:this|that|_this|self|_self|vm|_vm|me|ctx|app|this_)\.\$emit\(\s*['"]$/;

            if (linePrefix.endsWith('.')
                && !aliasRootPattern.test(linePrefix)
                && !aliasPropertyPattern.test(linePrefix)
                && !refsPattern.test(linePrefix)
                && !emitPattern.test(linePrefix)) {
                return [];
            }

            // $refs 补全：this.$refs. / that.$refs. / _this.$refs. 等
            if (refsPattern.test(linePrefix)) {
                return this.provideRefsCompletions();
            }

            // $emit 事件名补全：this.$emit(' / that.$emit(' 等
            if (emitPattern.test(linePrefix)) {
                return this.provideEmitEventCompletions(document);
            }

            const objectContext = aliasPropertyPattern.test(linePrefix) ? this.getObjectPropertyContext(linePrefix) : null;
            if (objectContext) {
                const inferredItems = this.getInferredPropertyItems(document, objectContext.root);
                if (inferredItems.length > 0) {
                    return new vscode.CompletionList(inferredItems, false);
                }
                return [];
            }
            
            // 判断当前作用域
            const isThisContext = this.isInThisContext(linePrefix);
            const isThatContext = this.isInThatContext(linePrefix);
            
            // 获取当前文件的解析缓存或重新解析
            let parseResult = this.getCachedParseResult(document);
            if (!parseResult) {
                parseResult = await parseDocument(document);
                if (parseResult) {
                    this.cacheParseResult(document, parseResult);
                }
            }
            
            // 确保 parseResult 不为 null
            if (!parseResult) {
                return [];
            }
            
            let completionItems: vscode.CompletionItem[];
            
            // 根据当前上下文返回不同的补全项
            if (isThisContext) {
                // 返回 this. 相关的补全项
                completionItems = Array.from(parseResult.thisReferences.values());
            } else if (isThatContext) {
                // that 通常是 this 的别名，也返回 this 相关的补全项
                completionItems = Array.from(parseResult.thisReferences.values());
            } else {
                // 返回所有变量和方法
                completionItems = [...parseResult.variables, ...parseResult.methods];
            }
            
            // 提高所有补全项的优先级以与内置单词记录竞争
            completionItems.forEach((item, index) => {
                item.sortText = `0000${index.toString().padStart(4, '0')}`; // 确保高优先级排序
                item.preselect = false; // 避免过度预选
                // 添加标识符表明这是来自我们的扩展
                if (!item.detail?.includes('(雷动三千)')) {
                    item.detail = `${item.detail || ''} (雷动三千)`;
                }
            });
            
            // 返回 CompletionList 以获得更好的控制
            return new vscode.CompletionList(completionItems, false);
        } catch (error) {
            console.error('[JS Completion] Error providing completions:', error);
            return [];
        }
    }

    // $refs 补全：扫描所有打开的 HTML 文件中的 ref 属性
    private provideRefsCompletions(): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];
        // 扫描所有可见编辑器中的 HTML 文件
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.languageId === 'html') {
                const refs = getTemplateRefs(editor.document);
                refs.forEach((_loc, refName) => {
                    const item = new vscode.CompletionItem(refName, vscode.CompletionItemKind.Reference);
                    item.detail = `ref="${refName}" (雷动三千)`;
                    item.sortText = '0000';
                    items.push(item);
                });
            }
        }
        return new vscode.CompletionList(items, false);
    }

    // $emit 事件名补全：从当前文件索引中获取已有的 $emit 事件
    private provideEmitEventCompletions(document: vscode.TextDocument): vscode.CompletionList {
        const items: vscode.CompletionItem[] = [];
        const content = document.getText();
        const index = getOrCreateVueIndexFromContent(content, document.uri, 0);
        if (index && index.emits.size > 0) {
            index.emits.forEach((_loc, eventName) => {
                const item = new vscode.CompletionItem(eventName, vscode.CompletionItemKind.Event);
                item.detail = `event "${eventName}" (雷动三千)`;
                item.sortText = '0000';
                items.push(item);
            });
        }
        return new vscode.CompletionList(items, false);
    }

    // 常见 this 别名
    private static readonly THIS_ALIAS_PATTERN = /(?:this|that|_this|self|_self|vm|_vm|me|ctx|app|this_|thisObj|instance|inst)\.$/;

    // 判断是否在 this 上下文中
    private isInThisContext(linePrefix: string): boolean {
        return linePrefix.endsWith('this.');
    }

    // 判断是否在 that 或其他 this 别名上下文中
    private isInThatContext(linePrefix: string): boolean {
        return !linePrefix.endsWith('this.') && JavaScriptCompletionProvider.THIS_ALIAS_PATTERN.test(linePrefix);
    }

    private getObjectPropertyContext(linePrefix: string): { root: string } | null {
        const match = /((?:this|that)\.)?([a-zA-Z_$][\w$]*)\.$/.exec(linePrefix);
        if (!match) { return null; }
        return { root: match[2] };
    }

    private getInferredPropertyItems(document: vscode.TextDocument, root: string): vscode.CompletionItem[] {
        const cacheKey = `${document.uri.toString()}:${root}`;
        const cached = this.propertyCache.get(cacheKey);
        if (cached && (cached.docVersion === document.version || Date.now() - cached.updatedAt < this.propertyCacheTtlMs)) {
            return cached.items;
        }
        const props = inferObjectProperties(document.getText(), root);
        const items = props.map(name => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
            item.detail = 'inferred property (雷动三千)';
            return item;
        });
        this.propertyCache.set(cacheKey, { items, updatedAt: Date.now(), docVersion: document.version });
        return items;
    }

    /**
     * 为 JS 文件中 template: `...` 模板字符串提供 Vue 补全
     */
    private provideTemplateLiteralCompletions(document: vscode.TextDocument): vscode.CompletionList | null {
        try {
            const content = document.getText();
            const index = getOrCreateVueIndexFromContent(content, document.uri, 0);
            if (!index) { return null; }

            const completionItems: vscode.CompletionItem[] = [];

            index.data.forEach((_loc, name) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
                item.detail = 'data 属性 (模板字符串)';
                const dataMeta = index.dataMeta.get(name);
                if (dataMeta?.doc) {
                    item.documentation = new vscode.MarkdownString(dataMeta.doc);
                }
                completionItems.push(item);
            });
            index.methods.forEach((_loc, name) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
                const meta = index.methodMeta.get(name);
                item.detail = meta?.params?.length
                    ? `methods ${name}(${meta.params.join(', ')}) (模板字符串)`
                    : `methods ${name}() (模板字符串)`;
                if (meta?.doc) {
                    item.documentation = new vscode.MarkdownString(meta.doc);
                }
                completionItems.push(item);
            });
            index.computed.forEach((_loc, name) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
                const meta = index.computedMeta.get(name);
                item.detail = `computed ${name} (模板字符串)`;
                if (meta?.doc) {
                    item.documentation = new vscode.MarkdownString(meta.doc);
                }
                completionItems.push(item);
            });
            index.props.forEach((_loc, name) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
                const meta = index.propsMeta?.get(name);
                const typePart = meta?.type ? `: ${meta.type}` : '';
                item.detail = `prop ${name}${typePart} (模板字符串)`;
                completionItems.push(item);
            });

            completionItems.forEach((item, idx) => {
                item.sortText = `0000${idx.toString().padStart(4, '0')}`;
                if (!item.detail?.includes('(雷动三千)')) {
                    item.detail = `${item.detail || ''} (雷动三千)`;
                }
            });

            return new vscode.CompletionList(completionItems, false);
        } catch (e) {
            console.error('[JS Completion] template literal error:', e);
            return null;
        }
    }

    private provideTemplateLiteralHtmlCompletions(document: vscode.TextDocument, linePrefix: string): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const inTag = linePrefix.lastIndexOf('<') > linePrefix.lastIndexOf('>');
        if (!inTag) { return items; }

        const tagMatch = /<([a-zA-Z0-9-]*)$/.exec(linePrefix);
        const attrMatch = /<[^>]*\s([a-zA-Z0-9-]*)$/.exec(linePrefix);
        const rootIndex = getOrCreateVueIndexFromContent(document.getText(), document.uri, 0);

        if (tagMatch) {
            const prefix = tagMatch[1] || '';
            const candidates = new Set<string>(JavaScriptCompletionProvider.COMMON_HTML_TAGS);
            rootIndex.registeredComponents.forEach((comp) => candidates.add(comp.kebabName));
            Array.from(candidates)
                .filter(name => !prefix || name.startsWith(prefix))
                .sort()
                .forEach((name, idx) => {
                    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
                    item.detail = 'HTML tag (模板字符串)';
                    item.sortText = `0000${idx.toString().padStart(4, '0')}`;
                    items.push(item);
                });
            return items;
        }

        if (attrMatch) {
            const prefix = attrMatch[1] || '';
            const attrCandidates = new Set<string>(JavaScriptCompletionProvider.COMMON_HTML_ATTRIBUTES);
            const vueDirectives = ['v-if', 'v-else-if', 'v-else', 'v-show', 'v-for', 'v-model', 'v-bind', 'v-on', 'v-text', 'v-html', 'v-slot'];
            vueDirectives.forEach(name => attrCandidates.add(name));
            Array.from(attrCandidates)
                .filter(name => !prefix || name.startsWith(prefix))
                .sort()
                .forEach((name, idx) => {
                    const item = new vscode.CompletionItem(name, name.startsWith('v-') ? vscode.CompletionItemKind.Keyword : vscode.CompletionItemKind.Property);
                    item.detail = 'HTML attribute / Vue directive (模板字符串)';
                    item.sortText = `0000${idx.toString().padStart(4, '0')}`;
                    items.push(item);
                });
        }

        return items;
    }

    private isCssTemplateContext(templateInfo: ReturnType<typeof getTemplateLiteralAtPosition>, linePrefix: string): boolean {
        if (templateInfo && (templateInfo.kind === 'backtick-css' || templateInfo.kind === 'string-css')) {
            return true;
        }
        return /(?:style|css|styles|styleText|cssText|styleSheet|styleContent|innerHTML|textContent)(?:\s*\.\s*[a-zA-Z_$][\w$]*)*\s*=\s*`/.test(linePrefix)
            || /style\s*=\s*["'][^"']*$/.test(linePrefix)
            || /cssText\s*=\s*["'][^"']*$/.test(linePrefix);
    }

    private provideTemplateLiteralCssCompletions(linePrefix: string, content: string): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const beforeCursor = linePrefix;
        const indentPrefix = /^\s*/.exec(beforeCursor)?.[0] || '';
        const trimBefore = beforeCursor.trimEnd();

        const propValueMatch = /(?:^|[;{\n])\s*([a-zA-Z-]+)\s*:\s*([^;{}]*)$/.exec(trimBefore);
        if (propValueMatch) {
            const propName = propValueMatch[1].toLowerCase();
            const currentValuePrefix = (propValueMatch[2] || '').trim();
            const values = JavaScriptCompletionProvider.CSS_VALUE_MAP[propName] || [];
            values
                .filter(v => !currentValuePrefix || v.startsWith(currentValuePrefix))
                .forEach((value, idx) => {
                    const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.Value);
                    item.detail = `${propName}: ${value} (CSS 值)`;
                    item.insertText = new vscode.SnippetString(value);
                    item.sortText = `0000${idx.toString().padStart(4, '0')}`;
                    items.push(item);
                });

            // 颜色值兜底
            if (propName.includes('color') || propName === 'background' || propName === 'border') {
                ['#fff', '#ffffff', 'red', 'transparent', 'currentColor'].forEach((value, idx) => {
                    if (currentValuePrefix && !value.startsWith(currentValuePrefix)) { return; }
                    const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.Color);
                    item.detail = '常用颜色值';
                    item.insertText = new vscode.SnippetString(value);
                    item.sortText = `0100${idx.toString().padStart(4, '0')}`;
                    items.push(item);
                });
            }

            return items;
        }

        const atRuleMatch = /(^|[\n;{])\s*(@[a-zA-Z-]*)$/.exec(trimBefore);
        if (atRuleMatch) {
            const prefix = atRuleMatch[2] || '';
            JavaScriptCompletionProvider.COMMON_CSS_AT_RULES
                .filter(rule => !prefix || rule.startsWith(prefix))
                .forEach((rule, idx) => {
                    const item = new vscode.CompletionItem(rule, vscode.CompletionItemKind.Keyword);
                    item.detail = 'CSS at-rule';
                    item.insertText = new vscode.SnippetString(rule + ' ');
                    item.sortText = `0000${idx.toString().padStart(4, '0')}`;
                    items.push(item);
                });
            return items;
        }

        const propertyMatch = /(?:^|[;{\n])\s*([a-zA-Z-]*)$/.exec(trimBefore);
        if (propertyMatch) {
            const prefix = propertyMatch[1] || '';
            JavaScriptCompletionProvider.COMMON_CSS_PROPERTIES
                .filter(name => !prefix || name.startsWith(prefix))
                .sort()
                .forEach((name, idx) => {
                    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
                    item.detail = 'CSS property';
                    item.insertText = new vscode.SnippetString(`${name}: $1;`);
                    item.sortText = `0000${idx.toString().padStart(4, '0')}`;
                    items.push(item);
                });
            return items;
        }

        // 选择器补全：在 CSS 规则开始处给常见选择器
        const selectorMatch = /(^|[\n{;])\s*([.#:]?[a-zA-Z_-][\w-]*)?$/.exec(trimBefore);
        if (selectorMatch) {
            const prefix = selectorMatch[2] || '';
            const selectorItems: Array<{ label: string; kind: vscode.CompletionItemKind; detail: string; insertText?: string }> = [
                { label: 'div', kind: vscode.CompletionItemKind.Class, detail: 'HTML tag selector' },
                { label: 'span', kind: vscode.CompletionItemKind.Class, detail: 'HTML tag selector' },
                { label: '.container', kind: vscode.CompletionItemKind.Class, detail: 'class selector' },
                { label: '.active', kind: vscode.CompletionItemKind.Class, detail: 'class selector' },
                { label: '#app', kind: vscode.CompletionItemKind.Class, detail: 'id selector' },
                { label: ':root', kind: vscode.CompletionItemKind.Keyword, detail: 'root selector' },
                { label: '@media', kind: vscode.CompletionItemKind.Keyword, detail: 'media query' },
                { label: '@supports', kind: vscode.CompletionItemKind.Keyword, detail: 'feature query' },
                { label: '@keyframes', kind: vscode.CompletionItemKind.Keyword, detail: 'animation keyframes' },
            ];
            selectorItems
                .filter(item => !prefix || item.label.startsWith(prefix))
                .forEach((entry, idx) => {
                    const item = new vscode.CompletionItem(entry.label, entry.kind);
                    item.detail = entry.detail;
                    if (entry.label.startsWith('@')) {
                        item.insertText = new vscode.SnippetString(`${entry.label} $1 {\n  $2\n}`);
                    } else if (entry.label.startsWith('.')) {
                        item.insertText = new vscode.SnippetString(`${entry.label} {\n  $1\n}`);
                    } else if (entry.label.startsWith('#')) {
                        item.insertText = new vscode.SnippetString(`${entry.label} {\n  $1\n}`);
                    } else {
                        item.insertText = new vscode.SnippetString(`${entry.label} {\n  $1\n}`);
                    }
                    item.sortText = `0000${idx.toString().padStart(4, '0')}`;
                    items.push(item);
                });
        }

        return items;
    }

    // 获取缓存的解析结果
    private getCachedParseResult(document: vscode.TextDocument) {
        const uri = document.uri.toString();
        const cachedResult = this.parseCache.get(uri);
        
        // 检查缓存是否存在且有效
        if (cachedResult && Date.now() - cachedResult.timestamp < this.cacheValidityPeriod) {
            return cachedResult;
        }
        
        return null;
    }

    // 缓存解析结果
    private cacheParseResult(document: vscode.TextDocument, result: CacheItem) {
        const uri = document.uri.toString();
        this.parseCache.set(uri, result);
        // 限制缓存大小，防止长时间运行后内存膨胀
        if (this.parseCache.size > 50) {
            const oldest = this.parseCache.keys().next().value;
            if (oldest) { this.parseCache.delete(oldest); }
        }
    }
}

/**
 * HTML 模板变量与方法补全提供器
 */
export class HtmlVueCompletionProvider implements vscode.CompletionItemProvider {
    private completionCache = new Map<string, CacheItem>();
    private propertyCache = new Map<string, { items: vscode.CompletionItem[]; updatedAt: number; docVersion: number; scriptMtime?: number }>();
    private propertyCacheTtlMs = 1500;
    private static readonly MAX_COMPLETION_CACHE = 30;
    private static readonly MAX_PROPERTY_CACHE = 30;

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList> {
        if (_token.isCancellationRequested) { return []; }
        const linePrefix = document.lineAt(position).text.substring(0, position.character);

        // 检测 filter 管道上下文：{{ value | 或 {{ value | currency |
        const isPipeContext = /\{\{[^}]*\|\s*[a-zA-Z_$]*$/.test(linePrefix);
        if (isPipeContext) {
            const rootIndex = resolveVueIndexForHtml(document);
            if (rootIndex && rootIndex.filters.size > 0) {
                const filterItems: vscode.CompletionItem[] = [];
                rootIndex.filters.forEach((_loc, name) => {
                    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
                    const fMeta = rootIndex.filtersMeta?.get(name);
                    item.detail = `filter ${name} (雷动三千)`;
                    if (fMeta?.doc) { item.documentation = new vscode.MarkdownString(fMeta.doc); }
                    item.sortText = '0000';
                    filterItems.push(item);
                });
                return new vscode.CompletionList(filterItems, false);
            }
        }

        // 组件标签补全：<xxx 处触发，建议已注册组件的 kebab-case 名称
        const tagMatch = /<([a-zA-Z0-9-]*)$/.exec(linePrefix);
        if (tagMatch) {
            const rootIndex = resolveVueIndexForHtml(document);
            if (rootIndex && rootIndex.registeredComponents.size > 0) {
                const tagItems: vscode.CompletionItem[] = [];
                rootIndex.registeredComponents.forEach((comp) => {
                    const item = new vscode.CompletionItem(comp.kebabName, vscode.CompletionItemKind.Class);
                    item.detail = `component <${comp.kebabName}> (雷动三千)`;
                    if (comp.props.size > 0) {
                        const propsList = Array.from(comp.props.entries()).map(([pn, pm]) => {
                            const typePart = pm.type ? `: ${pm.type}` : '';
                            const reqPart = pm.required ? ' *' : '';
                            return `- \`${pn}${typePart}\`${reqPart}`;
                        }).join('\n');
                        item.documentation = new vscode.MarkdownString(`**Props:**\n${propsList}`);
                    }
                    item.sortText = '0000';
                    tagItems.push(item);
                });
                if (tagItems.length > 0) {
                    return new vscode.CompletionList(tagItems, false);
                }
            }
        }

        // @event 补全：在组件标签上 @xxx 触发，建议组件 $emit 的事件
        const eventAttrMatch = /@([a-zA-Z0-9_-]*)$/.exec(linePrefix);
        if (eventAttrMatch) {
            const rootIndex = resolveVueIndexForHtml(document);
            if (rootIndex && rootIndex.emits.size > 0) {
                const eventItems: vscode.CompletionItem[] = [];
                rootIndex.emits.forEach((_loc, eventName) => {
                    const item = new vscode.CompletionItem(eventName, vscode.CompletionItemKind.Event);
                    item.detail = `event @${eventName} (雷动三千)`;
                    item.sortText = '0000';
                    eventItems.push(item);
                });
                // 也从子组件中收集
                if (rootIndex.componentsByTemplateId) {
                    rootIndex.componentsByTemplateId.forEach((compIndex) => {
                        compIndex.emits.forEach((_loc, eventName) => {
                            if (!eventItems.some(i => (i.label as string) === eventName)) {
                                const item = new vscode.CompletionItem(eventName, vscode.CompletionItemKind.Event);
                                item.detail = `component event @${eventName} (雷动三千)`;
                                item.sortText = '0001';
                                eventItems.push(item);
                            }
                        });
                    });
                }
                if (eventItems.length > 0) {
                    return new vscode.CompletionList(eventItems, false);
                }
            }
        }

        // Vue 指令智能补全：v-for="item in " / v-model=" / v-if=" / v-show=" 等
        const directiveItems = this.getDirectiveContextCompletions(document, position, linePrefix);
        if (directiveItems && directiveItems.length > 0) {
            return new vscode.CompletionList(directiveItems, false);
        }

        // v- 指令名称补全：在标签属性位置输入 v- 时建议常用指令
        const vDirectiveNameMatch = /\sv-([\w-]*)$/.exec(linePrefix);
        if (vDirectiveNameMatch) {
            const inTag = linePrefix.lastIndexOf('<') > linePrefix.lastIndexOf('>');
            if (inTag) {
                return new vscode.CompletionList(this.getDirectiveNameCompletions(), false);
            }
        }

        if (!this.isTemplateContext(linePrefix)) {
            return [];
        }

        const objectContext = this.getObjectPropertyContext(linePrefix);
        if (objectContext) {
            const inferredItems = this.getInferredPropertyItems(document, objectContext.root);
            if (inferredItems.length > 0) {
                return new vscode.CompletionList(inferredItems, false);
            }
            return [];
        }

        const rootIndex = resolveVueIndexForHtml(document);
        if (!rootIndex) { return []; }

        const templateId = getXTemplateIdAtPosition(document, position);
        const targetIndex = templateId && rootIndex.componentsByTemplateId?.has(templateId)
            ? rootIndex.componentsByTemplateId.get(templateId)!
            : rootIndex;

        const cacheKey = `${targetIndex.hash}:${templateId || 'root'}`;
        let cached = this.completionCache.get(cacheKey);
        if (!cached) {
            cached = this.buildCompletionItems(targetIndex);
            this.completionCache.set(cacheKey, cached);
            // 限制缓存大小
            if (this.completionCache.size > HtmlVueCompletionProvider.MAX_COMPLETION_CACHE) {
                const oldest = this.completionCache.keys().next().value;
                if (oldest) { this.completionCache.delete(oldest); }
            }
        }

        const completionItems = [...cached.variables, ...cached.methods];
        completionItems.forEach((item, index) => {
            item.sortText = `0000${index.toString().padStart(4, '0')}`;
            item.preselect = false;
            if (!item.detail?.includes('(雷动三千)')) {
                item.detail = `${item.detail || ''} (雷动三千)`;
            }
        });

        return new vscode.CompletionList(completionItems, false);
    }

    private buildCompletionItems(index: VueIndex): CacheItem {
        const variables: vscode.CompletionItem[] = [];
        const methods: vscode.CompletionItem[] = [];
        const thisReferences: Map<string, vscode.CompletionItem> = new Map();
        const applyFunctionMeta = (
            item: vscode.CompletionItem,
            name: string,
            typeLabel: string,
            metaMap: Map<string, { params: string[]; doc?: string }>
        ) => {
            const meta = metaMap.get(name);
            if (meta && meta.params.length > 0) {
                item.detail = `${typeLabel} ${name}(${meta.params.join(', ')})`;
            } else {
                item.detail = `${typeLabel} ${name}()`;
            }
            if (meta?.doc) {
                item.documentation = new vscode.MarkdownString(meta.doc);
            }
        };

        index.data.forEach((_loc, name) => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
            item.detail = 'data 属性 (雷动三千)';
            const dataMeta = index.dataMeta.get(name);
            if (dataMeta?.doc) {
                item.documentation = new vscode.MarkdownString(dataMeta.doc);
            }
            variables.push(item);
            thisReferences.set(name, item);
        });
        index.methods.forEach((_loc, name) => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
            applyFunctionMeta(item, name, 'methods', index.methodMeta);
            methods.push(item);
            thisReferences.set(name, item);
        });
        index.computed.forEach((_loc, name) => {
            if (!thisReferences.has(name)) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
                applyFunctionMeta(item, name, 'computed', index.computedMeta);
                variables.push(item);
                thisReferences.set(name, item);
            }
        });
        index.mixinData.forEach((_loc, name) => {
            if (!thisReferences.has(name)) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
                item.detail = 'mixin data (雷动三千)';
                const dataMeta = index.dataMeta.get(name);
                if (dataMeta?.doc) {
                    item.documentation = new vscode.MarkdownString(dataMeta.doc);
                }
                variables.push(item);
                thisReferences.set(name, item);
            }
        });
        index.mixinComputed.forEach((_loc, name) => {
            if (!thisReferences.has(name)) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
                applyFunctionMeta(item, name, 'mixin computed', index.computedMeta);
                variables.push(item);
                thisReferences.set(name, item);
            }
        });
        index.mixinMethods.forEach((_loc, name) => {
            if (!thisReferences.has(name)) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
                applyFunctionMeta(item, name, 'mixin method', index.methodMeta);
                methods.push(item);
                thisReferences.set(name, item);
            }
        });
        // filters
        index.filters.forEach((_loc, name) => {
            if (!thisReferences.has(name)) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
                const fMeta = index.filtersMeta?.get(name);
                if (fMeta?.params?.length) {
                    item.detail = `filter ${name}(${fMeta.params.join(', ')}) (雷动三千)`;
                } else {
                    item.detail = `filter ${name}() (雷动三千)`;
                }
                if (fMeta?.doc) { item.documentation = new vscode.MarkdownString(fMeta.doc); }
                methods.push(item);
                thisReferences.set(name, item);
            }
        });

        return { variables, methods, timestamp: Date.now(), thisReferences };
    }

    /**
     * Vue 指令上下文智能补全：根据指令类型提供不同的建议
     */
    private getDirectiveContextCompletions(
        document: vscode.TextDocument,
        position: vscode.Position,
        linePrefix: string
    ): vscode.CompletionItem[] | null {
        const rootIndex = resolveVueIndexForHtml(document);
        if (!rootIndex) { return null; }

        const templateId = getXTemplateIdAtPosition(document, position);
        const targetIndex = templateId && rootIndex.componentsByTemplateId?.has(templateId)
            ? rootIndex.componentsByTemplateId.get(templateId)!
            : rootIndex;

        // v-for="item in " → 建议数组类型的 data 属性
        const vForInMatch = /v-for\s*=\s*["'][^"']*\s+(?:in|of)\s+([a-zA-Z_$][\w$]*)?$/.exec(linePrefix);
        if (vForInMatch) {
            const items: vscode.CompletionItem[] = [];
            let sortIdx = 0;
            // 优先推荐数组类型
            targetIndex.data.forEach((_loc, name) => {
                const meta = targetIndex.dataMeta?.get(name);
                const isArray = meta?.initType?.startsWith('Array');
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
                item.detail = `${isArray ? '📋 Array' : 'data'} ${name} (雷动三千)`;
                if (meta?.initType) {
                    item.documentation = new vscode.MarkdownString(`**类型:** \`${meta.initType}\`${meta.initValue ? `\n\n**初始值:** \`${meta.initValue}\`` : ''}`);
                }
                item.sortText = isArray ? `0000${sortIdx++}` : `0100${sortIdx++}`;
                if (isArray) { item.preselect = true; }
                items.push(item);
            });
            // computed 也可能返回数组
            targetIndex.computed.forEach((_loc, name) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
                item.detail = `computed ${name} (雷动三千)`;
                item.sortText = `0200${sortIdx++}`;
                items.push(item);
            });
            return items.length > 0 ? items : null;
        }

        // v-model=" → 建议 data 属性（双向绑定只适用于 data）
        const vModelMatch = /v-model(?:\.[\w.]+)?\s*=\s*["']([a-zA-Z_$][\w$.]*)?$/.exec(linePrefix);
        if (vModelMatch) {
            const items: vscode.CompletionItem[] = [];
            let sortIdx = 0;
            targetIndex.data.forEach((_loc, name) => {
                const meta = targetIndex.dataMeta?.get(name);
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
                const typeHint = meta?.initType ? ` (${meta.initType})` : '';
                item.detail = `data ${name}${typeHint} (雷动三千)`;
                if (meta?.initType) {
                    item.documentation = new vscode.MarkdownString(`**类型:** \`${meta.initType}\`${meta.initValue ? `\n\n**初始值:** \`${meta.initValue}\`` : ''}`);
                }
                item.sortText = `0000${sortIdx++}`;
                items.push(item);
            });
            // props 也可以 v-model
            targetIndex.props.forEach((_loc, name) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
                item.detail = `prop ${name} (雷动三千)`;
                item.sortText = `0100${sortIdx++}`;
                items.push(item);
            });
            return items.length > 0 ? items : null;
        }

        // v-if=" / v-else-if=" / v-show=" → 建议所有 data + computed（优先推荐布尔类型）
        const vConditionMatch = /(?:v-if|v-else-if|v-show)\s*=\s*["']([^"']*)?$/.exec(linePrefix);
        if (vConditionMatch) {
            const existing = vConditionMatch[1] || '';
            // 如果已经有表达式内容且包含运算符，不再插手
            if (/[&|<>=!?:+\-*/]/.test(existing) && existing.length > 0) { return null; }
            const items: vscode.CompletionItem[] = [];
            let sortIdx = 0;
            // 优先推荐布尔类型
            targetIndex.data.forEach((_loc, name) => {
                const meta = targetIndex.dataMeta?.get(name);
                const isBool = meta?.initType === 'boolean';
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
                const typeHint = meta?.initType ? ` (${meta.initType})` : '';
                item.detail = `${isBool ? '✓ ' : ''}data ${name}${typeHint} (雷动三千)`;
                item.sortText = isBool ? `0000${sortIdx++}` : `0100${sortIdx++}`;
                if (isBool) { item.preselect = true; }
                items.push(item);
            });
            targetIndex.computed.forEach((_loc, name) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
                item.detail = `computed ${name} (雷动三千)`;
                item.sortText = `0050${sortIdx++}`;
                items.push(item);
            });
            targetIndex.methods.forEach((_loc, name) => {
                const item = new vscode.CompletionItem(name + '()', vscode.CompletionItemKind.Method);
                item.insertText = `${name}()`;
                item.detail = `method ${name}() (雷动三千)`;
                item.sortText = `0200${sortIdx++}`;
                items.push(item);
            });
            return items.length > 0 ? items : null;
        }

        // v-bind:xxx=" / :xxx=" → 建议所有 data/computed/props
        const vBindMatch = /(?:v-bind:|:)[a-zA-Z0-9_-]+\s*=\s*["']([^"']*)?$/.exec(linePrefix);
        if (vBindMatch) {
            const existing = vBindMatch[1] || '';
            if (existing.length > 0 && /[.(\[{]/.test(existing)) { return null; } // 复杂表达式不介入
            const items: vscode.CompletionItem[] = [];
            let sortIdx = 0;
            targetIndex.data.forEach((_loc, name) => {
                const meta = targetIndex.dataMeta?.get(name);
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
                const typeHint = meta?.initType ? ` (${meta.initType})` : '';
                item.detail = `data ${name}${typeHint} (雷动三千)`;
                item.sortText = `0000${sortIdx++}`;
                items.push(item);
            });
            targetIndex.computed.forEach((_loc, name) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
                item.detail = `computed ${name} (雷动三千)`;
                item.sortText = `0100${sortIdx++}`;
                items.push(item);
            });
            targetIndex.props.forEach((_loc, name) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
                item.detail = `prop ${name} (雷动三千)`;
                item.sortText = `0200${sortIdx++}`;
                items.push(item);
            });
            targetIndex.methods.forEach((_loc, name) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
                item.detail = `method ${name} (雷动三千)`;
                item.sortText = `0300${sortIdx++}`;
                items.push(item);
            });
            return items.length > 0 ? items : null;
        }

        return null;
    }

    /**
     * v- 指令名称补全：建议常用 Vue 指令
     */
    private getDirectiveNameCompletions(): vscode.CompletionItem[] {
        const directives = [
            { name: 'v-if', snippet: 'v-if="$1"', doc: '条件渲染：为 true 时渲染元素' },
            { name: 'v-else-if', snippet: 'v-else-if="$1"', doc: '条件渲染：前一个 v-if 为 false 时判断' },
            { name: 'v-else', snippet: 'v-else', doc: '条件渲染：前面条件都为 false 时渲染' },
            { name: 'v-show', snippet: 'v-show="$1"', doc: '控制元素的 display 属性' },
            { name: 'v-for', snippet: 'v-for="$1 in $2" :key="$3"', doc: '列表渲染：遍历数组或对象' },
            { name: 'v-model', snippet: 'v-model="$1"', doc: '双向数据绑定' },
            { name: 'v-model.trim', snippet: 'v-model.trim="$1"', doc: '双向绑定 + 自动去除首尾空格' },
            { name: 'v-model.number', snippet: 'v-model.number="$1"', doc: '双向绑定 + 自动转换为数字' },
            { name: 'v-model.lazy', snippet: 'v-model.lazy="$1"', doc: '双向绑定 + 在 change 事件时同步' },
            { name: 'v-bind', snippet: 'v-bind:$1="$2"', doc: '动态绑定属性' },
            { name: 'v-on', snippet: 'v-on:$1="$2"', doc: '事件监听' },
            { name: 'v-text', snippet: 'v-text="$1"', doc: '更新元素 textContent' },
            { name: 'v-html', snippet: 'v-html="$1"', doc: '更新元素 innerHTML（注意 XSS 风险）' },
            { name: 'v-slot', snippet: 'v-slot:$1', doc: '具名插槽' },
            { name: 'v-pre', snippet: 'v-pre', doc: '跳过编译：显示原始 Mustache 标签' },
            { name: 'v-cloak', snippet: 'v-cloak', doc: '隐藏未编译的 Mustache 标签' },
            { name: 'v-once', snippet: 'v-once', doc: '只渲染一次，后续不再更新' },
        ];

        return directives.map((d, idx) => {
            const item = new vscode.CompletionItem(d.name, vscode.CompletionItemKind.Keyword);
            item.insertText = new vscode.SnippetString(d.snippet);
            item.detail = `Vue directive (雷动三千)`;
            item.documentation = new vscode.MarkdownString(d.doc);
            item.sortText = `0000${idx.toString().padStart(3, '0')}`;
            // 替换已输入的 v- 前缀
            item.filterText = d.name;
            return item;
        });
    }

    private isTemplateContext(linePrefix: string): boolean {
        if (/\{\{[^}]*$/.test(linePrefix)) { return true; }
        const inTag = linePrefix.lastIndexOf('<') > linePrefix.lastIndexOf('>');
        if (!inTag) { return false; }
        return /(v-bind:|:|v-on:|@|v-if|v-else-if|v-show|v-model|v-for|v-slot|slot-scope)\S*\s*=\s*["'][^"']*$/.test(linePrefix);
    }

    private getObjectPropertyContext(linePrefix: string): { root: string } | null {
        const match = /((?:this|that)\.)?([a-zA-Z_$][\w$]*)\.$/.exec(linePrefix);
        if (!match) { return null; }
        return { root: match[2] };
    }

    private getInferredPropertyItems(document: vscode.TextDocument, root: string): vscode.CompletionItem[] {
        const scriptPaths = getExternalDevScriptPathsForHtml(document);
        const cacheKey = `${document.uri.toString()}:${root}:${scriptPaths.join('|')}`;
        const cached = this.propertyCache.get(cacheKey);
        if (cached && (cached.docVersion === document.version || Date.now() - cached.updatedAt < this.propertyCacheTtlMs)) {
            return cached.items;
        }
        const props = new Set<string>();
        inferObjectProperties(document.getText(), root).forEach(p => props.add(p));
        let newestMtime = 0;
        for (const scriptPath of scriptPaths) {
            if (!fs.existsSync(scriptPath)) { continue; }
            try {
                const stat = fs.statSync(scriptPath);
                newestMtime = Math.max(newestMtime, stat.mtimeMs);
                if (cached && cached.scriptMtime === newestMtime && Date.now() - cached.updatedAt < this.propertyCacheTtlMs) {
                    return cached.items;
                }
                const content = fs.readFileSync(scriptPath, 'utf8');
                inferObjectProperties(content, root).forEach(p => props.add(p));
            } catch { /* ignore read errors */ }
        }
        const items = Array.from(props.values()).map(name => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
            item.detail = 'inferred property (雷动三千)';
            return item;
        });
        this.propertyCache.set(cacheKey, { items, updatedAt: Date.now(), docVersion: document.version, scriptMtime: newestMtime || undefined });
        // 限制缓存大小
        if (this.propertyCache.size > HtmlVueCompletionProvider.MAX_PROPERTY_CACHE) {
            const oldest = this.propertyCache.keys().next().value;
            if (oldest) { this.propertyCache.delete(oldest); }
        }
        return items;
    }
}

/**
 * Von 代码片段补全提供器
 */
export class VonCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        if (token.isCancellationRequested) { return []; }
        // 快速短路：至少需要 3 个字符
        if (position.character < 3) { return []; }
        const lineText = document.lineAt(position).text;
        const textBeforeCursor = lineText.substring(0, position.character);
        
        // 检查是否输入了 "von"（且前面是空白或行首，避免误匹配 "environ" 等单词）
        if (!textBeforeCursor.endsWith('von')) {
            return [];
        }
        // 确保 von 前面是非单词字符（行首 / 空格 / 标点等）
        const charBeforeVon = position.character >= 4 ? textBeforeCursor[position.character - 4] : '';
        if (charBeforeVon && /[a-zA-Z0-9_$]/.test(charBeforeVon)) {
            return [];
        }
        
        const completionItems: vscode.CompletionItem[] = [];
        
        // 1. 当前时间 YYYYMMDDHHMMSS
        const currentTimeItem = new vscode.CompletionItem('🕐 Current Time (YYYYMMDDHHMMSS)', vscode.CompletionItemKind.Snippet);
        const now = new Date();
        const timeString = this.formatDateTime(now);
        currentTimeItem.insertText = new vscode.SnippetString(timeString);
        currentTimeItem.detail = '⚡ Insert current time in YYYYMMDDHHMMSS format';
        currentTimeItem.documentation = `插入当前时间: ${timeString}`;
        currentTimeItem.sortText = '0001';
        currentTimeItem.preselect = true;
        currentTimeItem.filterText = 'von';
        currentTimeItem.commitCharacters = ['\t', '\n'];
        currentTimeItem.range = new vscode.Range(
            position.translate(0, -3), // -3 for "von"
            position
        );
        completionItems.push(currentTimeItem);
        
        // 2. 随机 UUID
        const uuidItem = new vscode.CompletionItem('🆔 Random UUID', vscode.CompletionItemKind.Snippet);
        const uuid = this.generateUUID();
        uuidItem.insertText = new vscode.SnippetString(uuid);
        uuidItem.detail = '⚡ Insert random UUID';
        uuidItem.documentation = `插入随机UUID: ${uuid}`;
        uuidItem.sortText = '0002';
        uuidItem.filterText = 'von';
        uuidItem.commitCharacters = ['\t', '\n'];
        uuidItem.range = new vscode.Range(
            position.translate(0, -3), // -3 for "von"
            position
        );
        completionItems.push(uuidItem);
        
        return completionItems;
    }
    
    /**
     * 格式化时间为 YYYYMMDDHHMMSS 格式
     */
    private formatDateTime(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        
        return `${year}${month}${day}${hours}${minutes}${seconds}`;
    }
    
    /**
     * 生成随机 UUID (v4)
     */
    private generateUUID(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
}
