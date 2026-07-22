import * as vscode from 'vscode';
import * as path from 'path';

interface CssIndex {
    classes: Map<string, CssIndexEntry>;
    variables: Map<string, CssIndexEntry>;
    sourceCount: number;
}

interface CssIndexEntry {
    name: string;
    sources: Set<string>;
    value?: string;
    contents: Map<string, string>;
}

interface CssSource {
    uri?: vscode.Uri;
    label: string;
    content?: string;
}

interface ExcludeMatcher {
    raw: string;
    normalized: string;
    regex?: RegExp;
}

const cache = new Map<string, { signature: string; index: CssIndex }>();
const inFlight = new Map<string, Promise<CssIndex>>();
const warnedRegex = new Set<string>();
const warnedLargeSources = new Set<string>();
const MAX_DIRECTORY_CSS_FILES = 500;

export class CssQuickIndexCompletionProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): Promise<vscode.CompletionList | vscode.CompletionItem[]> {
        if (token.isCancellationRequested || !isCssIndexDocument(document) || document.uri.scheme !== 'file') {
            return [];
        }

        const tagPrefix = getOpenTagPrefix(document, position);
        const classContext = tagPrefix ? getClassAttributeContext(tagPrefix, document, position) : undefined;
        const styleContext = tagPrefix ? getStyleAttributeContext(tagPrefix, document, position) : undefined;
        if (!classContext && !styleContext) { return []; }

        const index = await buildCssQuickIndex(document);
        if (token.isCancellationRequested) { return []; }

        if (classContext) {
            return new vscode.CompletionList(buildClassItems(index, classContext), false);
        }

        if (styleContext) {
            return new vscode.CompletionList(buildVariableItems(index, styleContext), false);
        }

        return [];
    }
}

export async function warmCssQuickIndexForDocument(document: vscode.TextDocument): Promise<boolean> {
    if (!isCssIndexDocument(document) || document.uri.scheme !== 'file') { return false; }
    await buildCssQuickIndex(document);
    return true;
}

export function clearCssQuickIndexCache(): void {
    cache.clear();
    inFlight.clear();
}

async function buildCssQuickIndex(document: vscode.TextDocument, force = false): Promise<CssIndex> {
    const key = document.uri.toString();
    const running = inFlight.get(key);
    if (running) { return running; }
    const task = buildCssQuickIndexFresh(document, force);
    inFlight.set(key, task);
    try {
        return await task;
    } finally {
        if (inFlight.get(key) === task) { inFlight.delete(key); }
    }
}

