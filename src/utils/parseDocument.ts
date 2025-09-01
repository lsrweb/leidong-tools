import * as vscode from 'vscode';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as fs from 'fs';
import * as path from 'path';
import { ParseResult } from '../types';

/**
 * Vue 索引结构
 */
export interface VueIndex {
    data: Map<string, vscode.Location>;
    methods: Map<string, vscode.Location>;
    mixinData: Map<string, vscode.Location>;
    mixinMethods: Map<string, vscode.Location>;
    all: Map<string, vscode.Location>; // 合并所有
    version: number; // 文档 version
    hash: string;    // 内容 hash
    builtAt: number;
}

interface CacheEntry { index: VueIndex; }

// 内存缓存
const indexCache = new Map<string, CacheEntry>();
const MAX_INDEX_CACHE_ENTRIES = 60; // 简单上限，避免无限增长

function loggingEnabled(): boolean {
    try {
        const cfg = vscode.workspace.getConfiguration('leidong-tools');
        return cfg.get<boolean>('indexLogging', true) === true;
    } catch { return true; }
}

// 快速 hash（非安全）
function fastHash(str: string): string {
    let h = 0, i = 0, len = str.length;
    while (i < len) { h = (h * 31 + str.charCodeAt(i++)) >>> 0; }
    return h.toString(16);
}

// 清理 PHP 等干扰项
function sanitizeContent(raw: string): string {
    return raw
        .replace(/<\?(=|php)?[\s\S]*?\?>/g, m => ' '.repeat(m.length))
        .replace(/\{\{[\s\S]*?\}\}/g, m => ' '.repeat(m.length));
}

/**
 * 解析一个 JS 源（外部或内联）生成 VueIndex
 */
