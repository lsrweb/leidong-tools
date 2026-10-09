import * as vscode from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageService, newHTMLDataProvider, TokenType, ClientCapabilities } from 'vscode-html-languageservice';
import type { HTMLDocument, CompletionItem, Range, Hover, MarkedString, MarkupContent } from 'vscode-html-languageservice';
import { getCSSLanguageService } from 'vscode-css-languageservice';
import type { Stylesheet, LanguageSettings } from 'vscode-css-languageservice';
import { clearEmbeddedTemplateCache, getEmbeddedTemplates, getEmbeddedTemplateAtPosition, isEmbeddedScript, maskTemplateHoles } from '../parsers/embeddedTemplateParser';
import type { EmbeddedTemplate, OffsetRange } from '../parsers/embeddedTemplateParser';
import { getCachedVueIndexForContent } from '../parsers/parseDocument';

const vueData = newHTMLDataProvider('leidong-vue', {
    version: 1.1,
    globalAttributes: [
        { name: 'v-if', description: '根据表达式有条件地渲染元素。' },
        { name: 'v-else-if', description: '前一个条件未满足时判断此表达式。' },
        { name: 'v-else', description: '条件渲染的兜底分支。', valueSet: 'v' },
        { name: 'v-for', description: '遍历数组或对象。' },
        { name: 'v-show', description: '根据表达式切换元素的显示状态。' },
        { name: 'v-model', description: '双向绑定表单值。' },
        { name: 'v-bind', description: '动态绑定属性。' },
        { name: 'v-on', description: '绑定事件监听器。' },
        { name: 'v-text', description: '更新元素的文本内容。' },
        { name: 'v-html', description: '更新元素的 HTML 内容，仅用于可信内容。' },
        { name: 'v-slot', description: '声明具名或作用域插槽。' },
        { name: ':class', description: '动态绑定 CSS 类名。' },
        { name: ':style', description: '动态绑定行内样式。' },
        { name: '@click', description: '监听点击事件。' },
        { name: '@change', description: '监听值变化事件。' },
        { name: 'ref', description: '声明模板引用。' },
        { name: ':key', description: '为列表节点指定唯一标识。' }
    ]
});
const htmlService = getLanguageService({ clientCapabilities: ClientCapabilities.LATEST, customDataProviders: [vueData] });
const cssService = getCSSLanguageService({ clientCapabilities: ClientCapabilities.LATEST });

interface EmbeddedView extends OffsetRange {
    language: 'html' | 'css';
    template: EmbeddedTemplate;
    document: TextDocument;
    prefixLength: number;
    html?: HTMLDocument;
    css?: Stylesheet;
    diagnostics: Array<{ range: OffsetRange; message: string }>;
}
interface TemplateViews {
    views: EmbeddedView[];
    blocked: Array<OffsetRange & { vue: boolean }>;
}
const viewCache = new WeakMap<EmbeddedTemplate, TemplateViews>();

export function embeddedLanguageFeaturesEnabled(document: vscode.TextDocument): boolean {
    return vscode.workspace.getConfiguration('leidong-tools', document.uri).get<boolean>('embeddedLanguageFeatures', true);
}

function contains(range: OffsetRange, offset: number): boolean {
    return offset >= range.start && offset <= range.end;
}

function createView(template: EmbeddedTemplate, start: number, end: number, language: 'html' | 'css', declarations = false): EmbeddedView {
    let raw = maskTemplateHoles(template.content, template.start, template.holes).slice(start - template.start, end - template.start);
    if (language === 'html') {
        raw = raw.replace(/\{\{[\s\S]*?(?:\}\}|$)/g, value => value.replace(/[^\r\n]/g, 'x'));
    }
    const prefix = declarations ? ':root{\n' : '';
    const document = TextDocument.create(`embedded://template/${start}.${language}`, language, 1, prefix + raw + (declarations ? '\n}' : ''));
    return {
        start, end, language, template, document, prefixLength: prefix.length,
        html: language === 'html' ? htmlService.parseHTMLDocument(document) : undefined,
        css: language === 'css' ? cssService.parseStylesheet(document) : undefined,
        diagnostics: []
    };
}