async function buildCssQuickIndexFresh(document: vscode.TextDocument, force = false): Promise<CssIndex> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const configuration = vscode.workspace.getConfiguration('leidong-tools', folder?.uri ?? document.uri);
    const linkCssEnabled = configuration.get<boolean>('cssIndexLinkCssEnabled', false);
    const extraPaths = configuration.get<string[]>('cssIndexExtraPaths', []);
    const excludes = configuration.get<string[]>('cssIndexExcludePatterns', []);
    const maxFileLines = Math.max(0, configuration.get<number>('cssIndexMaxFileLines', 2000));
    const signatureBase = JSON.stringify([document.uri.toString(), document.version, linkCssEnabled, extraPaths, excludes, maxFileLines]);
    const cached = cache.get(document.uri.toString());
    if (!force && cached && cached.signature === signatureBase) {
        return cached.index;
    }

    const sources: CssSource[] = [];
    const text = document.getText();
    collectStyleTagSources(text, sources);
    const matchers = compileExcludeMatchers(excludes, document);

    if (linkCssEnabled) {
        for (const uri of collectLinkedCssUris(text, document)) {
            if (shouldExclude(uri, matchers, document)) { continue; }
            sources.push({ uri, label: sourceLabel(uri, document) });
        }
    }

    for (const source of await collectExtraCssSources(extraPaths, document, matchers)) {
        sources.push(source);
    }

    const index = emptyIndex();
    const seen = new Set<string>();
    const addSource = async (source: CssSource, depth = 0): Promise<void> => {
        if (depth > 12) { return; }
        const sourceKey = source.uri?.toString() ?? `${source.label}:${source.content?.length ?? 0}`;
        if (seen.has(sourceKey)) { return; }
        seen.add(sourceKey);
        let content = source.content;
        if (content === undefined && source.uri) {
            try {
                content = Buffer.from(await vscode.workspace.fs.readFile(source.uri)).toString('utf8');
            } catch {
                return;
            }
        }
        if (!content) { return; }
        if (source.uri && maxFileLines > 0) {
            const lineCount = countLines(content);
            if (lineCount > maxFileLines) {
                notifyLargeCssSource(source.uri, lineCount, maxFileLines);
                return;
            }
        }
        parseCssIntoIndex(content, source.label, index);
        if (!source.uri) { return; }
        for (const imported of collectCssImports(content, source.uri, document)) {
            if (!shouldExclude(imported, matchers, document)) {
                await addSource({ uri: imported, label: sourceLabel(imported, document) }, depth + 1);
            }
        }
    };
    await Promise.all(sources.map(source => addSource(source)));
    index.sourceCount = seen.size;
    cache.set(document.uri.toString(), { signature: signatureBase, index });
    while (cache.size > 30) {
        const oldest = cache.keys().next().value;
        if (oldest) { cache.delete(oldest); }
    }
    return index;
}

function countLines(content: string): number {
    return content ? content.split(/\r\n|\r|\n/).length : 0;
}

function notifyLargeCssSource(uri: vscode.Uri, lineCount: number, limit: number): void {
    const key = `${uri.toString()}|${lineCount}|${limit}`;
    if (warnedLargeSources.has(key)) { return; }
    warnedLargeSources.add(key);
    void vscode.window.showWarningMessage(`CSS 索引已跳过超大文件：${path.basename(uri.fsPath)}（${lineCount} 行，自动索引上限 ${limit} 行）`);
}

function isCssIndexDocument(document: vscode.TextDocument): boolean {
    return document.languageId === 'html' || document.languageId === 'vue';
}

function emptyIndex(): CssIndex {
    return { classes: new Map(), variables: new Map(), sourceCount: 0 };
}

function collectStyleTagSources(text: string, sources: CssSource[]): void {
    const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let match: RegExpExecArray | null;
    let index = 1;
    while ((match = re.exec(text)) !== null) {
        sources.push({ label: `<style #${index++}>`, content: match[1] || '' });
    }
}

