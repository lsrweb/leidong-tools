import * as vscode from 'vscode';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as fs from 'fs';
import * as path from 'path';
import { LRUCache } from '../cache/lruCache';
import { ParseResult } from '../types';

/**
 * Vue 索引结构
 */
export interface VueIndex {
    data: Map<string, vscode.Location>;
    methods: Map<string, vscode.Location>;
    computed: Map<string, vscode.Location>;
    mixinData: Map<string, vscode.Location>;
    mixinMethods: Map<string, vscode.Location>;
    mixinComputed: Map<string, vscode.Location>;
    all: Map<string, vscode.Location>; // 合并所有
    dataMeta: Map<string, { doc?: string }>;
    methodMeta: Map<string, { params: string[]; doc?: string }>;
    computedMeta: Map<string, { params: string[]; doc?: string }>;
    version: number; // 文档 version
    hash: string;    // 内容 hash
    builtAt: number;
    componentsByTemplateId?: Map<string, VueIndex>; // key: x-template id
}

interface CacheEntry { index: VueIndex; }
let lastVueIndexBuiltAt = 0;
let lastExternalIndexBuiltAt = 0;

// 使用 LRU 缓存
function getMaxIndexEntries(): number {
    try { return Math.max(10, vscode.workspace.getConfiguration('leidong-tools').get<number>('maxIndexEntries', 60)); } catch { return 60; }
}
let indexCache = new LRUCache<string, CacheEntry>(getMaxIndexEntries());

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

function maskInjectedTemplate(match: string): string {
    let replaced = false;
    const chars = match.split('');
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === '\r' || ch === '\n') {
            continue;
        }
        if (!replaced) {
            chars[i] = '0';
            replaced = true;
        } else {
            chars[i] = ' ';
        }
    }
    return replaced ? chars.join('') : match;
}

// 清理 PHP 等干扰项
function sanitizeContent(raw: string): string {
    return raw
        .replace(/<\?(=|php)?[\s\S]*?\?>/g, maskInjectedTemplate)
        .replace(/\{\{[\s\S]*?\}\}/g, maskInjectedTemplate);
}

/**
 * 解析一个 JS 源（外部或内联）生成 VueIndex
 */
