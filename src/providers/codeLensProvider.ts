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
        /(?:v-bind:|:)[\w.-]+\s*=\s*"([^"]+)"/g,
        /(?:v-on:|@)[\w.-]+\s*=\s*"([^"]+)"/g,
        /(?:v-if|v-else-if|v-show)\s*=\s*"([^"]+)"/g,
        /v-for\s*=\s*"([^"]+)"/g,
        /v-model\s*=\s*"([^"]+)"/g,
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
        if (document.languageId === 'javascript' || document.languageId === 'typescript') {
            jsText = document.getText();
            vueIndex = getOrCreateVueIndexFromContent(jsText, document.uri, 0);
            const htmlFiles = findAssociatedHtmlForJs(document.uri.fsPath);
            const htmlFileSet = new Set(htmlFiles.map(f => normalizePath(f)));
            for (const hf of htmlFiles) {
                try {
                    // 优先使用已打开的文档（获取最新编辑内容）
                    const openDoc = vscode.workspace.textDocuments.find(
                        d => normalizePath(d.uri.fsPath) === normalizePath(hf) && !d.isClosed
                    );
                    htmlText += (openDoc ? openDoc.getText() : fs.readFileSync(hf, 'utf8')) + '\n';
                } catch { /* */ }
            }
            // 补充：未被目录约定找到的、但已打开的 HTML 文档
            for (const doc of vscode.workspace.textDocuments) {
                if (doc.languageId === 'html' && !doc.isClosed
                    && !htmlFileSet.has(normalizePath(doc.uri.fsPath))) {
                    htmlText += doc.getText() + '\n';
                }
            }
        } else if (document.languageId === 'html') {
            htmlText = document.getText();
            vueIndex = resolveVueIndexForHtml(document);
            if (vueIndex) {
                const firstDef = vueIndex.data.values().next().value || vueIndex.methods.values().next().value;
                if (firstDef && firstDef.uri.fsPath !== document.uri.fsPath) {
                    try { jsText = fs.readFileSync(firstDef.uri.fsPath, 'utf8'); } catch { /* */ }
                }
            }
        }
    } catch { /* */ }

    if (!vueIndex) { return null; }

    const infos: RefCountInfo[] = [];

    const collect = (map: Map<string, vscode.Location>, category: string) => {
        map.forEach((loc, name) => {
            if (loc.uri.fsPath !== document.uri.fsPath) { return; }
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
        const funcDeclRegex = /^function\s+([a-zA-Z_$][\w$]*)\s*\(/gm;
        let fm: RegExpExecArray | null;
        const jsLines = jsText.split('\n');
        while ((fm = funcDeclRegex.exec(jsText)) !== null) {
            const funcName = fm[1];
            const defLine = jsText.substring(0, fm.index).split('\n').length - 1;
            let count = 0;
            if (htmlText) { count += countReferencesInHtml(htmlText, funcName); }
            // JS 中直接调用（不含 this.）
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
        }
    }

    return infos;
}

// ─── CodeLens Provider (above 模式) ───

export class VueCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    private cache = new Map<string, { version: number; lenses: vscode.CodeLens[] }>();

    public refresh() {
        this.cache.clear();
        this._onDidChangeCodeLenses.fire();
    }

    provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.CodeLens[] | null {
        const config = vscode.workspace.getConfiguration('leidong-tools');
        if (!config.get<boolean>('enableCodeLens', false)) { return null; }
        const pos = config.get<string>('codeLensPosition', 'above');
        if (pos !== 'above') { return null; }

        const cacheKey = document.uri.toString();
        const cached = this.cache.get(cacheKey);
        if (cached && cached.version === document.version) { return cached.lenses; }

        const infos = computeRefCounts(document);
        if (!infos) { return null; }

        const lenses: vscode.CodeLens[] = [];
        for (const info of infos) {
            const range = new vscode.Range(info.line, 0, info.line, 0);
            const title = info.count > 0 ? `引用 ${info.count} 次` : '未引用';
            lenses.push(new vscode.CodeLens(range, {
                title: `$(references) ${title}`,
                command: info.count > 0 ? 'editor.action.findReferences' : '',
                arguments: info.count > 0 ? [document.uri, info.loc.range.start] : undefined,
                tooltip: `${info.category}.${info.name} - ${title}`
            }));
        }

        this.cache.set(cacheKey, { version: document.version, lenses });
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
    }, 800);
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
