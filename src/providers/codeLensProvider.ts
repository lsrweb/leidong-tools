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
 * 批量统计 HTML 文本中所有已知标识符的引用次数。
 * 单次扫描，复杂度由 O(n_names × n_patterns × n_chars) 降至 O(n_patterns × n_chars)。
 */
function batchCountReferencesInHtml(text: string, names: ReadonlySet<string>): Map<string, number> {
    const counts = new Map<string, number>();
    if (!text || names.size === 0) { return counts; }
    names.forEach(n => counts.set(n, 0));

    const bump = (expr: string) => {
        const re = /\b([a-zA-Z_$][\w$]*)\b/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(expr)) !== null) {
            const c = counts.get(m[1]);
            if (c !== undefined) { counts.set(m[1], c + 1); }
        }
    };

    let m: RegExpExecArray | null;
    const mustacheRe = /\{\{([\s\S]*?)\}\}/g;
    while ((m = mustacheRe.exec(text)) !== null) { bump(m[1]); }

    const attrPats: RegExp[] = [
        /(?:v-bind:|:)[\w.-]+\s*=\s*"([^"]+)"/g,
        /(?:v-on:|@)[\w.-]+\s*=\s*"([^"]+)"/g,
        /(?:v-if|v-else-if|v-show)\s*=\s*"([^"]+)"/g,
        /v-for\s*=\s*"([^"]+)"/g,
        /v-model\s*=\s*"([^"]+)"/g,
        /(?:v-bind:|:)[\w.-]+\s*=\s*'([^']+)'/g,
        /(?:v-on:|@)[\w.-]+\s*=\s*'([^']+)'/g,
        /(?:v-if|v-else-if|v-show)\s*=\s*'([^']+)'/g,
        /v-for\s*=\s*'([^']+)'/g,
        /v-model\s*=\s*'([^']+)'/g,
        /\bon\w+\s*=\s*"([^"]+)"/gi,
        /\bon\w+\s*=\s*'([^']+)'/gi,
    ];
    for (const pat of attrPats) {
        pat.lastIndex = 0;
        while ((m = pat.exec(text)) !== null) { bump(m[1]); }
    }
    return counts;
}

/**
 * 从 JS 文本中提取 Vue 内联 template: `...` 的模板内容。
 * 这里只处理最常见的反引号模板，足够覆盖 Vue.component / new Vue 场景。
 */
function extractInlineTemplateBlocks(text: string): string[] {
    const blocks: string[] = [];
    if (!text) { return blocks; }

    const templateRe = /template\s*:\s*`/g;
    let m: RegExpExecArray | null;
    while ((m = templateRe.exec(text)) !== null) {
        const backtickStart = m.index + m[0].length - 1;
        let i = backtickStart + 1;
        let exprDepth = 0;

        while (i < text.length) {
            const ch = text[i];
            if (ch === '\\') { i += 2; continue; }
            if (ch === '$' && i + 1 < text.length && text[i + 1] === '{') {
                exprDepth++;
                i += 2;
                continue;
            }
            if (ch === '}' && exprDepth > 0) {
                exprDepth--;
                i++;
                continue;
            }
            if (ch === '`' && exprDepth === 0) {
                blocks.push(text.substring(backtickStart + 1, i));
                templateRe.lastIndex = i + 1;
                break;
            }
            i++;
        }
    }

    return blocks;
}

/**
 * 批量统计 JS 文本中的引用次数，单次扫描完成两类计数：
 *  - Vue 成员：this.xxx / that.xxx 等
 *  - 全局函数：name( 且不以 . 开头
 */