function buildVueIndex(jsContent: string, uri: vscode.Uri, baseLine = 0): VueIndex {
    const clean = sanitizeContent(jsContent);
    const ast = parser.parse(clean, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true });

    const contentHash = fastHash(jsContent);
    const sourceLines = jsContent.split(/\r?\n/);
    const data = new Map<string, vscode.Location>();
    const methods = new Map<string, vscode.Location>();
    const computed = new Map<string, vscode.Location>();
    const mixinData = new Map<string, vscode.Location>();
    const mixinMethods = new Map<string, vscode.Location>();
    const mixinComputed = new Map<string, vscode.Location>();
    const dataMeta = new Map<string, { doc?: string }>();
    const methodMeta = new Map<string, { params: string[]; doc?: string }>();
    const computedMeta = new Map<string, { params: string[]; doc?: string }>();
    const componentsByTemplateId = new Map<string, VueIndex>();
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

    const createIndexShell = (): VueIndex => ({
        data: new Map<string, vscode.Location>(),
        methods: new Map<string, vscode.Location>(),
        computed: new Map<string, vscode.Location>(),
        mixinData: new Map<string, vscode.Location>(),
        mixinMethods: new Map<string, vscode.Location>(),
        mixinComputed: new Map<string, vscode.Location>(),
        all: new Map<string, vscode.Location>(),
        dataMeta: new Map<string, { doc?: string }>(),
        methodMeta: new Map<string, { params: string[]; doc?: string }>(),
        computedMeta: new Map<string, { params: string[]; doc?: string }>(),
        version: 0,
        hash: contentHash,
        builtAt: Date.now()
    });

    const mergeAllMaps = (index: VueIndex) => {
        for (const m of [index.data, index.computed, index.methods, index.mixinData, index.mixinComputed, index.mixinMethods]) {
            m.forEach((loc, k) => { if (!index.all.has(k)) { index.all.set(k, loc); } });
        }
    };

    const extractData = (
        node: t.Node | null | undefined,
        lineOffset: number,
        target: Map<string, vscode.Location>,
        metaTarget?: Map<string, { doc?: string }>
    ) => {
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
            if (t.isObjectProperty(prop) && prop.loc) {
                const name = getPropertyName(prop.key);
                if (!name) { continue; }
                const loc = new vscode.Location(uri, new vscode.Position(lineOffset + prop.loc.start.line - 1, prop.loc.start.column));
                target.set(name, loc);
                const doc = getDocForDataProperty(prop);
                if (doc && metaTarget && !metaTarget.has(name)) {
                    metaTarget.set(name, { doc });
                }
            }
        }
    };

    const normalizeComment = (value: string): string => {
        const lines = value.split(/\r?\n/).map(line => line.replace(/^\s*\*? ?/, '').trimEnd());
        return lines.join('\n').trim();
    };

    const formatJSDoc = (value: string): string | undefined => {
        const rawLines = normalizeComment(value).split(/\r?\n/).map(line => line.trim());
        if (rawLines.length === 0) { return undefined; }
        const summaryLines: string[] = [];
        const params: Array<{ name: string; type?: string; desc?: string }> = [];
        let returns: { type?: string; desc?: string } | null = null;
        const extraLines: string[] = [];
        let inExample = false;
        const exampleLines: string[] = [];

        for (const line of rawLines) {
            if (!line) {
                if (inExample) { exampleLines.push(''); }
                continue;
            }
            if (line.startsWith('@example')) {
                inExample = true;
                const rest = line.replace('@example', '').trim();
                if (rest) { exampleLines.push(rest); }
                continue;
            }
            if (inExample) {
                exampleLines.push(line);
                continue;
            }
            if (line.startsWith('@param')) {
                const match = /@param\s+(?:\{([^}]+)\}\s+)?([^\s]+)?\s*(.*)/.exec(line);
                if (match) {
                    params.push({
                        type: match[1],
                        name: match[2] || 'param',
                        desc: match[3]?.trim()
                    });
                }
                continue;
            }
            if (line.startsWith('@returns') || line.startsWith('@return')) {
                const match = /@returns?\s+(?:\{([^}]+)\}\s+)?(.*)/.exec(line);
                if (match) {
                    returns = {
                        type: match[1],
                        desc: match[2]?.trim()
                    };
                }
                continue;
            }
            if (line.startsWith('@')) {
                extraLines.push(line);
                continue;
            }
            summaryLines.push(line);
        }

        const parts: string[] = [];
        if (summaryLines.length > 0) {
            parts.push(summaryLines.join('\n'));
        }
        if (params.length > 0) {
            const paramLines = params.map(param => {
                const typeText = param.type ? ` (${param.type})` : '';
                const descText = param.desc ? ` - ${param.desc}` : '';
                return `- \`${param.name}\`${typeText}${descText}`;
            });
            parts.push(`**Parameters**\n${paramLines.join('\n')}`);
        }
        if (returns) {
            const typeText = returns.type ? `(${returns.type}) ` : '';
            const descText = returns.desc ? `${returns.desc}` : '';
            const line = `- ${typeText}${descText}`.trim();
            parts.push(`**Returns**\n${line}`);
        }
        if (exampleLines.length > 0) {
            parts.push(`**Example**\n\`\`\`js\n${exampleLines.join('\n')}\n\`\`\``);
        }
        if (extraLines.length > 0) {
            parts.push(extraLines.join('\n'));
        }

        const result = parts.join('\n\n').trim();
        return result || undefined;
    };

    const formatLineComments = (comments: t.Comment[]): string | undefined => {
        const lines = comments.map(comment => comment.value.trim()).filter(Boolean);
        if (lines.length === 0) { return undefined; }
        return lines.join('\n');
    };

    const getDocFromComments = (comments?: t.Comment[]): string | undefined => {
        if (!comments || comments.length === 0) { return undefined; }
        const tailLineComments: t.Comment[] = [];
        for (let i = comments.length - 1; i >= 0; i--) {
            const comment = comments[i];
            if (comment.type === 'CommentLine') {
                tailLineComments.unshift(comment);
            } else {
                break;
            }
        }
        if (tailLineComments.length > 0) {
            return formatLineComments(tailLineComments);
        }
        const last = comments[comments.length - 1];
        if (last.type === 'CommentBlock') {
            const trimmed = last.value.trim();
            if (trimmed.startsWith('*') || trimmed.includes('@')) {
                return formatJSDoc(last.value);
            }
            const text = normalizeComment(last.value || '');
            return text || undefined;
        }
        return undefined;
    };

    const findLineCommentIndex = (line: string, startIndex = 0): number => {
        let inSingle = false;
        let inDouble = false;
        let inTemplate = false;
        let escaped = false;

        for (let i = 0; i < line.length - 1; i++) {
            const ch = line[i];
            const next = line[i + 1];

            if (escaped) {
                escaped = false;
                continue;
            }
            if (inSingle) {
                if (ch === '\\') { escaped = true; }
                else if (ch === '\'') { inSingle = false; }
                continue;
            }
            if (inDouble) {
                if (ch === '\\') { escaped = true; }
                else if (ch === '"') { inDouble = false; }
                continue;
            }
            if (inTemplate) {
                if (ch === '\\') { escaped = true; }
                else if (ch === '`') { inTemplate = false; }
                continue;
            }

            if (ch === '\'') { inSingle = true; continue; }
            if (ch === '"') { inDouble = true; continue; }
            if (ch === '`') { inTemplate = true; continue; }
            if (ch === '/' && next === '/' && i >= startIndex) {
                return i;
            }
        }
        return -1;
    };

    const getInlineLineComment = (line: string, startIndex = 0): string | undefined => {
        const idx = findLineCommentIndex(line, startIndex);
        if (idx < 0) { return undefined; }
        const text = line.slice(idx + 2).trim();
        return text || undefined;
    };

    const getDocFromProp = (prop: t.ObjectMethod | t.ObjectProperty): string | undefined => {
        const readComments = (comments?: t.Comment[] | null): string | undefined => {
            if (!comments || comments.length === 0) { return undefined; }
            return getDocFromComments(comments);
        };
        const leading = readComments(prop.leadingComments)
            || (t.isObjectProperty(prop) ? readComments((prop.value as any)?.leadingComments) : undefined);
        if (leading) { return leading; }
        const trailing = readComments(prop.trailingComments)
            || (t.isObjectProperty(prop) ? readComments((prop.value as any)?.trailingComments) : undefined);
        return trailing;
    };

    const getDocForDataProperty = (prop: t.ObjectProperty): string | undefined => {
        if (prop.loc) {
            const lineIndex = prop.loc.start.line - 1;
            const line = sourceLines[lineIndex] || '';
            const inlineDoc = getInlineLineComment(line, prop.loc.start.column);
            if (inlineDoc) { return inlineDoc; }
        }
        return undefined;
    };

    const paramToString = (param: t.Node): string => {
        if (t.isIdentifier(param)) { return param.name; }
        if (t.isRestElement(param)) { return `...${paramToString(param.argument)}`; }
        if (t.isAssignmentPattern(param)) { return `${paramToString(param.left)}=?`; }
        if (t.isObjectPattern(param)) { return '{...}'; }
        if (t.isArrayPattern(param)) { return '[...]'; }
        return 'param';
    };

    const extractParams = (params: t.Node[]): string[] => params.map(paramToString);

    const recordFunctionMeta = (
        name: string,
        params: t.Node[],
        doc: string | undefined,
        target?: Map<string, { params: string[]; doc?: string }>
    ) => {
        if (!target || target.has(name)) { return; }
        target.set(name, { params: extractParams(params), doc });
    };

    const extractMethods = (
        node: t.Node | null | undefined,
        lineOffset: number,
        target: Map<string, vscode.Location>,
        metaTarget?: Map<string, { params: string[]; doc?: string }>
    ) => {
        if (!node || !t.isObjectExpression(node)) { return; }
        for (const prop of node.properties) {
            if (t.isObjectMethod(prop) && t.isIdentifier(prop.key) && prop.loc) {
                const loc = new vscode.Location(uri, new vscode.Position(lineOffset + prop.loc.start.line - 1, prop.loc.start.column));
                target.set(prop.key.name, loc);
                recordFunctionMeta(prop.key.name, prop.params, getDocFromProp(prop), metaTarget);
            } else if (t.isObjectProperty(prop) && t.isIdentifier(prop.key) && prop.loc && (t.isFunctionExpression(prop.value) || t.isArrowFunctionExpression(prop.value))) {
                const loc = new vscode.Location(uri, new vscode.Position(lineOffset + prop.loc.start.line - 1, prop.loc.start.column));
                target.set(prop.key.name, loc);
                recordFunctionMeta(prop.key.name, prop.value.params, getDocFromProp(prop), metaTarget);
            }
        }
    };

    const extractComputed = (
        node: t.Node | null | undefined,
        lineOffset: number,
        target: Map<string, vscode.Location>,
        metaTarget?: Map<string, { params: string[]; doc?: string }>
    ) => {
        if (!node || !t.isObjectExpression(node)) { return; }
        for (const prop of node.properties) {
            if (t.isObjectMethod(prop) && t.isIdentifier(prop.key) && prop.loc) {
                // getter / setter 任取一次
                const loc = new vscode.Location(uri, new vscode.Position(lineOffset + prop.loc.start.line - 1, prop.loc.start.column));
                if (!target.has(prop.key.name)) { target.set(prop.key.name, loc); }
                recordFunctionMeta(prop.key.name, prop.params, getDocFromProp(prop), metaTarget);
            } else if (t.isObjectProperty(prop) && t.isIdentifier(prop.key) && prop.loc) {
                const val = prop.value as any;
                if (t.isFunctionExpression(val) || t.isArrowFunctionExpression(val)) {
                    const loc = new vscode.Location(uri, new vscode.Position(lineOffset + prop.loc.start.line - 1, prop.loc.start.column));
                    target.set(prop.key.name, loc);
                    recordFunctionMeta(prop.key.name, val.params, getDocFromProp(prop), metaTarget);
                } else if (t.isObjectExpression(val)) {
                    // 形如 someProp: { get(){}, set(){} }
                    const hasGetter = val.properties.some(p => t.isObjectMethod(p) && (p.kind === 'get'));
                    if (hasGetter) {
                        const loc = new vscode.Location(uri, new vscode.Position(lineOffset + prop.loc.start.line - 1, prop.loc.start.column));
                        target.set(prop.key.name, loc);
                        const getter = val.properties.find(p => t.isObjectMethod(p) && (p as t.ObjectMethod).kind === 'get') as t.ObjectMethod | undefined;
                        if (getter) {
                            const doc = getDocFromProp(getter) || getDocFromProp(prop);
                            recordFunctionMeta(prop.key.name, getter.params, doc, metaTarget);
                        }
                    }
                }
            }
        }
    };

    const getPropertyName = (key: t.Node | null | undefined): string | null => {
        if (!key) { return null; }
        if (t.isIdentifier(key)) { return key.name; }
        if (t.isStringLiteral(key)) { return key.value; }
        return null;
    };

    const resolveObjectExpression = (node: t.Node | null | undefined): t.ObjectExpression | null => {
        if (!node) { return null; }
        if (t.isObjectExpression(node)) { return node; }
        if (t.isIdentifier(node)) {
            const name = node.name;
            return objectVarDecls[name] || functionVarReturns[name] || functionDeclarations[name] || null;
        }
        return null;
    };

    const extractTemplateIdFromNode = (node: t.Node | null | undefined): string | null => {
        if (!node) { return null; }
        if (t.isStringLiteral(node)) {
            const value = node.value.trim();
            return value.startsWith('#') ? value.slice(1) : null;
        }
        if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
            const value = node.quasis[0]?.value.cooked?.trim() || '';
            return value.startsWith('#') ? value.slice(1) : null;
        }
        if (t.isMemberExpression(node) && t.isIdentifier(node.property, { name: 'innerHTML' })) {
            return extractTemplateIdFromNode(node.object as t.Node);
        }
        if (t.isCallExpression(node) && t.isMemberExpression(node.callee)) {
            const callee = node.callee;
            if (t.isIdentifier(callee.object, { name: 'document' }) && t.isIdentifier(callee.property)) {
                const calleeName = callee.property.name;
                const arg = node.arguments[0];
                const readArg = (value: string) => {
                    if (calleeName === 'getElementById') { return value; }
                    if (calleeName === 'querySelector' || calleeName === 'querySelectorAll') {
                        return value.startsWith('#') ? value.slice(1) : null;
                    }
                    return null;
                };
                if (t.isStringLiteral(arg)) {
                    return readArg(arg.value.trim());
                }
                if (t.isTemplateLiteral(arg) && arg.expressions.length === 0) {
                    return readArg(arg.quasis[0]?.value.cooked?.trim() || '');
                }
            }
        }
        return null;
    };

    const extractTemplateIdFromOptions = (options: t.ObjectExpression): string | null => {
        for (const prop of options.properties) {
            if (!t.isObjectProperty(prop) && !t.isObjectMethod(prop)) { continue; }
            const name = getPropertyName((prop as any).key);
            if (name !== 'template') { continue; }
            if (t.isObjectMethod(prop)) { return null; }
            return extractTemplateIdFromNode((prop as any).value);
        }
        return null;
    };

    const applyMixinsToIndex = (index: VueIndex, mixinObjects: t.ObjectExpression[], lineOffset: number) => {
        for (const obj of mixinObjects) {
            for (const prop of obj.properties) {
                if (!t.isObjectProperty(prop) && !t.isObjectMethod(prop)) { continue; }
                const name = getPropertyName((prop as any).key);
                if (name === 'data') {
                    extractData((prop as any).value ?? (t.isObjectMethod(prop) ? prop : (prop as any).value), lineOffset, index.mixinData, index.dataMeta);
                } else if (name === 'methods') {
                    extractMethods((prop as any).value ?? prop, lineOffset, index.mixinMethods, index.methodMeta);
                } else if (name === 'computed') {
                    extractComputed((prop as any).value ?? prop, lineOffset, index.mixinComputed, index.computedMeta);
                }
            }
        }
    };

    const populateIndexFromOptions = (index: VueIndex, options: t.ObjectExpression, lineOffset: number) => {
        const mixinVars: string[] = [];
        const mixinObjects: t.ObjectExpression[] = [];

        for (const prop of options.properties) {
            if (!t.isObjectProperty(prop) && !t.isObjectMethod(prop)) { continue; }
            const name = getPropertyName((prop as any).key);
            if (!name) { continue; }
            if (name === 'data') {
                extractData((prop as any).value ?? (t.isObjectMethod(prop) ? prop : (prop as any).value), lineOffset, index.data, index.dataMeta);
            } else if (name === 'methods') {
                extractMethods((prop as any).value ?? prop, lineOffset, index.methods, index.methodMeta);
            } else if (name === 'computed') {
                extractComputed((prop as any).value ?? prop, lineOffset, index.computed, index.computedMeta);
            } else if (name === 'mixins') {
                const value = (prop as any).value;
                if (value && t.isArrayExpression(value)) {
                    value.elements.forEach(el => {
                        if (t.isIdentifier(el)) { mixinVars.push(el.name); }
                        else if (t.isObjectExpression(el)) { mixinObjects.push(el); }
                    });
                }
            }
        }

        for (const mixinVar of mixinVars) {
            const obj = objectVarDecls[mixinVar] || functionVarReturns[mixinVar] || functionDeclarations[mixinVar];
            if (obj) { mixinObjects.push(obj); }
        }
        if (mixinObjects.length > 0) { applyMixinsToIndex(index, mixinObjects, lineOffset); }
        mergeAllMaps(index);
    };

    const collectComponentsFromOptions = (options: t.ObjectExpression, lineOffset: number) => {
        for (const prop of options.properties) {
            if (!t.isObjectProperty(prop)) { continue; }
            const name = getPropertyName(prop.key);
            if (name !== 'components') { continue; }
            const compsObj = resolveObjectExpression(prop.value);
            if (!compsObj) { continue; }
            for (const compProp of compsObj.properties) {
                if (!t.isObjectProperty(compProp)) { continue; }
                const compOptions = resolveObjectExpression(compProp.value) || (t.isObjectExpression(compProp.value) ? compProp.value : null);
                if (!compOptions) { continue; }
                const templateId = extractTemplateIdFromOptions(compOptions);
                if (!templateId || componentsByTemplateId.has(templateId)) { continue; }
                const compIndex = createIndexShell();
                populateIndexFromOptions(compIndex, compOptions, lineOffset);
                componentsByTemplateId.set(templateId, compIndex);
            }
        }
    };

    const rootIndex: VueIndex = {
        data,
        methods,
        computed,
        mixinData,
        mixinMethods,
        mixinComputed,
        all: new Map<string, vscode.Location>(),
        dataMeta,
        methodMeta,
        computedMeta,
        version: 0,
        hash: contentHash,
        builtAt: Date.now()
    };

    // 解析 new Vue({...}) 结构
    traverse(ast, {
        NewExpression(p) {
            if (t.isIdentifier(p.node.callee) && p.node.callee.name === 'Vue') {
                const first = p.node.arguments[0];
                if (first && t.isObjectExpression(first)) {
                    populateIndexFromOptions(rootIndex, first, baseLine);
                    collectComponentsFromOptions(first, baseLine);
                }
            }
        }
    });

    // 解析 Vue.component(...) 对应的 x-template
    traverse(ast, {
        CallExpression(p) {
            const callee = p.node.callee;
            if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.object, { name: 'Vue' }) || !t.isIdentifier(callee.property, { name: 'component' })) {
                return;
            }
            const optionsArg = p.node.arguments[1] as t.Node | undefined;
            const optionsObj = resolveObjectExpression(optionsArg);
            if (!optionsObj) { return; }
            const templateId = extractTemplateIdFromOptions(optionsObj);
            if (!templateId || componentsByTemplateId.has(templateId)) { return; }
            const compIndex = createIndexShell();
            populateIndexFromOptions(compIndex, optionsObj, baseLine);
            componentsByTemplateId.set(templateId, compIndex);
        }
    });

    const all = new Map<string, vscode.Location>();
    for (const m of [data, computed, methods, mixinData, mixinComputed, mixinMethods]) {
        m.forEach((loc, k) => { if (!all.has(k)) { all.set(k, loc); } });
    }

    return {
        data, methods, computed, mixinData, mixinMethods, mixinComputed, all,
        dataMeta,
        methodMeta,
        computedMeta,
        version: 0,
        hash: contentHash,
        builtAt: Date.now(),
        componentsByTemplateId: componentsByTemplateId.size > 0 ? componentsByTemplateId : undefined
    };
}