function collectLinkedCssUris(text: string, document: vscode.TextDocument): vscode.Uri[] {
    const uris: vscode.Uri[] = [];
    const linkRe = /<link\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
    while ((match = linkRe.exec(withoutComments)) !== null) {
        const tag = match[0];
        if (!/\brel\s*=\s*(['"]?)[^'">\s]*stylesheet[^'">\s]*\1/i.test(tag)) { continue; }
        const href = /\bhref\s*=\s*(['"])(.*?)\1/i.exec(tag) || /\bhref\s*=\s*([^\s>]+)/i.exec(tag);
        const value = href?.[2] ?? href?.[1];
        const uri = value ? resolveCssPath(value, document, path.dirname(document.uri.fsPath)) : undefined;
        if (uri) { uris.push(uri); }
    }
    return uris;
}

function collectCssImports(text: string, sourceUri: vscode.Uri, document: vscode.TextDocument): vscode.Uri[] {
    const result: vscode.Uri[] = [];
    const importRe = /@import\s+(?:url\(\s*)?(['"]?)([^'"\s)]+)\1\s*\)?[^;]*;/gi;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(text)) !== null) {
        const uri = resolveCssPath(match[2], document, path.dirname(sourceUri.fsPath));
        if (uri && path.extname(uri.fsPath).toLowerCase() === '.css') { result.push(uri); }
    }
    return result;
}

async function collectExtraCssSources(
    values: string[],
    document: vscode.TextDocument,
    excludes: ExcludeMatcher[],
): Promise<CssSource[]> {
    const result: CssSource[] = [];
    const seen = new Set<string>();
    for (const raw of values) {
        const value = raw.trim();
        if (!value) { continue; }
        const uris = await resolveConfiguredCssPath(value, document);
        for (const uri of uris) {
            const key = uri.toString();
            if (seen.has(key) || shouldExclude(uri, excludes, document)) { continue; }
            seen.add(key);
            result.push({ uri, label: sourceLabel(uri, document) });
        }
    }
    return result;
}

async function resolveConfiguredCssPath(value: string, document: vscode.TextDocument): Promise<vscode.Uri[]> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const folderPath = folder?.uri.fsPath ?? path.dirname(document.uri.fsPath);
    const replaced = value
        .replace(/\$\{workspaceFolder\}|\$\{workspaceRoot\}/g, folderPath)
        .replace(/\$\{fileDir\}|\$\{dir\}/g, path.dirname(document.uri.fsPath));

    if (/[*?[\]{}]/.test(replaced) && folder) {
        const pattern = new vscode.RelativePattern(folder, replaced.replace(/\\/g, '/'));
        return vscode.workspace.findFiles(pattern, undefined, MAX_DIRECTORY_CSS_FILES);
    }

    const uri = resolveCssPath(replaced, document, folderPath);
    if (!uri) { return []; }
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) !== 0) {
            return collectCssFilesInDirectory(uri);
        }
        if ((stat.type & vscode.FileType.File) !== 0 && path.extname(uri.fsPath).toLowerCase() === '.css') {
            return [uri];
        }
    } catch {
        if (path.extname(uri.fsPath).toLowerCase() === '.css') { return [uri]; }
    }
    return [];
}

async function collectCssFilesInDirectory(root: vscode.Uri): Promise<vscode.Uri[]> {
    const result: vscode.Uri[] = [];
    const visit = async (uri: vscode.Uri): Promise<void> => {
        if (result.length >= MAX_DIRECTORY_CSS_FILES) { return; }
        let entries: [string, vscode.FileType][];
        try { entries = await vscode.workspace.fs.readDirectory(uri); } catch { return; }
        for (const [name, type] of entries) {
            if (result.length >= MAX_DIRECTORY_CSS_FILES) { return; }
            const child = vscode.Uri.joinPath(uri, name);
            if ((type & vscode.FileType.Directory) !== 0) {
                await visit(child);
            } else if ((type & vscode.FileType.File) !== 0 && path.extname(name).toLowerCase() === '.css') {
                result.push(child);
            }
        }
    };
    await visit(root);
    return result;
}

function resolveCssPath(value: string, document: vscode.TextDocument, basePath: string): vscode.Uri | undefined {
    const cleaned = value.split(/[?#]/, 1)[0].trim();
    if (!cleaned || /^(?:https?:)?\/\//i.test(cleaned) || /^(?:data|mailto|javascript):/i.test(cleaned)) {
        return undefined;
    }
    if (path.isAbsolute(cleaned)) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (cleaned.startsWith('/') && folder) {
            return vscode.Uri.file(path.join(folder.uri.fsPath, cleaned.replace(/^\/+/, '')));
        }
        return vscode.Uri.file(cleaned);
    }
    return vscode.Uri.file(path.resolve(basePath, cleaned));
}

function compileExcludeMatchers(values: string[], document: vscode.TextDocument): ExcludeMatcher[] {
    return values.map(raw => {
        const normalized = normalizePathLike(raw, document);
        let regex: RegExp | undefined;
        try {
            regex = raw.trim() ? new RegExp(raw) : undefined;
        } catch {
            if (!warnedRegex.has(raw)) {
                warnedRegex.add(raw);
                void vscode.window.showWarningMessage(`CSS 索引过滤正则无效：${raw}`);
            }
        }
        return { raw, normalized, regex };
    }).filter(item => item.raw.trim());
}

function shouldExclude(uri: vscode.Uri, matchers: ExcludeMatcher[], document: vscode.TextDocument): boolean {
    if (!matchers.length) { return false; }
    const full = normalizeSlash(uri.fsPath).toLowerCase();
    const relative = normalizeSlash(path.relative(vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(document.uri.fsPath), uri.fsPath)).toLowerCase();
    const base = path.basename(uri.fsPath).toLowerCase();
    return matchers.some(matcher => {
        const normalized = matcher.normalized.toLowerCase();
        if (normalized && (full === normalized || relative === normalized || full.endsWith(`/${normalized}`) || relative.endsWith(normalized) || base === normalized)) {
            return true;
        }
        return matcher.regex?.test(full) || matcher.regex?.test(relative) || matcher.regex?.test(base) || false;
    });
}

function normalizePathLike(value: string, document: vscode.TextDocument): string {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const folderPath = folder?.uri.fsPath ?? path.dirname(document.uri.fsPath);
    const replaced = value
        .replace(/\$\{workspaceFolder\}|\$\{workspaceRoot\}/g, folderPath)
        .replace(/\$\{fileDir\}|\$\{dir\}/g, path.dirname(document.uri.fsPath));
    if (path.isAbsolute(replaced)) { return normalizeSlash(replaced); }
    return normalizeSlash(replaced).replace(/^\/+/, '');
}

function parseCssIntoIndex(content: string, label: string, index: CssIndex): void {
    const css = content.replace(/\/\*[\s\S]*?\*\//g, '');
    const ruleRe = /([^{}@][^{}]*)\{([^{}]*)\}/g;
    let ruleMatch: RegExpExecArray | null;
    while ((ruleMatch = ruleRe.exec(css)) !== null) {
        const declarations = ruleMatch[2].trim();
        if (!declarations) { continue; }
        const selector = ruleMatch[1];
        const selectorClassRe = /\.(-?[_a-zA-Z][-_a-zA-Z0-9]*)/g;
        let selectorClass: RegExpExecArray | null;
        while ((selectorClass = selectorClassRe.exec(selector)) !== null) {
            addEntry(index.classes, selectorClass[1], label, undefined, declarations);
        }
    }
    const classRe = /\.(-?[_a-zA-Z][-_a-zA-Z0-9]*)/g;
    let classMatch: RegExpExecArray | null;
    while ((classMatch = classRe.exec(css)) !== null) {
        addEntry(index.classes, classMatch[1], label);
    }

    const variableRe = /(--[-_a-zA-Z0-9]+)\s*:\s*([^;{}]+)/g;
    let variableMatch: RegExpExecArray | null;
    while ((variableMatch = variableRe.exec(css)) !== null) {
        addEntry(index.variables, variableMatch[1], label, variableMatch[2].trim());
    }
}

function addEntry(map: Map<string, CssIndexEntry>, name: string, source: string, value?: string, content?: string): void {
    const existing = map.get(name);
    if (existing) {
        existing.sources.add(source);
        if (!existing.value && value) { existing.value = value; }
        if (content) { existing.contents.set(source, content); }
        return;
    }
    map.set(name, { name, sources: new Set([source]), value, contents: new Map(content ? [[source, content]] : []) });
}

function buildClassItems(index: CssIndex, context: AttributeContext): vscode.CompletionItem[] {
    return Array.from(index.classes.values())
        .filter(entry => !context.prefix || entry.name.startsWith(context.prefix))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry, idx) => {
            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Class);
            const contents = Array.from(entry.contents.entries()).slice(0, 4);
            const firstContent = contents[0]?.[1]?.replace(/\s+/g, ' ').trim();
            item.detail = firstContent ? `CSS class · ${firstContent.slice(0, 80)}` : `CSS class (${entry.sources.size} 个来源)`;
            const documentation = new vscode.MarkdownString();
            documentation.appendMarkdown(Array.from(entry.sources).slice(0, 8).map(source => `- ${source}`).join('\n'));
            for (const [source, content] of contents) {
                documentation.appendMarkdown(`\n\n**${source}**\n\n\`\`\`css\n.${entry.name} {\n${content}\n}\n\`\`\``);
            }
            if (entry.contents.size > contents.length) { documentation.appendMarkdown(`\n\n另有 ${entry.contents.size - contents.length} 处定义未展开。`); }
            item.documentation = documentation;
            item.range = context.range;
            item.sortText = `0000${idx.toString().padStart(5, '0')}`;
            return item;
        });
}

