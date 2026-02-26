/**
 * CodeLensProvider - 模板引用计数
 * 支持3种显示位置：
 *   - above: 在定义行上方显示 CodeLens（默认）
 *   - right: 在定义行右侧显示行末装饰
 *   - hover: 仅在鼠标悬停时显示引用次数
 * 
 * 可通过 enableCodeLens + codeLensPosition 配置
 */
import * as vscode from 'vscode';
import { resolveVueIndexForHtml, getOrCreateVueIndexFromContent, getExternalDevScriptPathsForHtml } from '../parsers/parseDocument';
import type { VueIndex } from '../parsers/parseDocument';
import * as fs from 'fs';
import * as path from 'path';

/** Windows 下路径大小写不敏感的规范化 */
function normalizePath(p: string): string {
    return path.normalize(p).toLowerCase();
}

// ─── 工具函数 ───

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 在 HTML 文本中计算某标识符被引用的次数
 */
function countReferencesInHtml(text: string, identifier: string): number {
    const escaped = escapeRegex(identifier);
    let count = 0;

    const mustacheRegex = /\{\{([\s\S]*?)\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = mustacheRegex.exec(text)) !== null) {
        const inner = m[1];
        const idRegex = new RegExp(`\\b${escaped}\\b`, 'g');
        let im: RegExpExecArray | null;
        while ((im = idRegex.exec(inner)) !== null) { count++; }
    }

    const attrPatterns = [
        // 双引号
        /(?:v-bind:|:)[\w.-]+\s*=\s*"([^"]+)"/g,
        /(?:v-on:|@)[\w.-]+\s*=\s*"([^"]+)"/g,
        /(?:v-if|v-else-if|v-show)\s*=\s*"([^"]+)"/g,
        /v-for\s*=\s*"([^"]+)"/g,
        /v-model\s*=\s*"([^"]+)"/g,
        // 单引号
        /(?:v-bind:|:)[\w.-]+\s*=\s*'([^']+)'/g,
        /(?:v-on:|@)[\w.-]+\s*=\s*'([^']+)'/g,
        /(?:v-if|v-else-if|v-show)\s*=\s*'([^']+)'/g,
        /v-for\s*=\s*'([^']+)'/g,
        /v-model\s*=\s*'([^']+)'/g,
        // Plain HTML event handlers: onclick="...", onchange="...", etc.
        /\bon\w+\s*=\s*"([^"]+)"/gi,
        /\bon\w+\s*=\s*'([^']+)'/gi,
    ];
    for (const pattern of attrPatterns) {
        pattern.lastIndex = 0;
        while ((m = pattern.exec(text)) !== null) {
            const inner = m[1];
            const idRegex = new RegExp(`\\b${escaped}\\b`, 'g');
            let im: RegExpExecArray | null;
            while ((im = idRegex.exec(inner)) !== null) { count++; }
        }
    }

    return count;
}

/**
 * 在 JS 文本中计算 this.xxx 的引用次数（排除定义行）
 */
function countReferencesInJs(text: string, identifier: string, definitionLine: number): number {
    const escaped = escapeRegex(identifier);
    const regex = new RegExp(`(?:this|that|_this|self|_self|vm|_vm|me|ctx|app)\\.${escaped}\\b`, 'g');
    let count = 0;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (i === definitionLine) { continue; }
        regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(lines[i])) !== null) { count++; }
    }
    return count;
}

/**
 * 查找关联 HTML 文件
 * 1. 扫描所有已打开的 HTML 文档，通过 dev.js 关联反向查找
 * 2. 回退到目录约定查找
 */
function findAssociatedHtmlForJs(jsFilePath: string): string[] {
    const normalizedJs = normalizePath(jsFilePath);
    const seen = new Set<string>();
    const result: string[] = [];

    const addFile = (filePath: string) => {
        const n = normalizePath(filePath);
        if (!seen.has(n) && fs.existsSync(filePath)) {
            seen.add(n);
            result.push(path.normalize(filePath));
        }
    };

    // 方法 1：遍历已打开的 HTML 文档，检查 dev.js 关联
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'html' && !doc.isClosed) {
            try {
                const scriptPaths = getExternalDevScriptPathsForHtml(doc);
                for (const sp of scriptPaths) {
                    if (normalizePath(sp) === normalizedJs) {
                        addFile(doc.uri.fsPath);
                    }
                }
            } catch { /* ignore */ }
        }
    }

    // 方法 2：基于目录约定
    const dir = path.dirname(jsFilePath);
    const parentDir = path.dirname(dir);
    const baseName = path.basename(jsFilePath).replace(/\.dev\.js$/, '').replace(/\.js$/, '');
    const candidates = [
        path.join(parentDir, `${baseName}.html`),
        path.join(parentDir, 'index.html'),
        path.join(dir, `${baseName}.html`),
    ];
    for (const c of candidates) { addFile(c); }

    return result;
}