/**
 * 获取（或构建）某个 JS 源的 VueIndex，带缓存
 */
/**
 * 获取或创建 VueIndex。默认只在没有缓存时构建。
 * 如果需要强制重建（例如文件首次打开或显示时），传入 force=true。
 */
export function getOrCreateVueIndexFromContent(content: string, uri: vscode.Uri, baseLine = 0, force = false): VueIndex {
    const key = uri.toString();
    const hash = fastHash(content);
    const cached = indexCache.get(key);
    if (!force && cached && cached.index.hash === hash) {
        if (loggingEnabled()) { console.log(`[vue-index][hit] ${uri.fsPath} hash=${hash} data=${cached.index.data.size} computed=${cached.index.computed.size} methods=${cached.index.methods.size} mixinData=${cached.index.mixinData.size} mixinComputed=${cached.index.mixinComputed.size} mixinMethods=${cached.index.mixinMethods.size}`); }
        return cached.index;
    }
    // 构建新索引并缓存
    const index = buildVueIndex(content, uri, baseLine);
    lastVueIndexBuiltAt = Math.max(lastVueIndexBuiltAt, index.builtAt);
    indexCache.set(key, { index });
    if (loggingEnabled()) { console.log(`[vue-index][build] ${uri.fsPath} hash=${index.hash} data=${index.data.size} computed=${index.computed.size} methods=${index.methods.size} mixinData=${index.mixinData.size} mixinComputed=${index.mixinComputed.size} mixinMethods=${index.mixinMethods.size}`); }
    return index;
}

