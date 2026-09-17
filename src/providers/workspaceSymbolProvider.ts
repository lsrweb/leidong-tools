import * as vscode from 'vscode';
import { scanWorkspaceText } from '../finders/workspaceTextSearch';

const CACHE_TTL_MS = 60000;
const MAX_SYMBOLS = 300;

/**
 * 全局符号搜索（Ctrl+T「转到工作区中的符号」）：
 * 扫描全项目的 `window.xxx = ...` 定义（全局组件 / 全局 API），输入关键字过滤、回车跳转。
 * 首次请求扫描工作区并缓存 60 秒，文件保存后缓存自动失效。
 */
export class VueGlobalSymbolProvider implements vscode.WorkspaceSymbolProvider, vscode.Disposable {
    private cache: { at: number; symbols: vscode.SymbolInformation[] } | null = null;
    private readonly saveListener: vscode.Disposable;

    constructor() {
        this.saveListener = vscode.workspace.onDidSaveTextDocument(() => { this.cache = null; });
    }

    dispose(): void {
        this.saveListener.dispose();
    }

    async provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): Promise<vscode.SymbolInformation[]> {
        const symbols = await this.getSymbols(token);
        const keyword = query.trim().toLowerCase();
        const matched = keyword ? symbols.filter(symbol => symbol.name.toLowerCase().includes(keyword)) : symbols;
        return matched.slice(0, MAX_SYMBOLS);
    }

    private async getSymbols(token: vscode.CancellationToken): Promise<vscode.SymbolInformation[]> {
        const now = Date.now();
        if (this.cache && now - this.cache.at < CACHE_TTL_MS) { return this.cache.symbols; }
        const hits = await scanWorkspaceText('window\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*=', {
            include: '**/*.{js,ts,html}',
            maxResults: 400,
            maxHitsPerFile: 30,
            captureGroup: 1,
        }, token);
        const seen = new Set<string>();
        const symbols: vscode.SymbolInformation[] = [];
        for (const hit of hits) {
            if (!hit.name) { continue; }
            const key = `${hit.name}@${hit.uri.toString()}`;
            if (seen.has(key)) { continue; }
            seen.add(key);
            symbols.push(new vscode.SymbolInformation(
                hit.name,
                vscode.SymbolKind.Object,
                '全局（window）',
                new vscode.Location(hit.uri, new vscode.Range(hit.line, hit.character, hit.line, hit.character + hit.length)),
            ));
        }
        if (!token.isCancellationRequested) { this.cache = { at: now, symbols }; }
        return symbols;
    }
}