function batchCountReferencesInJs(
    text: string,
    vueNames: ReadonlySet<string>,
    vueDefLines: ReadonlyMap<string, number>,
    funcNames: ReadonlySet<string>,
    funcDefLines: ReadonlyMap<string, number>
): { vueCounts: Map<string, number>; funcCounts: Map<string, number> } {
    const vueCounts = new Map<string, number>();
    const funcCounts = new Map<string, number>();
    if (!text) { return { vueCounts, funcCounts }; }
    vueNames.forEach(n => vueCounts.set(n, 0));
    funcNames.forEach(n => funcCounts.set(n, 0));

    const lines = text.split('\n');
    const thisAccessRe = /(?:this|that|_this|self|_self|vm|_vm|me|ctx|app)\.([a-zA-Z_$][\w$]*)\b/g;
    // 全局函数调用：name( 不被 . 或单词字符前置
    const funcCallRe = /(?<![.\w])([a-zA-Z_$][\w$]*)\s*\(/g;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        thisAccessRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = thisAccessRe.exec(line)) !== null) {
            const n = m[1];
            const c = vueCounts.get(n);
            if (c !== undefined && vueDefLines.get(n) !== i) { vueCounts.set(n, c + 1); }
        }
        if (funcNames.size > 0) {
            funcCallRe.lastIndex = 0;
            while ((m = funcCallRe.exec(line)) !== null) {
                const n = m[1];
                const c = funcCounts.get(n);
                if (c !== undefined && funcDefLines.get(n) !== i) { funcCounts.set(n, c + 1); }
            }
        }
    }

    // 额外统计同一 JS 文件中的内联 template: `...` 引用。
    // 这能把 Vue.component / new Vue 里的 {{ displayText }} 也算进去。
    const inlineTemplates = extractInlineTemplateBlocks(text);
    if (inlineTemplates.length > 0) {
        for (const tpl of inlineTemplates) {
            const tplCounts = batchCountReferencesInHtml(tpl, vueNames);
            tplCounts.forEach((count, name) => {
                const current = vueCounts.get(name);
                if (current !== undefined) {
                    vueCounts.set(name, current + count);
                }
            });
        }
    }

    return { vueCounts, funcCounts };
}

/** 预计算行首偏移量数组（O(n)），后续 charIdxToLine 为 O(log n) */
function buildLineOffsets(text: string): number[] {
    const offsets = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) { offsets.push(i + 1); }
    }
    return offsets;
}

/** 二分查找字符偏移量对应的行号（0-based） */
function charIdxToLine(lineOffsets: number[], idx: number): number {
    let lo = 0, hi = lineOffsets.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (lineOffsets[mid] <= idx) { lo = mid; } else { hi = mid - 1; }
    }
    return lo;
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
 * 计算文档中所有 Vue 成员的引用次数（批量单次扫描版）
 */