function getViews(template: EmbeddedTemplate): TemplateViews {
    const hit = viewCache.get(template);
    if (hit) { return hit; }
    const main = createView(template, template.start, template.end, template.language, template.declarations);
    const result: TemplateViews = { views: [main], blocked: [] };
    viewCache.set(template, result);
    if (template.language !== 'html') { return result; }
    const original = maskTemplateHoles(template.content, template.start, template.holes);
    const interpolation = /\{\{[\s\S]*?(?:\}\}|$)/g;
    let match: RegExpExecArray | null;
    while ((match = interpolation.exec(original))) {
        result.blocked.push({ start: template.start + match.index, end: template.start + match.index + match[0].length, vue: true });
    }
    const text = main.document.getText();
    const scanner = htmlService.createScanner(text);
    let attribute = '';
    let styleLanguage = '';
    let tag = '';
    let attributes = new Set<string>();
    for (let token = scanner.scan(); token !== TokenType.EOS; token = scanner.scan()) {
        const start = template.start + scanner.getTokenOffset();
        const end = template.start + scanner.getTokenEnd();
        const value = scanner.getTokenText();
        const error = scanner.getTokenError();
        if (error) { main.diagnostics.push({ range: { start, end }, message: error }); }
        if (token === TokenType.StartTag) {
            tag = value.toLowerCase();
            styleLanguage = '';
            attributes = new Set();
        } else if (token === TokenType.AttributeName) {
            attribute = value.toLowerCase();
            if (attributes.has(attribute)) {
                main.diagnostics.push({ range: { start, end }, message: `重复的 HTML 属性：${value}` });
            }
            attributes.add(attribute);
        } else if (token === TokenType.AttributeValue) {
            const quoted = value[0] === '"' || value[0] === "'";
            const from = start + (quoted ? 1 : 0);
            const to = end - (quoted && value.length > 1 && value.endsWith(value[0]) ? 1 : 0);
            if (tag === 'style' && (attribute === 'lang' || attribute === 'type')) {
                styleLanguage = value.replace(/^['"]|['"]$/g, '').toLowerCase();
            }
            if (attribute === 'style') {
                result.views.unshift(createView(template, from, to, 'css', true));
            } else if (/^(?:[:@#]|v-|on[a-z])/.test(attribute)) {
                result.blocked.push({ start: from, end: to, vue: true });
            }
        } else if (token === TokenType.Styles) {
            if (!styleLanguage || styleLanguage === 'css' || styleLanguage === 'text/css') {
                result.views.unshift(createView(template, start, end, 'css'));
            } else { result.blocked.push({ start, end, vue: false }); }
        } else if (token === TokenType.Script || token === TokenType.Comment) {
            result.blocked.push({ start, end, vue: false });
        }
    }
    return result;
}

export function isEmbeddedVueExpression(document: vscode.TextDocument, position: vscode.Position): boolean {
    const template = getEmbeddedTemplateAtPosition(document, position);
    return !!template && getViews(template).blocked.some(range => range.vue && contains(range, document.offsetAt(position)));
}

function viewAt(document: vscode.TextDocument, position: vscode.Position): EmbeddedView | undefined {
    if (!embeddedLanguageFeaturesEnabled(document)) { return undefined; }
    const template = getEmbeddedTemplateAtPosition(document, position);
    if (!template) { return undefined; }
    const offset = document.offsetAt(position);
    const result = getViews(template);
    if (result.blocked.some(range => contains(range, offset))) { return undefined; }
    return result.views.find(view => contains(view, offset));
}

function localPosition(view: EmbeddedView, document: vscode.TextDocument, position: vscode.Position) {
    return view.document.positionAt(document.offsetAt(position) - view.start + view.prefixLength);
}

function sourceRange(view: EmbeddedView, document: vscode.TextDocument, range: Range): vscode.Range | undefined {
    const start = view.start + view.document.offsetAt(range.start) - view.prefixLength;
    const end = view.start + view.document.offsetAt(range.end) - view.prefixLength;
    if (start < view.start || end > view.end || end < start
        || view.template.holes.some(hole => start < hole.end && end > hole.start)) { return undefined; }
    return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

function markdown(value: string | MarkupContent | MarkedString): vscode.MarkdownString {
    if (typeof value === 'string') { return new vscode.MarkdownString(value); }
    if ('language' in value) { return new vscode.MarkdownString().appendCodeblock(value.value, value.language); }
    return value.kind === 'plaintext' ? new vscode.MarkdownString().appendText(value.value) : new vscode.MarkdownString(value.value);
}

function completionItem(item: CompletionItem, view: EmbeddedView, document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem | undefined {
    const converted = new vscode.CompletionItem(item.label, item.kind === undefined ? vscode.CompletionItemKind.Text : item.kind - 1);
    converted.detail = `${item.detail || view.language.toUpperCase()} · 雷动内嵌语言`;
    converted.documentation = item.documentation ? markdown(item.documentation) : undefined;
    converted.filterText = item.filterText;
    converted.sortText = item.sortText;
    converted.preselect = item.preselect;
    converted.commitCharacters = item.commitCharacters;
    const edit = item.textEdit;
    const text = edit?.newText ?? item.insertText ?? item.label;
    converted.insertText = item.insertTextFormat === 2 ? new vscode.SnippetString(text) : text;
    if (edit) {
        const replace = sourceRange(view, document, 'range' in edit ? edit.range : edit.replace);
        const insert = sourceRange(view, document, 'range' in edit ? edit.range : edit.insert);
        if (!replace || !insert || !replace.isSingleLine || !insert.isSingleLine || !insert.contains(position)) { return undefined; }
        converted.range = 'range' in edit ? replace : { inserting: insert, replacing: replace };
    }
    if (item.additionalTextEdits) {
        converted.additionalTextEdits = [];
        for (const additional of item.additionalTextEdits) {
            const range = sourceRange(view, document, additional.range);
            if (!range) { return undefined; }
            converted.additionalTextEdits.push(vscode.TextEdit.replace(range, additional.newText));
        }
    }
    if (item.command?.command === 'editor.action.triggerSuggest') {
        converted.command = { command: item.command.command, title: item.command.title };
    }
    return converted;
}

export class EmbeddedLanguageProvider implements vscode.CompletionItemProvider, vscode.HoverProvider {
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.CompletionList | undefined {
        if (token.isCancellationRequested) { return undefined; }
        const view = viewAt(document, position);
        if (!view) { return undefined; }
        const at = localPosition(view, document, position);
        if (view.language === 'html') {
            // 只读取已有 Vue 索引，不因基础 HTML 提示触发工作区建索引。
            const index = getCachedVueIndexForContent(document.getText(), document.uri, 0);
            const tags = Array.from(index?.registeredComponents.values() || []).map(comp => ({ name: comp.kebabName, attributes: [] }));
            htmlService.setDataProviders(true, [vueData, newHTMLDataProvider('leidong-components', { version: 1.1, tags })]);
        }
        const result = view.language === 'html'
            ? htmlService.doComplete(view.document, at, view.html!)
            : cssService.doComplete(view.document, at, view.css!, { triggerPropertyValueCompletion: true, completePropertyWithSemicolon: true });
        if (token.isCancellationRequested) { return undefined; }
        const items = result.items.map(item => completionItem(item, view, document, position)).filter((item): item is vscode.CompletionItem => !!item);
        return new vscode.CompletionList(items, result.isIncomplete);
    }

    provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.Hover | undefined {
        if (token.isCancellationRequested) { return undefined; }
        const view = viewAt(document, position);
        if (!view) { return undefined; }
        const at = localPosition(view, document, position);
        const hover: Hover | null = view.language === 'html'
            ? htmlService.doHover(view.document, at, view.html!)
            : cssService.doHover(view.document, at, view.css!);
        if (!hover || token.isCancellationRequested) { return undefined; }
        const range = hover.range ? sourceRange(view, document, hover.range) : undefined;
        if (hover.range && !range) { return undefined; }
        const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
        return new vscode.Hover(contents.map(markdown), range);
    }

    provideDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
        const config = vscode.workspace.getConfiguration('leidong-tools', document.uri);
        if (!embeddedLanguageFeaturesEnabled(document) || !config.get<boolean>('embeddedLanguageDiagnostics', true)) { return []; }
        const cssConfig = vscode.workspace.getConfiguration('css', document.uri);
        const settings: LanguageSettings = { validate: cssConfig.get<boolean>('validate', true), lint: cssConfig.get('lint', {}) };
        const diagnostics: vscode.Diagnostic[] = [];
        for (const template of getEmbeddedTemplates(document)) {
            // 动态拼接/转义可能改变语法结构；保守跳过该模板的诊断，其他静态模板不受影响。
            if (!template.closed || template.holes.length || template.content.includes('\\')) { continue; }
            for (const view of getViews(template).views) {
                if (view.language === 'css') {
                    for (const item of cssService.doValidation(view.document, view.css!, settings)) {
                        const range = sourceRange(view, document, item.range);
                        if (!range) { continue; }
                        const diagnostic = new vscode.Diagnostic(range, item.message, item.severity === undefined ? vscode.DiagnosticSeverity.Warning : item.severity - 1);
                        diagnostic.source = '雷动内嵌 CSS';
                        diagnostic.code = item.code;
                        diagnostics.push(diagnostic);
                    }
                } else {
                    for (const item of view.diagnostics) {
                        const diagnostic = new vscode.Diagnostic(new vscode.Range(document.positionAt(item.range.start), document.positionAt(item.range.end)), item.message, vscode.DiagnosticSeverity.Warning);
                        diagnostic.source = '雷动内嵌 HTML';
                        diagnostics.push(diagnostic);
                    }
                }
            }
            if (diagnostics.length >= 200) { break; }
        }
        return diagnostics.slice(0, 200);
    }
}

export function registerEmbeddedLanguageFeatures(context: vscode.ExtensionContext): void {
    const provider = new EmbeddedLanguageProvider();
    const selector: vscode.DocumentSelector = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'].flatMap(language => [
        { language, scheme: 'file' }, { language, scheme: 'untitled' }
    ]);
    const diagnostics = vscode.languages.createDiagnosticCollection('leidong-embedded');
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const cancel = (document: vscode.TextDocument): void => {
        const key = document.uri.toString();
        const timer = timers.get(key);
        if (timer) { clearTimeout(timer); }
        timers.delete(key);
    };
    const schedule = (document: vscode.TextDocument): void => {
        if (!isEmbeddedScript(document) || !['file', 'untitled'].includes(document.uri.scheme)) { return; }
        cancel(document);
        diagnostics.delete(document.uri);
        if (!embeddedLanguageFeaturesEnabled(document)) { return; }
        const version = document.version;
        timers.set(document.uri.toString(), setTimeout(() => {
            timers.delete(document.uri.toString());
            if (document.isClosed || version !== document.version) { return; }
            diagnostics.set(document.uri, provider.provideDiagnostics(document));
        }, 350));
    };
    context.subscriptions.push(
        diagnostics,
        vscode.languages.registerCompletionItemProvider(selector, provider, '<', '>', '/', ' ', '=', '"', "'", ':', ';', '-', '@', '.', '#', '(', '{'),
        vscode.languages.registerHoverProvider(selector, provider),
        vscode.workspace.onDidOpenTextDocument(schedule),
        vscode.workspace.onDidChangeTextDocument(event => schedule(event.document)),
        vscode.workspace.onDidCloseTextDocument(document => {
            cancel(document);
            diagnostics.delete(document.uri);
            clearEmbeddedTemplateCache(document);
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('leidong-tools.embeddedLanguageFeatures')
                || event.affectsConfiguration('leidong-tools.embeddedLanguageDiagnostics') || event.affectsConfiguration('css')) {
                vscode.workspace.textDocuments.forEach(schedule);
            }
        }),
        new vscode.Disposable(() => {
            timers.forEach(timer => clearTimeout(timer));
            timers.clear();
            vscode.workspace.textDocuments.forEach(clearEmbeddedTemplateCache);
        })
    );
    vscode.workspace.textDocuments.forEach(schedule);
}