// ─── 引用计数信息 ───

export interface RefCountInfo {
    name: string;
    category: string;
    count: number;
    line: number;
    loc: vscode.Location;
}

/**
 * 计算文档中所有 Vue 成员的引用次数
 */
export function computeRefCounts(document: vscode.TextDocument): RefCountInfo[] | null {
    let vueIndex: VueIndex | null = null;
    let htmlText = '';
    let jsText = '';

    try {
        if (document.languageId === 'javascript' || document.languageId === 'typescript' || document.languageId === 'vue') {
            jsText = document.getText();
            vueIndex = getOrCreateVueIndexFromContent(jsText, document.uri, 0);
            
            // 找关联 HTML (只查找已知关联的文件，不遍历所有打开的文档)
            const htmlFiles = findAssociatedHtmlForJs(document.uri.fsPath);
            for (const hf of htmlFiles) {
                try {
                    const openDoc = vscode.workspace.textDocuments.find(
                        d => normalizePath(d.uri.fsPath) === normalizePath(hf) && !d.isClosed
                    );
                    htmlText += (openDoc ? openDoc.getText() : fs.readFileSync(hf, 'utf8')) + '\n';
                } catch { /* */ }
            }

            // 回退：当 JS 文件自身解析的 VueIndex 为空时，
            // 尝试通过关联 HTML 文件的 resolveVueIndexForHtml 间接获取索引
            // （HTML 可能通过 <script src> 引用此 JS 并提供完整 Vue 实例上下文）
            if (vueIndex && vueIndex.data.size === 0 && vueIndex.methods.size === 0
                && vueIndex.computed.size === 0 && vueIndex.mixinData.size === 0
                && vueIndex.mixinMethods.size === 0 && vueIndex.mixinComputed.size === 0) {
                for (const hf of htmlFiles) {
                    try {
                        const openDoc = vscode.workspace.textDocuments.find(
                            d => normalizePath(d.uri.fsPath) === normalizePath(hf) && !d.isClosed
                        );
                        if (openDoc) {
                            const htmlVueIndex = resolveVueIndexForHtml(openDoc);
                            if (htmlVueIndex && (htmlVueIndex.data.size > 0 || htmlVueIndex.methods.size > 0
                                || htmlVueIndex.computed.size > 0 || htmlVueIndex.mixinData.size > 0
                                || htmlVueIndex.mixinMethods.size > 0)) {
                                vueIndex = htmlVueIndex;
                                break;
                            }
                        }
                    } catch { /* ignore */ }
                }
            }
        } else if (document.languageId === 'html') {
            htmlText = document.getText();
            vueIndex = resolveVueIndexForHtml(document);
            if (vueIndex) {
                const firstDef = vueIndex.data.values().next().value || vueIndex.methods.values().next().value;
                if (firstDef && firstDef.uri.fsPath !== document.uri.fsPath) {
                    try { jsText = fs.readFileSync(firstDef.uri.fsPath, 'utf8'); } catch { /* */ }
                } else {
                    // 内联脚本：HTML 和 JS 在同一个文件中，需要搜索 this.xxx 引用
                    jsText = document.getText();
                }
            }
        }
    } catch { /* */ }

    if (!vueIndex) { return null; }

    const infos: RefCountInfo[] = [];

    const normalizedCurrentPath = normalizePath(document.uri.fsPath);
    const collect = (map: Map<string, vscode.Location>, category: string) => {
        map.forEach((loc, name) => {
            if (normalizePath(loc.uri.fsPath) !== normalizedCurrentPath) { return; }
            let count = 0;
            if (htmlText) { count += countReferencesInHtml(htmlText, name); }
            if (jsText) { count += countReferencesInJs(jsText, name, loc.range.start.line); }
            infos.push({ name, category, count, line: loc.range.start.line, loc });
        });
    };

    collect(vueIndex.data, 'data');
    collect(vueIndex.methods, 'methods');
    collect(vueIndex.computed, 'computed');
    collect(vueIndex.props, 'props');
    collect(vueIndex.mixinData, 'mixin data');
    collect(vueIndex.mixinMethods, 'mixin methods');
    collect(vueIndex.mixinComputed, 'mixin computed');
    collect(vueIndex.filters, 'filters');

    // 全局函数引用计数（定义在 Vue 实例外部的 function）
    if (jsText) {
        const existingNames = new Set<string>();
        infos.forEach(i => existingNames.add(i.name));

        const jsLines = jsText.split('\n');
        const addFuncInfo = (funcName: string, defLine: number) => {
            if (existingNames.has(funcName)) { return; } // 已在 VueIndex 中
            existingNames.add(funcName);
            let count = 0;
            if (htmlText) { count += countReferencesInHtml(htmlText, funcName); }
            const callRegex = new RegExp(`\\b${escapeRegex(funcName)}\\s*\\(`, 'g');
            for (let i = 0; i < jsLines.length; i++) {
                if (i === defLine) { continue; }
                callRegex.lastIndex = 0;
                let cm: RegExpExecArray | null;
                while ((cm = callRegex.exec(jsLines[i])) !== null) { count++; }
            }
            const defPos = new vscode.Position(defLine, 0);
            const loc = new vscode.Location(document.uri, new vscode.Range(defPos, defPos));
            infos.push({ name: funcName, category: 'function', count, line: defLine, loc });
        };

        // 1. function declaration: function xxx()
        const funcDeclRegex = /^function\s+([a-zA-Z_$][\w$]*)\s*\(/gm;
        let fm: RegExpExecArray | null;
        while ((fm = funcDeclRegex.exec(jsText)) !== null) {
            const defLine = jsText.substring(0, fm.index).split('\n').length - 1;
            addFuncInfo(fm[1], defLine);
        }

        // 2. function expression: var/let/const xxx = function()
        const funcExprRegex = /^(?:var|let|const)\s+([a-zA-Z_$][\w$]*)\s*=\s*function\s*[\w$]*\s*\(/gm;
        while ((fm = funcExprRegex.exec(jsText)) !== null) {
            const defLine = jsText.substring(0, fm.index).split('\n').length - 1;
            addFuncInfo(fm[1], defLine);
        }

        // 3. arrow function: var/let/const xxx = (...) => 或 var/let/const xxx = arg =>
        const arrowRegex = /^(?:var|let|const)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/gm;
        while ((fm = arrowRegex.exec(jsText)) !== null) {
            const defLine = jsText.substring(0, fm.index).split('\n').length - 1;
            addFuncInfo(fm[1], defLine);
        }

        // 4. window/global assignment: window.xxx = function() / xxx.yyy = function()
        const windowFuncRegex = /^(?:window|self|globalThis)\s*\.\s*([a-zA-Z_$][\w$]*)\s*=\s*function\s*[\w$]*\s*\(/gm;
        while ((fm = windowFuncRegex.exec(jsText)) !== null) {
            const defLine = jsText.substring(0, fm.index).split('\n').length - 1;
            addFuncInfo(fm[1], defLine);
        }
    }

    return infos;
}

// ─── CodeLens Provider (above 模式) ───

export class VueCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    private cache = new Map<string, { version: number; lenses: vscode.CodeLens[] }>();
    private static readonly MAX_CACHE = 20;

    public refresh() {
        this.cache.clear();
        this._onDidChangeCodeLenses.fire();
    }

    provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.CodeLens[] | null {
        if (_token.isCancellationRequested) { return null; }

        const config = vscode.workspace.getConfiguration('leidong-tools');
        const enableRefCount = config.get<boolean>('enableCodeLens', false);
        const enableAI = config.get<boolean>('enableAIAnalysis', false);
        const pos = config.get<string>('codeLensPosition', 'above');

        // 如果两个都关了，或者不是 above 模式且 AI 没开启（AI 目前只通过 CodeLens 展示），则返回 null
        if (!enableRefCount && !enableAI) { return null; }
        if (pos !== 'above' && !enableAI) { return null; }

        const cacheKey = document.uri.toString();
        const cached = this.cache.get(cacheKey);
        if (cached && cached.version === document.version) { return cached.lenses; }

        if (_token.isCancellationRequested) { return null; }

        const infos = computeRefCounts(document);
        if (!infos) { return null; }

        const lenses: vscode.CodeLens[] = [];
        for (const info of infos) {
            const range = new vscode.Range(info.line, 0, info.line, 0);

            // 1. 引用计数按钮 (仅且仅当 enableCodeLens=true 且 pos=above)
            if (enableRefCount && pos === 'above') {
                const title = info.count > 0 ? `引用 ${info.count} 次` : '未引用';
                lenses.push(new vscode.CodeLens(range, {
                    title: `$(references) ${title}`,
                    command: info.count > 0 ? 'editor.action.findReferences' : '',
                    arguments: info.count > 0 ? [document.uri, info.loc.range.start] : undefined,
                    tooltip: `${info.category}.${info.name} - ${title}`
                }));
            }

            // 2. AI 分析按钮 (仅当 enableAIAnalysis=true)
            if (enableAI) {
                lenses.push(new vscode.CodeLens(range, {
                    title: `$(sparkle) AI 分析`,
                    command: 'leidong-tools.analyzeWithCopilot',
                    arguments: [info.name, document.uri],
                    tooltip: `使用 AI 深度分析 ${info.name}`
                }));
            }
        }

        this.cache.set(cacheKey, { version: document.version, lenses });
        // 限制缓存大小
        if (this.cache.size > VueCodeLensProvider.MAX_CACHE) {
            const oldest = this.cache.keys().next().value;
            if (oldest) { this.cache.delete(oldest); }
        }
        return lenses;
    }
}

// ─── Inline Decoration（right 模式）───

const refCountDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
        margin: '0 0 0 2em',
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
    },
    isWholeLine: false,
});