/** 返回当前缓存（不触发解析） */
export function getCachedVueIndex(uri: vscode.Uri): VueIndex | null {
    const entry = indexCache.get(uri.toString());
    return entry ? entry.index : null;
}

/** 删除指定 uri 的缓存 */
export function removeVueIndexForUri(uri: vscode.Uri) { indexCache.delete(uri.toString()); }

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

        const applyFunctionMeta = (
            item: vscode.CompletionItem,
            name: string,
            typeLabel: string,
            metaMap: Map<string, { params: string[]; doc?: string }>
        ) => {
            const meta = metaMap.get(name);
            if (meta && meta.params.length > 0) {
                item.detail = `${typeLabel} ${name}(${meta.params.join(', ')}) (雷动三千)`;
            } else {
                item.detail = `${typeLabel} ${name}() (雷动三千)`;
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
interface HtmlScriptCacheEntry { scriptPaths: string[]; checkedAt: number; }
const htmlScriptCache = new Map<string, HtmlScriptCacheEntry>();
const HTML_SCRIPT_CACHE_TTL_MS = 30 * 1000;

function getDevScriptPatterns(): string[] {
    try {
        const cfg = vscode.workspace.getConfiguration('leidong-tools');
        const patterns = cfg.get<string[]>('devScriptPatterns', []);
        return Array.isArray(patterns) ? patterns.filter(Boolean) : [];
    } catch {
        return [];
    }
}

function expandDevScriptPattern(pattern: string, htmlPath: string): string {
    const dir = path.dirname(htmlPath);
    const base = path.basename(htmlPath, path.extname(htmlPath));
    let result = pattern.replace(/\$\{dir\}/g, dir).replace(/\$\{base\}/g, base);
    if (!path.isAbsolute(result) && !pattern.includes('${dir}')) {
        result = path.join(dir, result);
    }
    return result;
}

function resolveScriptPathsFromPatterns(htmlPath: string): string[] {
    const patterns = getDevScriptPatterns();
    const paths: string[] = [];
    for (const pattern of patterns) {
        const candidate = expandDevScriptPattern(pattern, htmlPath);
        if (candidate.includes('*') || candidate.includes('?')) {
            continue;
        }
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            paths.push(candidate);
        }
    }
    return paths;
}

function findExternalDevScriptPaths(htmlPath: string): string[] {
    const cached = htmlScriptCache.get(htmlPath);
    const now = Date.now();
    if (cached && now - cached.checkedAt < HTML_SCRIPT_CACHE_TTL_MS) {
        const existing = cached.scriptPaths.filter(p => fs.existsSync(p));
        if (existing.length > 0) { return existing; }
        if (cached.scriptPaths.length === 0) { return []; }
    }
    const patternPaths = resolveScriptPathsFromPatterns(htmlPath);
    if (patternPaths.length > 0) {
        htmlScriptCache.set(htmlPath, { scriptPaths: patternPaths, checkedAt: now });
        return patternPaths;
    }
    const dir = path.dirname(htmlPath);
    const base = path.basename(htmlPath, path.extname(htmlPath));
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
                        htmlScriptCache.set(htmlPath, { scriptPaths: [full], checkedAt: now });
                        return [full];
                    }
                }
            } catch (e) { /* ignore directory read errors */ }
        }
    }
    htmlScriptCache.set(htmlPath, { scriptPaths: [], checkedAt: now });
    return [];
}

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
        lastExternalIndexBuiltAt = Math.max(lastExternalIndexBuiltAt, index.builtAt);
        if (loggingEnabled()) { console.log(`[vue-index][external-build] ${fullPath} mtime=${stat.mtimeMs} hash=${index.hash}`); }
        return index;
    } catch { return null; }
}