function buildVariableItems(index: CssIndex, context: StyleVariableContext): vscode.CompletionItem[] {
    return Array.from(index.variables.values())
        .filter(entry => !context.prefix || entry.name.startsWith(context.prefix))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry, idx) => {
            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Variable);
            item.detail = entry.value ? `CSS 变量: ${entry.value}` : 'CSS 变量';
            item.documentation = new vscode.MarkdownString(Array.from(entry.sources).slice(0, 8).map(source => `- ${source}`).join('\n'));
            item.range = context.range;
            item.insertText = context.inVarFunction ? entry.name : `var(${entry.name})`;
            item.sortText = `0000${idx.toString().padStart(5, '0')}`;
            return item;
        });
}

interface AttributeContext {
    prefix: string;
    range: vscode.Range;
}

interface StyleVariableContext extends AttributeContext {
    inVarFunction: boolean;
}

function getClassAttributeContext(tagPrefix: string, document: vscode.TextDocument, position: vscode.Position): AttributeContext | undefined {
    const match = /\bclass\s*=\s*(['"])([^'"]*)$/i.exec(tagPrefix);
    if (!match) { return undefined; }
    const value = match[2] || '';
    const token = /[^\s]*$/.exec(value)?.[0] || '';
    return {
        prefix: token,
        range: new vscode.Range(document.positionAt(document.offsetAt(position) - token.length), position),
    };
}

function getStyleAttributeContext(tagPrefix: string, document: vscode.TextDocument, position: vscode.Position): StyleVariableContext | undefined {
    const match = /\bstyle\s*=\s*(['"])([^'"]*)$/i.exec(tagPrefix);
    if (!match) { return undefined; }
    const value = match[2] || '';
    const varMatch = /var\(\s*(--[-_a-zA-Z0-9]*)?$/.exec(value);
    if (varMatch) {
        const prefix = varMatch[1] || '';
        return { prefix, range: new vscode.Range(document.positionAt(document.offsetAt(position) - prefix.length), position), inVarFunction: true };
    }
    const token = /--[-_a-zA-Z0-9]*$/.exec(value)?.[0];
    if (!token) { return undefined; }
    return {
        prefix: token,
        range: new vscode.Range(document.positionAt(document.offsetAt(position) - token.length), position),
        inVarFunction: false,
    };
}

function getOpenTagPrefix(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    const offset = document.offsetAt(position);
    const text = document.getText(new vscode.Range(document.positionAt(Math.max(0, offset - 16000)), position));
    const open = text.lastIndexOf('<');
    if (open < 0 || text.lastIndexOf('>') > open) { return undefined; }
    return text.slice(open);
}

function sourceLabel(uri: vscode.Uri, document: vscode.TextDocument): string {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) { return path.basename(uri.fsPath); }
    const relative = normalizeSlash(path.relative(folder.uri.fsPath, uri.fsPath));
    return relative && !relative.startsWith('..') ? relative : uri.fsPath;
}

function normalizeSlash(value: string): string {
    return value.replace(/\\/g, '/');
}
