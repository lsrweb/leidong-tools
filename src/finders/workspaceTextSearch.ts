/**
 * 工作区文本扫描（跨文件引用 / 全局符号搜索共用）。
 *
 * 说明：VS Code 的 findTextInFiles 仍是 proposed API（正式扩展不可用），
 * 这里用稳定 API 组合实现：findFiles 收集候选文件 → 带 mtime 校验的文本缓存 → 正则逐行匹配。
 * 排除依赖/构建目录，避免把 VS Code 安装目录、node_modules、打包产物当引用来源。
 */
import * as vscode from 'vscode';

export interface WorkspaceTextHit {
    uri: vscode.Uri;
    /** 0-based 行号 */
    line: number;
    /** 命中起点列（captureGroup 指定时为其位置） */
    character: number;
    /** 命中长度 */
    length: number;
    /** 命中行文本（截断，便于展示） */
    preview: string;
    /** captureGroup 指定时捕获到的文本（如 window.<name> 中的 name） */
    name?: string;
}

export interface WorkspaceScanOptions {
    /** 候选文件 glob（默认 JS/TS/HTML/Vue） */
    include?: string;
    /** 单文件最多命中数（防止单文件刷屏） */
    maxHitsPerFile?: number;
    /** 总命中上限 */
    maxResults?: number;
    /** 作为命中位置与 name 返回的捕获组序号（1-based） */
    captureGroup?: number;
}

const SEARCH_EXCLUDE = '**/{node_modules,bower_components,.git,.svn,.hg,.vscode-test,dist,out,build,coverage}/**';
const MAX_FILE_BYTES = 600000;
const MAX_FILES = 1500;
const READ_BATCH = 16;

interface CacheEntry { mtime: number; text: string }
const textCache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 300;

async function readWithCache(uri: vscode.Uri): Promise<string | null> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) === 0 || stat.size > MAX_FILE_BYTES) { return null; }
        const key = uri.toString();
        const cached = textCache.get(key);
        if (cached && cached.mtime === stat.mtime) { return cached.text; }
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        textCache.set(key, { mtime: stat.mtime, text });
        if (textCache.size > MAX_CACHE_ENTRIES) {
            const oldest = textCache.keys().next().value;
            if (oldest !== undefined) { textCache.delete(oldest); }
        }
        return text;
    } catch {
        return null;
    }
}

/** 行内正则扫描（captureGroup 指定时以捕获组作为命中位置，并返回 name）。 */
export function collectLineHits(uri: vscode.Uri, text: string, regex: RegExp, options: { maxHitsPerFile: number; maxResults: number; captureGroup?: number }, hits: WorkspaceTextHit[]): void {
    const lines = text.split(/\r?\n/);
    let fileHits = 0;
    for (let line = 0; line < lines.length && fileHits < options.maxHitsPerFile && hits.length < options.maxResults; line++) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(lines[line])) !== null) {
            let start = match.index;
            let length = match[0].length;
            let name: string | undefined;
            if (options.captureGroup && match.indices && match.indices[options.captureGroup]) {
                const [groupStart, groupEnd] = match.indices[options.captureGroup]!;
                start = groupStart;
                length = groupEnd - groupStart;
                name = match[options.captureGroup];
            }
            hits.push({ uri, line, character: start, length, preview: lines[line].trim().slice(0, 160), name });
            fileHits++;
            if (match[0].length === 0) { regex.lastIndex++; } // 空匹配防死循环
            if (fileHits >= options.maxHitsPerFile || hits.length >= options.maxResults) { break; }
        }
    }
}

/** 扫描工作区文本，返回正则命中列表（行级，含预览）。 */
export async function scanWorkspaceText(pattern: string, options: WorkspaceScanOptions = {}, token?: vscode.CancellationToken): Promise<WorkspaceTextHit[]> {
    const regex = new RegExp(pattern, 'gd');
    const include = options.include ?? '**/*.{js,ts,jsx,tsx,html,vue}';
    const scanOptions = {
        maxHitsPerFile: options.maxHitsPerFile ?? 50,
        maxResults: options.maxResults ?? 300,
        captureGroup: options.captureGroup,
    };
    const uris = await vscode.workspace.findFiles(include, SEARCH_EXCLUDE, MAX_FILES, token);
    const hits: WorkspaceTextHit[] = [];
    for (let i = 0; i < uris.length && hits.length < scanOptions.maxResults; i += READ_BATCH) {
        if (token?.isCancellationRequested) { break; }
        const batch = uris.slice(i, i + READ_BATCH);
        const texts = await Promise.all(batch.map(readWithCache));
        for (let j = 0; j < batch.length; j++) {
            const text = texts[j];
            if (text === null || text === undefined) { continue; }
            collectLineHits(batch[j], text, regex, scanOptions, hits);
        }
    }
    return hits;
}
