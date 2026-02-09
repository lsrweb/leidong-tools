/**
 * Vue 诊断提供器
 * 功能：
 * 1. 未使用变量检测：data/methods/computed 中定义但模板未引用的变量
 * 2. 模板表达式诊断：{{ expr }} 和 :prop="expr" 中引用了不存在的变量
 * 
 * 可通过设置 leidong-tools.enableVueDiagnostics 关闭
 */
import * as vscode from 'vscode';
import { resolveVueIndexForHtml, getOrCreateVueIndexFromContent } from '../parsers/parseDocument';
import type { VueIndex } from '../parsers/parseDocument';

const DIAGNOSTICS_SOURCE = '雷动三千';
let diagnosticCollection: vscode.DiagnosticCollection;
let debounceTimer: NodeJS.Timeout | null = null;

function isEnabled(): boolean {
    try {
        return vscode.workspace.getConfiguration('leidong-tools').get<boolean>('enableVueDiagnostics', true) === true;
    } catch { return true; }
}

function shouldLog(): boolean {
    try {
        return vscode.workspace.getConfiguration('leidong-tools').get<boolean>('indexLogging', true) === true;
    } catch { return true; }
}

/**
 * 从 HTML 模板中提取所有被引用的标识符
 */
function extractTemplateIdentifiers(htmlText: string): Set<string> {
    const identifiers = new Set<string>();

    // 1. {{ expr }} 中的标识符
    const mustacheRegex = /\{\{([\s\S]*?)\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = mustacheRegex.exec(htmlText)) !== null) {
        extractIdentifiersFromExpr(match[1], identifiers);
    }

    // 2. v-bind:xxx="expr" / :xxx="expr"
    const bindRegex = /(?:v-bind:|:)[\w.-]+\s*=\s*"([^"]+)"/g;
    while ((match = bindRegex.exec(htmlText)) !== null) {
        extractIdentifiersFromExpr(match[1], identifiers);
    }

    // 3. v-on:xxx="expr" / @xxx="expr"
    const onRegex = /(?:v-on:|@)[\w.-]+\s*=\s*"([^"]+)"/g;
    while ((match = onRegex.exec(htmlText)) !== null) {
        extractIdentifiersFromExpr(match[1], identifiers);
    }

    // 4. v-if/v-else-if/v-show="expr"
    const condRegex = /(?:v-if|v-else-if|v-show)\s*=\s*"([^"]+)"/g;
    while ((match = condRegex.exec(htmlText)) !== null) {
        extractIdentifiersFromExpr(match[1], identifiers);
    }

    // 5. v-for="item in list" — 提取 list
    const forRegex = /v-for\s*=\s*"[^"]*(?:in|of)\s+([^"]+)"/g;
    while ((match = forRegex.exec(htmlText)) !== null) {
        extractIdentifiersFromExpr(match[1], identifiers);
    }

    // 6. v-model="xxx"
    const modelRegex = /v-model\s*=\s*"([^"]+)"/g;
    while ((match = modelRegex.exec(htmlText)) !== null) {
        extractIdentifiersFromExpr(match[1], identifiers);
    }

    // 7. | filter 管道
    const filterRegex = /\|\s*([a-zA-Z_$][\w$]*)/g;
    while ((match = filterRegex.exec(htmlText)) !== null) {
        identifiers.add(match[1]);
    }

    return identifiers;
}

/**
 * 从 JS 表达式中提取标识符（简单版本）
 */