function buildVueIndex(jsContent: string, uri: vscode.Uri, baseLine = 0): VueIndex {
    const clean = sanitizeContent(jsContent);
    const ast = parser.parse(clean, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true });

    const data = new Map<string, vscode.Location>();
    const methods = new Map<string, vscode.Location>();
    const mixinData = new Map<string, vscode.Location>();
    const mixinMethods = new Map<string, vscode.Location>();
    const mixinVars: string[] = []; // 需要解析的变量名
    const objectVarDecls: Record<string, t.ObjectExpression> = {};
    const functionVarReturns: Record<string, t.ObjectExpression> = {}; // 变量 = 函数() { return {...} }
    const functionDeclarations: Record<string, t.ObjectExpression> = {}; // function mixin() { return {...} }

    // 收集顶层变量对象（可能用作 mixin）
    traverse(ast, {
        VariableDeclarator(p) {
            const id = p.node.id;
            const init = p.node.init;
            if (t.isIdentifier(id) && init) {
                if (t.isObjectExpression(init)) {
                    objectVarDecls[id.name] = init;
                } else if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
                    // 抓取 return { ... }
                    let obj: t.ObjectExpression | null = null;
                    if (t.isBlockStatement(init.body)) {
                        for (const st of init.body.body) {
                            if (t.isReturnStatement(st) && st.argument && t.isObjectExpression(st.argument)) {
                                obj = st.argument; break;
                            }
                        }
                    } else if (t.isObjectExpression(init.body)) {
                        obj = init.body;
                    }
                    if (obj) { functionVarReturns[id.name] = obj; }
                }
            }
        },
        FunctionDeclaration(p) {
            if (t.isIdentifier(p.node.id)) {
                // 查找 return { ... }
                for (const st of p.node.body.body) {
                    if (t.isReturnStatement(st) && st.argument && t.isObjectExpression(st.argument)) {
                        functionDeclarations[p.node.id.name] = st.argument;
                        break;
                    }
                }
            }
        }
    });

    const extractData = (node: t.Node | null | undefined, lineOffset: number, target: Map<string, vscode.Location>) => {
        if (!node) { return; }
        let obj: t.ObjectExpression | null = null;
        if (t.isObjectExpression(node)) { obj = node; }
        else if (t.isIdentifier(node)) {
            // 引用变量形式 data: dataObj
            const name = node.name;
            if (objectVarDecls[name]) { obj = objectVarDecls[name]; }
            else if (functionVarReturns[name]) { obj = functionVarReturns[name]; }
            else if (functionDeclarations[name]) { obj = functionDeclarations[name]; }
        }
        else if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node) || t.isObjectMethod(node)) {
            const body = t.isObjectMethod(node) ? node.body : node.body;
            if (t.isBlockStatement(body)) {
                for (const st of body.body) {
                    if (t.isReturnStatement(st) && st.argument && t.isObjectExpression(st.argument)) {
                        obj = st.argument; break;
                    }
                }
            } else if (!t.isObjectMethod(node) && t.isObjectExpression((node as any).body)) { // arrow 简写
                obj = (node as any).body;
            }
        } else if ((node as any).value && (t.isFunctionExpression((node as any).value) || t.isArrowFunctionExpression((node as any).value))) {
            // 传入的是 ObjectProperty，取其 value 再解析
            const val: any = (node as any).value;
            if (t.isBlockStatement(val.body)) {
                for (const st of val.body.body) {
                    if (t.isReturnStatement(st) && st.argument && t.isObjectExpression(st.argument)) { obj = st.argument; break; }
                }
            } else if (t.isObjectExpression(val.body)) { obj = val.body; }
        }
        if (!obj) { return; }
        for (const prop of obj.properties) {
            if (t.isObjectProperty(prop) && t.isIdentifier(prop.key) && prop.loc) {
                const loc = new vscode.Location(uri, new vscode.Position(lineOffset + prop.loc.start.line - 1, prop.loc.start.column));
                target.set(prop.key.name, loc);
            }
        }
    };

    const extractMethods = (node: t.Node | null | undefined, lineOffset: number, target: Map<string, vscode.Location>) => {
        if (!node || !t.isObjectExpression(node)) { return; }
        for (const prop of node.properties) {
            if (t.isObjectMethod(prop) && t.isIdentifier(prop.key) && prop.loc) {
                const loc = new vscode.Location(uri, new vscode.Position(lineOffset + prop.loc.start.line - 1, prop.loc.start.column));
                target.set(prop.key.name, loc);
            } else if (t.isObjectProperty(prop) && t.isIdentifier(prop.key) && prop.loc && (t.isFunctionExpression(prop.value) || t.isArrowFunctionExpression(prop.value))) {
                const loc = new vscode.Location(uri, new vscode.Position(lineOffset + prop.loc.start.line - 1, prop.loc.start.column));
                target.set(prop.key.name, loc);
            }
        }
    };

    // 解析 new Vue({...}) 结构
    traverse(ast, {
        NewExpression(p) {
            if (t.isIdentifier(p.node.callee) && p.node.callee.name === 'Vue') {
                const first = p.node.arguments[0];
                if (first && t.isObjectExpression(first)) {
                    for (const prop of first.properties) {
            if (!t.isObjectProperty(prop) && !t.isObjectMethod(prop)) { continue; }
                        const key = (prop as any).key; // unify
            if (!t.isIdentifier(key)) { continue; }
                        const name = key.name;
                        if (name === 'data') {
                            // 统一把 prop 传进去, extractData 会处理多种形式
                            extractData((prop as any).value ?? (t.isObjectMethod(prop) ? prop : (prop as any).value), baseLine, data);
                        } else if (name === 'methods') {
                            extractMethods((prop as any).value ?? prop, baseLine, methods);
                        } else if (name === 'mixins') {
                            // mixins: [mixinA, mixinB]
                            const value = (prop as any).value;
                            if (value && t.isArrayExpression(value)) {
                value.elements.forEach(el => { if (t.isIdentifier(el)) { mixinVars.push(el.name); } });
                            }
                        }
                    }
                }
            }
        }
    });

    // 解析 mixin 变量对象
    for (const mixinVar of mixinVars) {
        const obj = objectVarDecls[mixinVar] || functionVarReturns[mixinVar] || functionDeclarations[mixinVar];
        if (!obj) { continue; }
        // mixin 对象自身可能直接包含 data/methods
        for (const prop of obj.properties) {
            if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
                const name = prop.key.name;
                if (name === 'data') {
                    extractData((prop as any).value ?? (t.isObjectMethod(prop) ? prop : (prop as any).value), baseLine, mixinData);
                } else if (name === 'methods') {
                    extractMethods(prop.value, baseLine, mixinMethods);
                }
            }
        }
    }

    const all = new Map<string, vscode.Location>();
    for (const m of [data, methods, mixinData, mixinMethods]) {
        m.forEach((loc, k) => { if (!all.has(k)) { all.set(k, loc); } });
    }

    return {
        data, methods, mixinData, mixinMethods, all,
        version: 0,
        hash: fastHash(jsContent),
        builtAt: Date.now()
    };
}