let decorationDebounce: NodeJS.Timeout | null = null;

/**
 * 更新右侧行末装饰 (right 模式)
 */
export function updateInlineRefDecorations(editor: vscode.TextEditor | undefined): void {
    if (!editor) { return; }
    const config = vscode.workspace.getConfiguration('leidong-tools');
    if (!config.get<boolean>('enableCodeLens', false)) {
        editor.setDecorations(refCountDecorationType, []);
        return;
    }
    const pos = config.get<string>('codeLensPosition', 'above');
    if (pos !== 'right') {
        editor.setDecorations(refCountDecorationType, []);
        return;
    }

    if (decorationDebounce) { clearTimeout(decorationDebounce); }
    decorationDebounce = setTimeout(() => {
        const infos = computeRefCounts(editor.document);
        if (!infos) {
            editor.setDecorations(refCountDecorationType, []);
            return;
        }

        const decorations: vscode.DecorationOptions[] = [];
        for (const info of infos) {
            const line = editor.document.lineAt(info.line);
            const label = info.count > 0 ? `  // 引用 ${info.count} 次` : '  // 未引用';
            decorations.push({
                range: new vscode.Range(info.line, line.text.length, info.line, line.text.length),
                renderOptions: {
                    after: {
                        contentText: label,
                        color: info.count > 0
                            ? new vscode.ThemeColor('editorCodeLens.foreground')
                            : new vscode.ThemeColor('editorUnnecessaryCode.opacity'),
                    }
                },
            });
        }
        editor.setDecorations(refCountDecorationType, decorations);
    }, 2000);
}

/**
 * 清除所有右侧装饰
 */
export function clearInlineRefDecorations(editor: vscode.TextEditor | undefined): void {
    if (editor) {
        editor.setDecorations(refCountDecorationType, []);
    }
}

// ─── Hover 模式：外部可调用获取引用计数 ───

/**
 * 获取指定行的引用计数信息（hover 模式用）
 */
export function getRefCountAtLine(document: vscode.TextDocument, line: number): RefCountInfo | null {
    const config = vscode.workspace.getConfiguration('leidong-tools');
    if (!config.get<boolean>('enableCodeLens', false)) { return null; }
    const pos = config.get<string>('codeLensPosition', 'above');
    if (pos !== 'hover') { return null; }

    const infos = computeRefCounts(document);
    if (!infos) { return null; }

    return infos.find(i => i.line === line) || null;
}