export function computeRefCounts(document: vscode.TextDocument): RefCountInfo[] | null {
    let vueIndex: VueIndex | null = null;
    let htmlText = '';
    let jsText = '';
    let hasInlineTemplate = false;
    let htmlFiles: string[] = [];

    try {
        if (document.languageId === 'javascript' || document.languageId === 'typescript' || document.languageId === 'vue') {
            jsText = document.getText();
            vueIndex = getOrCreateVueIndexFromContent(jsText, document.uri, 0);
            hasInlineTemplate = /template\s*:\s*`/.test(jsText);

            // JS/TS 内联模板组件只统计本文件内的模板引用，避免把关联 HTML 页面的同名引用混进来。
            if (!hasInlineTemplate) {
                // 找关联 HTML (只查找已知关联的文件，不遍历所有打开的文档)
                htmlFiles = findAssociatedHtmlForJs(document.uri.fsPath);
                for (const hf of htmlFiles) {
                    try {
                        const openDoc = vscode.workspace.textDocuments.find(
                            d => normalizePath(d.uri.fsPath) === normalizePath(hf) && !d.isClosed
                        );
                        htmlText += (openDoc ? openDoc.getText() : fs.readFileSync(hf, 'utf8')) + '\n';
                    } catch { /* */ }
                }
            }

            // 回退：当 JS 文件自身解析的 VueIndex 为空时，通过关联 HTML 间接获取
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
                    jsText = document.getText();
                }
            }
        }
    } catch { /* */ }

    if (!vueIndex) { return null; }

    const normalizedCurrentPath = normalizePath(document.uri.fsPath);

    // ── 1. 收集所有 Vue 成员（去重，按优先级顺序） ──
    const vueMemberNames = new Set<string>();
    const vueMemberDefLines = new Map<string, number>();
    const vueEntries: Array<{ name: string; category: string; loc: vscode.Location }> = [];
    const seenVue = new Set<string>();

    const registerMap = (map: Map<string, vscode.Location>, category: string) => {
        map.forEach((loc, name) => {
            if (normalizePath(loc.uri.fsPath) !== normalizedCurrentPath) { return; }
            if (seenVue.has(name)) { return; }
            seenVue.add(name);
            vueMemberNames.add(name);
            vueMemberDefLines.set(name, loc.range.start.line);
            vueEntries.push({ name, category, loc });
        });
    };

    registerMap(vueIndex.props, 'props');
    registerMap(vueIndex.data, 'data');
    registerMap(vueIndex.mixinData, 'mixin data');
    registerMap(vueIndex.computed, 'computed');
    registerMap(vueIndex.mixinComputed, 'mixin computed');
    registerMap(vueIndex.methods, 'methods');
    registerMap(vueIndex.mixinMethods, 'mixin methods');
    registerMap(vueIndex.filters, 'filters');

    // ── 2. 收集全局函数定义（O(log n) 行号查找，不再 split 字符串） ──
    const funcEntries: Array<{ name: string; defLine: number }> = [];
    const funcNames = new Set<string>();
    const funcDefLines = new Map<string, number>();

    if (jsText) {
        const lineOffsets = buildLineOffsets(jsText);
        const addFunc = (name: string, matchIdx: number) => {
            if (vueMemberNames.has(name) || funcNames.has(name)) { return; }
            const defLine = charIdxToLine(lineOffsets, matchIdx);
            funcNames.add(name);
            funcDefLines.set(name, defLine);
            funcEntries.push({ name, defLine });
        };

        let fm: RegExpExecArray | null;
        const funcDeclRe = /^function\s+([a-zA-Z_$][\w$]*)\s*\(/gm;
        while ((fm = funcDeclRe.exec(jsText)) !== null) { addFunc(fm[1], fm.index); }
        const funcExprRe = /^(?:var|let|const)\s+([a-zA-Z_$][\w$]*)\s*=\s*function\s*[\w$]*\s*\(/gm;
        while ((fm = funcExprRe.exec(jsText)) !== null) { addFunc(fm[1], fm.index); }
        const arrowRe = /^(?:var|let|const)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/gm;
        while ((fm = arrowRe.exec(jsText)) !== null) { addFunc(fm[1], fm.index); }
        const windowRe = /^(?:window|self|globalThis)\s*\.\s*([a-zA-Z_$][\w$]*)\s*=\s*function\s*[\w$]*\s*\(/gm;
        while ((fm = windowRe.exec(jsText)) !== null) { addFunc(fm[1], fm.index); }
    }

    // ── 3. 单次批量扫描 HTML + JS ──
    const allHtmlNames = new Set([...vueMemberNames, ...funcNames]);
    const htmlCounts = batchCountReferencesInHtml(htmlText, allHtmlNames);
    const { vueCounts, funcCounts } = batchCountReferencesInJs(
        jsText, vueMemberNames, vueMemberDefLines, funcNames, funcDefLines
    );

    // ── 4. 构建结果列表 ──
    const infos: RefCountInfo[] = [];
    for (const { name, category, loc } of vueEntries) {
        const count = (htmlCounts.get(name) ?? 0) + (vueCounts.get(name) ?? 0);
        infos.push({ name, category, count, line: loc.range.start.line, loc });
    }
    for (const { name, defLine } of funcEntries) {
        const count = (htmlCounts.get(name) ?? 0) + (funcCounts.get(name) ?? 0);
        const defPos = new vscode.Position(defLine, 0);
        const loc = new vscode.Location(document.uri, new vscode.Range(defPos, defPos));
        infos.push({ name, category: 'function', count, line: defLine, loc });
    }

    return infos;
}

// ─── CodeLens Provider (above 模式) ───

export class VueCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    /** uri → { version, lenses } */
    private cache = new Map<string, { version: number; lenses: vscode.CodeLens[] }>();
    /** uri → pending compute timer */
    private computeTimers = new Map<string, NodeJS.Timeout>();
    private static readonly MAX_CACHE = 20;
    /** 防抖延迟：编辑停止后 400 ms 才开始计算 */
    private static readonly DEBOUNCE_MS = 400;

    public refresh() {
        this.computeTimers.forEach(t => clearTimeout(t));
        this.computeTimers.clear();
        this.cache.clear();
        this._onDidChangeCodeLenses.fire();
    }

    provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.CodeLens[] | null {
        if (token.isCancellationRequested) { return null; }

        const config = vscode.workspace.getConfiguration('leidong-tools');
        const enableRefCount = config.get<boolean>('enableCodeLens', false);
        const enableAI = config.get<boolean>('enableAIAnalysis', false);
        const pos = config.get<string>('codeLensPosition', 'above');

        if (!enableRefCount && !enableAI) { return null; }
        if (pos !== 'above' && !enableAI) { return null; }

        const cacheKey = document.uri.toString();
        const cached = this.cache.get(cacheKey);

        // 缓存命中 → 立即返回，不阻塞主线程
        if (cached && cached.version === document.version) { return cached.lenses; }

        // 缓存未命中 → 返回旧结果（或空数组），同时安排异步计算
        const stale = cached ? cached.lenses : [];
        this._scheduleCompute(document, cacheKey, enableRefCount, enableAI, pos);
        return stale;
    }

    private _scheduleCompute(
        document: vscode.TextDocument,
        cacheKey: string,
        enableRefCount: boolean,
        enableAI: boolean,
        pos: string
    ): void {
        // 已有定时器则先取消（防抖）
        const existing = this.computeTimers.get(cacheKey);
        if (existing) { clearTimeout(existing); }

        const docVersion = document.version;
        const timer = setTimeout(() => {
            this.computeTimers.delete(cacheKey);

            // 文档已变化则放弃（下次 provideCodeLenses 会重新调度）
            if (document.isClosed || document.version !== docVersion) { return; }

            const infos = computeRefCounts(document);
            if (!infos) { return; }

            const lenses = this._buildLenses(infos, enableRefCount, enableAI, pos, document.uri);
            this.cache.set(cacheKey, { version: docVersion, lenses });
            if (this.cache.size > VueCodeLensProvider.MAX_CACHE) {
                const oldest = this.cache.keys().next().value;
                if (oldest) { this.cache.delete(oldest); }
            }
            // 通知 VS Code 重新请求 CodeLens（此时会从缓存中命中，立即返回）
            this._onDidChangeCodeLenses.fire();
        }, VueCodeLensProvider.DEBOUNCE_MS);

        this.computeTimers.set(cacheKey, timer);
    }

    private _buildLenses(
        infos: RefCountInfo[],
        enableRefCount: boolean,
        enableAI: boolean,
        pos: string,
        uri: vscode.Uri
    ): vscode.CodeLens[] {
        const lenses: vscode.CodeLens[] = [];
        for (const info of infos) {
            const range = new vscode.Range(info.line, 0, info.line, 0);
            if (enableRefCount && pos === 'above') {
                const title = info.count > 0 ? `引用 ${info.count} 次` : '未引用';
                lenses.push(new vscode.CodeLens(range, {
                    title: `$(references) ${title}`,
                    command: info.count > 0 ? 'editor.action.findReferences' : '',
                    arguments: info.count > 0 ? [uri, info.loc.range.start] : undefined,
                    tooltip: `${info.category}.${info.name} - ${title}`
                }));
            }
            if (enableAI) {
                lenses.push(new vscode.CodeLens(range, {
                    title: `$(sparkle) AI 分析`,
                    command: 'leidong-tools.analyzeWithCopilot',
                    arguments: [info.name, uri],
                    tooltip: `使用 AI 深度分析 ${info.name}`
                }));
            }
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