function createEmptyVueIndex(): VueIndex {
    return {
        data: new Map<string, vscode.Location>(),
        methods: new Map<string, vscode.Location>(),
        computed: new Map<string, vscode.Location>(),
        mixinData: new Map<string, vscode.Location>(),
        mixinMethods: new Map<string, vscode.Location>(),
        mixinComputed: new Map<string, vscode.Location>(),
        all: new Map<string, vscode.Location>(),
        dataMeta: new Map<string, { doc?: string }>(),
        methodMeta: new Map<string, { params: string[]; doc?: string }>(),
        computedMeta: new Map<string, { params: string[]; doc?: string }>(),
        version: 0,
        hash: '',
        builtAt: 0,
        componentsByTemplateId: undefined
    };
}

function mergeMap<T>(target: Map<string, T>, source: Map<string, T>) {
    source.forEach((value, key) => {
        if (!target.has(key)) {
            target.set(key, value);
        }
    });
}

function mergeVueIndexInto(target: VueIndex, source: VueIndex) {
    mergeMap(target.data, source.data);
    mergeMap(target.methods, source.methods);
    mergeMap(target.computed, source.computed);
    mergeMap(target.mixinData, source.mixinData);
    mergeMap(target.mixinMethods, source.mixinMethods);
    mergeMap(target.mixinComputed, source.mixinComputed);
    mergeMap(target.dataMeta, source.dataMeta);
    mergeMap(target.methodMeta, source.methodMeta);
    mergeMap(target.computedMeta, source.computedMeta);
    if (source.componentsByTemplateId) {
        if (!target.componentsByTemplateId) {
            target.componentsByTemplateId = new Map<string, VueIndex>();
        }
        source.componentsByTemplateId.forEach((value, key) => {
            if (!target.componentsByTemplateId!.has(key)) {
                target.componentsByTemplateId!.set(key, value);
            }
        });
    }
    target.builtAt = Math.max(target.builtAt, source.builtAt);
}

