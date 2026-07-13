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

const cache = new Map<string, { signature: string; builtAt: number; index: CssIndex }>();
const warnedRegex = new Set<string>();
const CACHE_TTL_MS = 3000;
const MAX_DIRECTORY_CSS_FILES = 500;

export class CssQuickIndexCompletionProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): Promise<vscode.CompletionList | vscode.CompletionItem[]> {
        if (token.isCancellationRequested || document.languageId !== 'html' || document.uri.scheme !== 'file') {
            return [];
        }

        const linePrefix = document.lineAt(position).text.substring(0, position.character);
        const classContext = getClassAttributeContext(linePrefix, position);
        const styleContext = getStyleAttributeContext(linePrefix, position);
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
    if (document.languageId !== 'html' || document.uri.scheme !== 'file') { return false; }
    await buildCssQuickIndex(document, true);
    return true;
}

export function clearCssQuickIndexCache(): void {
    cache.clear();
}

async function buildCssQuickIndex(document: vscode.TextDocument, force = false): Promise<CssIndex> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const configuration = vscode.workspace.getConfiguration('leidong-tools', folder?.uri ?? document.uri);
    const linkCssEnabled = configuration.get<boolean>('cssIndexLinkCssEnabled', false);
    const extraPaths = configuration.get<string[]>('cssIndexExtraPaths', []);
    const excludes = configuration.get<string[]>('cssIndexExcludePatterns', []);
    const signatureBase = JSON.stringify([document.uri.toString(), document.version, linkCssEnabled, extraPaths, excludes]);
    const cached = cache.get(document.uri.toString());
    if (!force && cached && cached.signature === signatureBase && Date.now() - cached.builtAt < CACHE_TTL_MS) {
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
    for (const source of sources) {
        let content = source.content;
        if (content === undefined && source.uri) {
            try {
                content = Buffer.from(await vscode.workspace.fs.readFile(source.uri)).toString('utf8');
            } catch {
                continue;
            }
        }
        if (!content) { continue; }
        parseCssIntoIndex(content, source.label, index);
    }
    index.sourceCount = sources.length;
    cache.set(document.uri.toString(), { signature: signatureBase, builtAt: Date.now(), index });
    while (cache.size > 30) {
        const oldest = cache.keys().next().value;
        if (oldest) { cache.delete(oldest); }
    }
    return index;
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
    while ((match = linkRe.exec(text)) !== null) {
        const tag = match[0];
        if (!/\brel\s*=\s*(['"]?)[^'">\s]*stylesheet[^'">\s]*\1/i.test(tag)) { continue; }
        const href = /\bhref\s*=\s*(['"])(.*?)\1/i.exec(tag) || /\bhref\s*=\s*([^\s>]+)/i.exec(tag);
        const value = href?.[2] ?? href?.[1];
        const uri = value ? resolveCssPath(value, document, path.dirname(document.uri.fsPath)) : undefined;
        if (uri) { uris.push(uri); }
    }
    return uris;
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

function addEntry(map: Map<string, CssIndexEntry>, name: string, source: string, value?: string): void {
    const existing = map.get(name);
    if (existing) {
        existing.sources.add(source);
        if (!existing.value && value) { existing.value = value; }
        return;
    }
    map.set(name, { name, sources: new Set([source]), value });
}

function buildClassItems(index: CssIndex, context: AttributeContext): vscode.CompletionItem[] {
    return Array.from(index.classes.values())
        .filter(entry => !context.prefix || entry.name.startsWith(context.prefix))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry, idx) => {
            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Class);
            item.detail = `CSS class (${entry.sources.size} 个来源)`;
            item.documentation = new vscode.MarkdownString(Array.from(entry.sources).slice(0, 8).map(source => `- ${source}`).join('\n'));
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

function getClassAttributeContext(linePrefix: string, position: vscode.Position): AttributeContext | undefined {
    if (!isInsideTag(linePrefix)) { return undefined; }
    const match = /\bclass\s*=\s*(['"])([^'"]*)$/i.exec(linePrefix);
    if (!match) { return undefined; }
    const value = match[2] || '';
    const token = /[^\s]*$/.exec(value)?.[0] || '';
    return {
        prefix: token,
        range: new vscode.Range(position.translate(0, -token.length), position),
    };
}

function getStyleAttributeContext(linePrefix: string, position: vscode.Position): StyleVariableContext | undefined {
    if (!isInsideTag(linePrefix)) { return undefined; }
    const match = /\bstyle\s*=\s*(['"])([^'"]*)$/i.exec(linePrefix);
    if (!match) { return undefined; }
    const value = match[2] || '';
    const varMatch = /var\(\s*(--[-_a-zA-Z0-9]*)?$/.exec(value);
    if (varMatch) {
        const prefix = varMatch[1] || '';
        return { prefix, range: new vscode.Range(position.translate(0, -prefix.length), position), inVarFunction: true };
    }
    const token = /--[-_a-zA-Z0-9]*$/.exec(value)?.[0];
    if (!token) { return undefined; }
    return {
        prefix: token,
        range: new vscode.Range(position.translate(0, -token.length), position),
        inVarFunction: false,
    };
}

function isInsideTag(linePrefix: string): boolean {
    return linePrefix.lastIndexOf('<') > linePrefix.lastIndexOf('>');
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