/**
 * 获取（或构建）某个 JS 源的 VueIndex，带缓存
 */
export function getOrCreateVueIndexFromContent(content: string, uri: vscode.Uri, baseLine = 0): VueIndex {
    const key = uri.toString();
    const hash = fastHash(content);
    const cached = indexCache.get(key);
    if (cached && cached.index.hash === hash) {
        if (loggingEnabled()) { console.log(`[vue-index][hit] ${uri.fsPath} hash=${hash} data=${cached.index.data.size} methods=${cached.index.methods.size} mixinData=${cached.index.mixinData.size} mixinMethods=${cached.index.mixinMethods.size}`); }
        return cached.index;
    }
    const index = buildVueIndex(content, uri, baseLine);
    indexCache.set(key, { index });
    // LRU 简化：超过上限移除最早插入
    if (indexCache.size > MAX_INDEX_CACHE_ENTRIES) {
        const firstKey = indexCache.keys().next().value;
        if (firstKey) { indexCache.delete(firstKey); }
    }
    if (loggingEnabled()) { console.log(`[vue-index][build] ${uri.fsPath} hash=${index.hash} data=${index.data.size} methods=${index.methods.size} mixinData=${index.mixinData.size} mixinMethods=${index.mixinMethods.size}`); }
    return index;
}

/**
 * 针对当前激活文档（JS/TS）生成补全所需的 ParseResult
 */
export async function parseDocument(document: vscode.TextDocument): Promise<ParseResult | null> {
    try {
        if (document.languageId !== 'javascript' && document.languageId !== 'typescript') {
            return null;
        }
        const text = document.getText();
        const index = getOrCreateVueIndexFromContent(text, document.uri, 0);

        const variables: vscode.CompletionItem[] = [];
        const methods: vscode.CompletionItem[] = [];
        const thisReferences: Map<string, vscode.CompletionItem> = new Map();

        index.data.forEach((_loc, name) => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
            item.detail = 'data 属性 (雷动三千)';
            variables.push(item);
            thisReferences.set(name, item);
        });
        index.methods.forEach((_loc, name) => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
            item.detail = 'methods 方法 (雷动三千)';
            methods.push(item);
            thisReferences.set(name, item);
        });
        index.mixinData.forEach((_loc, name) => {
            if (!thisReferences.has(name)) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
                item.detail = 'mixin data (雷动三千)';
                variables.push(item);
                thisReferences.set(name, item);
            }
        });
        index.mixinMethods.forEach((_loc, name) => {
            if (!thisReferences.has(name)) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
                item.detail = 'mixin method (雷动三千)';
                methods.push(item);
                thisReferences.set(name, item);
            }
        });

        return { variables, methods, timestamp: Date.now(), thisReferences };
    } catch (e) {
        console.error('[parseDocument] error', e);
        return null;
    }
}

/**
 * 根据 HTML 文档查找外部 js (./js/同名.dev.js) 或内联 new Vue 代码，返回 VueIndex
 */
// 外部文件索引缓存（避免频繁读磁盘）
interface ExternalFileCacheEntry { mtimeMs: number; hash: string; index: VueIndex; }
const externalFileCache = new Map<string, ExternalFileCacheEntry>();

