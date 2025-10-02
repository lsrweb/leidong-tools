import * as vscode from 'vscode';
import { LRUCache } from '../cache/lruCache';

interface TemplateVar {
    name: string;
    location: vscode.Location; // attribute line position
    scopeStart: number; // line inclusive
    scopeEnd: number;   // line inclusive (best-effort)
}

export interface TemplateIndex {
    vars: TemplateVar[];
    version: number;
    builtAt: number;
    hash: string;
}

interface CacheEntry { index: TemplateIndex; lastAccess: number; }
function getMaxTemplateEntries(): number { try { return Math.max(10, vscode.workspace.getConfiguration('leidong-tools').get<number>('maxTemplateIndexEntries', 50)); } catch { return 50; } }
let templateIndexCache = new LRUCache<string, CacheEntry>(getMaxTemplateEntries());

function fastHash(str: string): string {
    let h = 0; for (let i = 0; i < str.length; i++) { h = (h * 33 + str.charCodeAt(i)) >>> 0; }
    return h.toString(16);
}

function loggingEnabled(): boolean {
    try {
        return vscode.workspace.getConfiguration('leidong-tools').get<boolean>('indexLogging', true) === true;
    } catch { return true; }
}

/**
 * 构建模板变量索引：解析 v-for / slot-scope / v-slot / # / scope.row 根变量
 * 近似 HTML 结构：通过简易标签栈估算作用域范围
 */
function buildTemplateIndex(doc: vscode.TextDocument): TemplateIndex {
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const vars: TemplateVar[] = [];
    interface StackItem { tag: string; startLine: number; }
    const stack: StackItem[] = [];
    const tagOpenRegex = /<([a-zA-Z0-9_-]+)([^>]*)>/g;
    const tagCloseRegex = /<\/([a-zA-Z0-9_-]+)>/g;

    const pushVar = (name: string, line: number) => {
        const loc = new vscode.Location(doc.uri, new vscode.Position(line, 0));
        // 作用域：默认到当前栈高度匹配的结束行，暂时填充，稍后回填
        vars.push({ name, location: loc, scopeStart: line, scopeEnd: lines.length - 1 });
    };

    // 首次遍历：标签与变量提取
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        // 关闭标签：回填作用域
        let mClose: RegExpExecArray | null;
        while ((mClose = tagCloseRegex.exec(line)) !== null) {
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].tag === mClose![1]) {
                    const popped = stack.splice(i, 1)[0];
                    // 更新在该作用域内声明的变量 scopeEnd
                    for (const v of vars) {
                        if (v.scopeStart >= popped.startLine && v.scopeEnd === lines.length - 1) { v.scopeEnd = lineNum; }
                    }
                    break;
                }
            }
        }
        // 开启标签 & 属性
        let mOpen: RegExpExecArray | null;
        while ((mOpen = tagOpenRegex.exec(line)) !== null) {
            const tag = mOpen[1];
            const attrStr = mOpen[2];
            stack.push({ tag, startLine: lineNum });
            if (attrStr) {
                // v-for 变体
                const vforMatch = /v-for\s*=\s*"([^"]+)"|v-for\s*=\s*'([^']+)'/.exec(attrStr);
                if (vforMatch) {
                    const expr = vforMatch[1] || vforMatch[2] || '';
                    // (item,index) in list | item in list | (item, idx) of list | {a,b} in list
                    const inMatch = /^(\([^)]*\)|\{[^}]*\}|[^\s]+)\s+(in|of)\s+/.exec(expr.trim());
                    if (inMatch) {
                        let head = inMatch[1].trim();
                        if (head.startsWith('(') && head.endsWith(')')) { head = head.slice(1, -1); }
                        if (head.startsWith('{') && head.endsWith('}')) { head = head.slice(1, -1); }
                        head.split(',').map(s => s.trim()).filter(Boolean).forEach(n => pushVar(n, lineNum));
                    }
                }
                // slot-scope / v-slot / #default="slotProps"
                const slotScopeMatch = /(slot-scope|v-slot(?::[a-zA-Z0-9_-]+)?|#[a-zA-Z0-9_-]*)\s*=\s*"([^"]+)"/.exec(attrStr) || /(slot-scope|v-slot(?::[a-zA-Z0-9_-]+)?|#[a-zA-Z0-9_-]*)\s*=\s*'([^']+)'/.exec(attrStr);
                if (slotScopeMatch) {
                    const slotExpr = slotScopeMatch[2] || slotScopeMatch[1];
                    // 可能是 { item, index } 或 单变量
                    let inner = slotExpr.trim();
                    if (inner.startsWith('{') && inner.endsWith('}')) { inner = inner.slice(1, -1); }
                    inner.split(',').map(s => s.trim()).filter(Boolean).forEach(n => pushVar(n, lineNum));
                }
            }
        }
    }

    const contentHash = fastHash(text);
    if (loggingEnabled()) { console.log(`[template-index][build] ${doc.uri.fsPath} vars=${vars.length} hash=${contentHash}`); }
    return { vars, version: doc.version, builtAt: Date.now(), hash: contentHash };
}

export function getTemplateIndex(doc: vscode.TextDocument): TemplateIndex | null {
    if (doc.languageId !== 'html') { return null; }
    const key = doc.uri.toString();
    const hash = fastHash(doc.getText());
    const cached = templateIndexCache.get(key);
    if (cached && cached.index.hash === hash && cached.index.version === doc.version) {
        cached.lastAccess = Date.now();
        if (loggingEnabled()) { console.log(`[template-index][hit] ${doc.uri.fsPath}`); }
        return cached.index;
    }
    // 不在这里自动构建，避免频繁编辑触发重建。返回 null 表示需要显式构建。
    return null;
}

export function buildAndCacheTemplateIndex(doc: vscode.TextDocument): TemplateIndex | null {
    if (doc.languageId !== 'html') { return null; }
    const idx = buildTemplateIndex(doc);
    const key = doc.uri.toString();
        templateIndexCache.set(key, { index: idx, lastAccess: Date.now() });
    return idx;
}

export function getCachedTemplateIndex(doc: vscode.TextDocument): TemplateIndex | null {
    const key = doc.uri.toString();
    const cached = templateIndexCache.get(key);
    if (cached) { cached.lastAccess = Date.now(); return cached.index; }
    return null;
}

export function removeTemplateIndex(doc: vscode.TextDocument) { templateIndexCache.delete(doc.uri.toString()); }

export function pruneTemplateIndex(maxAgeMs = 1000 * 60 * 60) {
    templateIndexCache.pruneByAge(maxAgeMs);
}

export function recreateTemplateIndexCache() { templateIndexCache = new LRUCache<string, CacheEntry>(getMaxTemplateEntries()); }

export function findTemplateVar(document: vscode.TextDocument, position: vscode.Position, name: string): vscode.Location | null {
    const idx = getTemplateIndex(document);
    if (!idx) { return null; }
    const line = position.line;
    // 局部变量优先：在 scope 范围内
    for (const v of idx.vars) {
        if (v.name === name && line >= v.scopeStart && line <= v.scopeEnd) { return v.location; }
    }
    return null;
}

export function showTemplateIndexSummary() {
    console.log('[template-index][summary] entries=' + templateIndexCache.size);
    templateIndexCache.forEach((entry, k) => { console.log(` - ${k} vars=${entry.index.vars.length}`); });
}

export function clearTemplateIndexCache() { templateIndexCache.clear(); }