function extractIdentifiersFromExpr(expr: string, identifiers: Set<string>): void {
    // 去掉字符串字面量
    const cleaned = expr.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
    // 提取标识符 (排除关键字)
    const idRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
    const keywords = new Set(['true', 'false', 'null', 'undefined', 'typeof', 'instanceof',
        'new', 'in', 'of', 'if', 'else', 'return', 'var', 'let', 'const', 'function',
        'this', 'that', 'self', 'vm', 'console', 'window', 'document', 'Math', 'JSON',
        'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Error',
        'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'NaN', 'Infinity',
        'item', 'index', 'key', 'value', 'event', '$event', 'arguments',
        'alert', 'confirm', 'prompt', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']);
    let m: RegExpExecArray | null;
    while ((m = idRegex.exec(cleaned)) !== null) {
        if (!keywords.has(m[1])) {
            identifiers.add(m[1]);
        }
    }
}

/**
 * 检测 HTML 文件中的 Vue 诊断问题
 */
function diagnoseHtmlDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();
    const vueIndex = resolveVueIndexForHtml(document);
    if (!vueIndex) { return diagnostics; }

    const templateIdentifiers = extractTemplateIdentifiers(text);

    // -- 未使用变量检测 --
    const checkUnused = (
        map: Map<string, vscode.Location>,
        category: string
    ) => {
        map.forEach((loc, name) => {
            if (!templateIdentifiers.has(name)) {
                // 检查是否被 JS 内部引用（如 watch handler、computed dependency）
                // 简单跳过常见的命名模式
                if (name.startsWith('_') || name.startsWith('$')) { return; }
                
                const range = new vscode.Range(
                    loc.range.start.line,
                    loc.range.start.character,
                    loc.range.start.line,
                    loc.range.start.character + name.length
                );
                // 只在定义文件是同一个 fsPath 的情况下标注（外部 JS 文件暂不标注在 HTML 上）
                const diag = new vscode.Diagnostic(
                    range,
                    `"${name}" 在 ${category} 中定义但未在模板中使用`,
                    vscode.DiagnosticSeverity.Hint
                );
                diag.source = DIAGNOSTICS_SOURCE;
                diag.tags = [vscode.DiagnosticTag.Unnecessary];
                diagnostics.push(diag);
            }
        });
    };

    checkUnused(vueIndex.data, 'data');
    checkUnused(vueIndex.methods, 'methods');
    checkUnused(vueIndex.computed, 'computed');

    // -- 模板表达式诊断 --
    // 构建已知标识符集合
    const knownIdentifiers = new Set<string>();
    [vueIndex.data, vueIndex.methods, vueIndex.computed, vueIndex.props,
     vueIndex.filters, vueIndex.mixinData, vueIndex.mixinMethods, vueIndex.mixinComputed]
        .forEach(m => m.forEach((_loc, name) => knownIdentifiers.add(name)));

    // 扫描 {{ }} 中的标识符
    const mustacheRegex = /\{\{([\s\S]*?)\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = mustacheRegex.exec(text)) !== null) {
        const exprStart = match.index + 2; // skip {{
        const expr = match[1];
        const cleaned = expr.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
        const idRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
        const keywords = new Set(['true', 'false', 'null', 'undefined', 'typeof', 'instanceof',
            'new', 'in', 'of', 'if', 'else', 'return', 'this', 'that', 'self', 'vm',
            'console', 'window', 'document', 'Math', 'JSON', 'Object', 'Array', 'String',
            'Number', 'Boolean', 'Date', 'parseInt', 'parseFloat', 'isNaN', 'NaN', 'Infinity',
            'item', 'index', 'key', 'value', 'event', '$event', 'arguments',
            'alert', 'confirm', 'prompt', 'setTimeout', 'setInterval']);
        let idMatch: RegExpExecArray | null;
        while ((idMatch = idRegex.exec(cleaned)) !== null) {
            const id = idMatch[1];
            if (keywords.has(id)) { continue; }
            // 检查是否是 v-for 局部变量 (简易判断：向上搜索 v-for)
            const pos = document.positionAt(exprStart + idMatch.index);
            const linesBefore = text.substring(0, exprStart).split('\n');
            let isLocalVar = false;
            for (let i = linesBefore.length - 1; i >= Math.max(0, linesBefore.length - 20); i--) {
                if (linesBefore[i].includes(`v-for`) && linesBefore[i].includes(id)) {
                    isLocalVar = true;
                    break;
                }
                if (linesBefore[i].includes(`slot-scope`) && linesBefore[i].includes(id)) {
                    isLocalVar = true;
                    break;
                }
            }
            if (isLocalVar) { continue; }
            
            if (!knownIdentifiers.has(id)) {
                const range = new vscode.Range(pos.line, pos.character, pos.line, pos.character + id.length);
                const diag = new vscode.Diagnostic(
                    range,
                    `"${id}" 未在 Vue 实例中定义 (data/props/computed/methods/filters)`,
                    vscode.DiagnosticSeverity.Warning
                );
                diag.source = DIAGNOSTICS_SOURCE;
                diagnostics.push(diag);
            }
        }
    }

    return diagnostics;
}

/**
 * 运行诊断（带 debounce）
 */
function runDiagnostics(document: vscode.TextDocument) {
    if (!isEnabled()) {
        diagnosticCollection.delete(document.uri);
        return;
    }
    if (document.languageId !== 'html') {
        return;
    }
    
    if (debounceTimer) { clearTimeout(debounceTimer); }
    debounceTimer = setTimeout(() => {
        try {
            const diagnostics = diagnoseHtmlDocument(document);
            diagnosticCollection.set(document.uri, diagnostics);
            if (shouldLog()) {
                console.log(`[vue-diagnostics] ${document.uri.fsPath}: ${diagnostics.length} issues`);
            }
        } catch (e) {
            console.error('[vue-diagnostics] error:', e);
        }
    }, 1000);
}

/**
 * 初始化诊断功能
 */
export function initVueDiagnostics(context: vscode.ExtensionContext): void {
    diagnosticCollection = vscode.languages.createDiagnosticCollection('leidong-vue');
    context.subscriptions.push(diagnosticCollection);

    // 文件保存时运行诊断
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            runDiagnostics(document);
        })
    );

    // 切换编辑器时运行诊断
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                runDiagnostics(editor.document);
            }
        })
    );

    // 文件关闭时清除诊断
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            diagnosticCollection.delete(document.uri);
        })
    );

    // 配置变更时清除或重新运行
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('leidong-tools.enableVueDiagnostics')) {
                if (!isEnabled()) {
                    diagnosticCollection.clear();
                } else {
                    const editor = vscode.window.activeTextEditor;
                    if (editor) { runDiagnostics(editor.document); }
                }
            }
        })
    );

    // 初始运行
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        runDiagnostics(editor.document);
    }
}