function finalizeMergedIndex(target: VueIndex, hashes: string[]) {
    const all = new Map<string, vscode.Location>();
    for (const m of [target.data, target.computed, target.methods, target.mixinData, target.mixinComputed, target.mixinMethods]) {
        m.forEach((loc, k) => { if (!all.has(k)) { all.set(k, loc); } });
    }
    target.all = all;
    target.hash = fastHash(hashes.join('|'));
}

export function getExternalDevScriptPathsForHtml(document: vscode.TextDocument): string[] {
    return findExternalDevScriptPaths(document.uri.fsPath);
}

export function resolveVueIndexForHtml(document: vscode.TextDocument): VueIndex | null {
    const htmlPath = document.uri.fsPath;
    const externalPaths = findExternalDevScriptPaths(htmlPath);
    if (externalPaths.length > 0) {
        const merged = createEmptyVueIndex();
        const hashes: string[] = [];
        for (const externalPath of externalPaths) {
            const extIdx = getExternalFileIndex(externalPath);
            if (extIdx) {
                mergeVueIndexInto(merged, extIdx);
                hashes.push(extIdx.hash);
            }
        }
        if (hashes.length > 0) {
            finalizeMergedIndex(merged, hashes);
            return merged;
        }
        return null;
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
    // 优先顺序：data > mixinData > computed > mixinComputed > methods > mixinMethods
    if (index.data.has(name)) { return index.data.get(name)!; }
    if (index.mixinData.has(name)) { return index.mixinData.get(name)!; }
    if (index.computed.has(name)) { return index.computed.get(name)!; }
    if (index.mixinComputed.has(name)) { return index.mixinComputed.get(name)!; }
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

export function getVueIndexCacheStats() {
    return {
        size: indexCache.size,
        lastBuiltAt: lastVueIndexBuiltAt || 0,
        lastExternalBuiltAt: lastExternalIndexBuiltAt || 0,
        externalCacheSize: externalFileCache.size
    };
}

/**
 * 清空缓存（可在需要时暴露命令）
 */
export function clearVueIndexCache() { indexCache.clear(); }
export function pruneVueIndexCache(maxAgeMs = 1000 * 60 * 60) { indexCache.pruneByAge(maxAgeMs); }

export function recreateVueIndexCache() { indexCache = new LRUCache<string, CacheEntry>(getMaxIndexEntries()); }
// 供调试：打印当前缓存概览
export function logVueIndexCacheSummary() {
    console.log(`[vue-index][summary] entries=${indexCache.size} (logging=${loggingEnabled()})`);
    indexCache.forEach((entry, k) => {
        console.log(`  - ${k} data=${entry.index.data.size} computed=${entry.index.computed.size} methods=${entry.index.methods.size} mixinData=${entry.index.mixinData.size} mixinComputed=${entry.index.mixinComputed.size} mixinMethods=${entry.index.mixinMethods.size}`);
    });
}