function getExternalFileIndex(fullPath: string): VueIndex | null {
    try {
        const stat = fs.statSync(fullPath);
        const cached = externalFileCache.get(fullPath);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
            if (loggingEnabled()) { console.log(`[vue-index][external-hit] ${fullPath} mtime=${stat.mtimeMs}`); }
            return cached.index;
        }
        const content = fs.readFileSync(fullPath, 'utf8');
        const index = getOrCreateVueIndexFromContent(content, vscode.Uri.file(fullPath), 0);
        externalFileCache.set(fullPath, { mtimeMs: stat.mtimeMs, hash: index.hash, index });
    if (loggingEnabled()) { console.log(`[vue-index][external-build] ${fullPath} mtime=${stat.mtimeMs} hash=${index.hash}`); }
        return index;
    } catch { return null; }
}

export function resolveVueIndexForHtml(document: vscode.TextDocument): VueIndex | null {
    const htmlPath = document.uri.fsPath;
    const dir = path.dirname(htmlPath);
    const base = path.basename(htmlPath, path.extname(htmlPath));
    // 递归搜索 js/**/同名.dev.js (深度优先, 首个匹配即返回)
    const jsRoot = path.join(dir, 'js');
    const targetFileName = `${base}.dev.js`;
    if (fs.existsSync(jsRoot)) {
        const stack: string[] = [jsRoot];
        while (stack.length) {
            const current = stack.pop()!;
            try {
                const entries = fs.readdirSync(current, { withFileTypes: true });
                for (const ent of entries) {
                    const full = path.join(current, ent.name);
                    if (ent.isDirectory()) {
                        stack.push(full);
                    } else if (ent.isFile() && ent.name === targetFileName) {
                        const extIdx = getExternalFileIndex(full);
                        if (extIdx) { return extIdx; }
                        return null;
                    }
                }
            } catch (e) { /* ignore directory read errors */ }
        }
    }
    // 查找内联 <script> new Vue({...})
    const text = document.getText();
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    while ((match = scriptRegex.exec(text)) !== null) {
        const content = match[1];
        if (/new\s+Vue\s*\(/.test(content)) {
            const startPos = document.positionAt(match.index + match[0].indexOf('>') + 1);
            return getOrCreateVueIndexFromContent(content, document.uri, startPos.line);
        }
    }
    return null;
}

/**
 * 查询变量 / 方法 定义位置
 */
export function findDefinitionInIndex(name: string, index: VueIndex): vscode.Location | null {
    // 优先顺序：data > mixinData > methods > mixinMethods
    if (index.data.has(name)) { return index.data.get(name)!; }
    if (index.mixinData.has(name)) { return index.mixinData.get(name)!; }
    if (index.methods.has(name)) { return index.methods.get(name)!; }
    if (index.mixinMethods.has(name)) { return index.mixinMethods.get(name)!; }
    return index.all.get(name) || null;
}

/**
 * 处理链式访问 this.xxx.yyy / that.xxx.yyy 时根标识符优先解析
 */
export function findChainedRootDefinition(chainText: string, index: VueIndex): vscode.Location | null {
    const parts = chainText.split('.').filter(Boolean);
    if (parts.length === 0) { return null; }
    // 根 token 可能是 this / that
    if (parts[0] === 'this' || parts[0] === 'that') {
        if (parts.length >= 2) {
            return findDefinitionInIndex(parts[1], index);
        }
        return null;
    }
    return findDefinitionInIndex(parts[0], index);
}

/**
 * 清空缓存（可在需要时暴露命令）
 */
export function clearVueIndexCache() { indexCache.clear(); }
// 供调试：打印当前缓存概览
export function logVueIndexCacheSummary() {
    console.log(`[vue-index][summary] entries=${indexCache.size} (logging=${loggingEnabled()})`);
    for (const [k, v] of indexCache.entries()) {
        console.log(`  - ${k} data=${v.index.data.size} methods=${v.index.methods.size} mixinData=${v.index.mixinData.size} mixinMethods=${v.index.mixinMethods.size}`);
    }
}

