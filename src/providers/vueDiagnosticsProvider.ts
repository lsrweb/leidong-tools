/**
 * Vue 诊断提供器
 * 功能：
 * 1. 未使用变量检测：data/methods/computed 中定义但模板未引用的变量
 * 2. 模板表达式诊断：{{ expr }} 和 :prop="expr" 中引用了不存在的变量
 * 
 * 可通过设置 leidong-tools.enableVueDiagnostics 关闭
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { resolveVueIndexForHtml, getOrCreateVueIndexFromContent, getExternalDevScriptPathsForHtml } from '../parsers/parseDocument';
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

    // 通用属性值提取正则（同时支持双引号和单引号）
    const attrVal = `(?:"([^"]+)"|'([^']+)')`;

    // 2. v-bind:xxx="expr" / :xxx="expr"
    const bindRegex = new RegExp(`(?:v-bind:|:)[\\w.-]+\\s*=\\s*${attrVal}`, 'g');
    while ((match = bindRegex.exec(htmlText)) !== null) {
        extractIdentifiersFromExpr(match[1] || match[2], identifiers);
    }

    // 3. v-on:xxx="expr" / @xxx="expr"
    const onRegex = new RegExp(`(?:v-on:|@)[\\w.-]+\\s*=\\s*${attrVal}`, 'g');
    while ((match = onRegex.exec(htmlText)) !== null) {
        extractIdentifiersFromExpr(match[1] || match[2], identifiers);
    }

    // 4. v-if/v-else-if/v-show="expr"
    const condRegex = new RegExp(`(?:v-if|v-else-if|v-show)\\s*=\\s*${attrVal}`, 'g');
    while ((match = condRegex.exec(htmlText)) !== null) {
        extractIdentifiersFromExpr(match[1] || match[2], identifiers);
    }

    // 5. v-for="item in list" — 提取 list
    const forRegex = new RegExp(`v-for\\s*=\\s*(?:"[^"]*(?:in|of)\\s+([^"]+)"|'[^']*(?:in|of)\\s+([^']+)')`, 'g');
    while ((match = forRegex.exec(htmlText)) !== null) {
        extractIdentifiersFromExpr(match[1] || match[2], identifiers);
    }

    // 6. v-model="xxx"
    const modelRegex = new RegExp(`v-model\\s*=\\s*${attrVal}`, 'g');
    while ((match = modelRegex.exec(htmlText)) !== null) {
        extractIdentifiersFromExpr(match[1] || match[2], identifiers);
    }

    // 7. onclick="xxx" 等原生事件
    const nativeEventRegex = new RegExp(`\\bon\\w+\\s*=\\s*${attrVal}`, 'gi');
    while ((match = nativeEventRegex.exec(htmlText)) !== null) {
        extractIdentifiersFromExpr(match[1] || match[2], identifiers);
    }

    // 8. | filter 管道
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
    let cleaned = expr.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
    // 去掉箭头函数参数：(a, b) => 或 a =>
    cleaned = cleaned.replace(/\(([^)]*)\)\s*=>/g, '=>');
    cleaned = cleaned.replace(/\b[a-zA-Z_$][\w$]*\s*=>/g, '=>');
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
 * 从整个 HTML 文档中一次性收集所有 v-for / slot-scope / v-slot / #xxx 局部变量
 * 返回全局集合（不做作用域精确追踪，避免复杂 DOM 树分析导致误报）
 */
function collectAllLocalVars(text: string): Set<string> {
    const localVars = new Set<string>();
    const attrVal = `(?:"([^"]*)"|'([^']*)')`;  // 同时支持双引号和单引号

    // v-for="(item, index) in list" or v-for="item in list"
    const vForRe = new RegExp(`v-for\\s*=\\s*${attrVal}`, 'g');
    let m: RegExpExecArray | null;
    while ((m = vForRe.exec(text)) !== null) {
        const val = m[1] || m[2];
        if (!val) { continue; }
        const inner = /(?:\(\s*)?([a-zA-Z_$][\w$]*)\s*(?:,\s*([a-zA-Z_$][\w$]*)\s*(?:,\s*([a-zA-Z_$][\w$]*)\s*)?)?\)?\s+(?:in|of)\s/.exec(val);
        if (inner) {
            localVars.add(inner[1]);
            if (inner[2]) { localVars.add(inner[2]); }
            if (inner[3]) { localVars.add(inner[3]); }
        }
    }

    // slot-scope="scope" or slot-scope="{ row, $index }"
    const slotScopeRe = new RegExp(`slot-scope\\s*=\\s*${attrVal}`, 'g');
    while ((m = slotScopeRe.exec(text)) !== null) {
        const val = m[1] || m[2];
        if (!val) { continue; }
        const stripped = val.replace(/[{}]/g, '');
        stripped.split(',').forEach(v => {
            const name = v.trim().replace(/\s*=.*/, '');
            if (/^[a-zA-Z_$][\w$]*$/.test(name)) { localVars.add(name); }
        });
    }

    // v-slot:name="slotProps" / v-slot="data" / #default="{ row }"
    const vSlotRe = new RegExp(`(?:v-slot(?::[\\w-]*)?|#[\\w-]+)\\s*=\\s*${attrVal}`, 'g');
    while ((m = vSlotRe.exec(text)) !== null) {
        const val = m[1] || m[2];
        if (!val) { continue; }
        const stripped = val.replace(/[{}]/g, '');
        stripped.split(',').forEach(v => {
            const name = v.trim().replace(/\s*=.*/, '');
            if (/^[a-zA-Z_$][\w$]*$/.test(name)) { localVars.add(name); }
        });
    }

    return localVars;
}

/**
 * 从 JS 内容中提取全局函数声明名（Vue 实例外部的 function xxx() {}）
 */
function collectGlobalFunctionNames(jsContent: string): Set<string> {
    const names = new Set<string>();
    // 匹配顶层 function 声明
    const re = /^function\s+([a-zA-Z_$][\w$]*)\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(jsContent)) !== null) {
        names.add(m[1]);
    }
    return names;
}

/**
 * 获取与 HTML 关联的 JS 内容
 */
function getAssociatedJsContent(document: vscode.TextDocument): string | null {
    try {
        const scriptPaths = getExternalDevScriptPathsForHtml(document);
        if (scriptPaths.length > 0 && fs.existsSync(scriptPaths[0])) {
            return fs.readFileSync(scriptPaths[0], 'utf8');
        }
    } catch { /* ignore */ }
    return null;
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
                if (name.startsWith('_') || name.startsWith('$')) { return; }
                
                const range = new vscode.Range(
                    loc.range.start.line,
                    loc.range.start.character,
                    loc.range.start.line,
                    loc.range.start.character + name.length
                );
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

    // 收集全局函数名（Vue 实例外部的 function 声明）
    const jsContent = getAssociatedJsContent(document);
    if (jsContent) {
        collectGlobalFunctionNames(jsContent).forEach(fn => knownIdentifiers.add(fn));
    }

    // 一次性收集整个文档的 v-for / slot-scope / v-slot 局部变量
    const allLocalVars = collectAllLocalVars(text);

    // 扫描 {{ }} 中的标识符
    const mustacheRegex = /\{\{([\s\S]*?)\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = mustacheRegex.exec(text)) !== null) {
        const exprStart = match.index + 2; // skip {{
        const expr = match[1];
        // 去掉字符串字面量
        let cleaned = expr.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
        // 去掉箭头函数参数
        cleaned = cleaned.replace(/\(([^)]*)\)\s*=>/g, '=>');
        cleaned = cleaned.replace(/\b[a-zA-Z_$][\w$]*\s*=>/g, '=>');

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

            // 跳过属性访问链中的标识符：.xxx 不应告警
            const charBefore = idMatch.index > 0 ? cleaned[idMatch.index - 1] : '';
            if (charBefore === '.') { continue; }

            // 跳过 v-for / slot-scope 局部变量
            if (allLocalVars.has(id)) { continue; }
            
            if (!knownIdentifiers.has(id)) {
                const pos = document.positionAt(exprStart + idMatch.index);
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
    }, 2500);
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
