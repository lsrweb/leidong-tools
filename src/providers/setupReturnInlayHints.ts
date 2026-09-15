import * as vscode from 'vscode';
import * as path from 'path';
import { scanSetupReturnHints, SetupReturnHint } from '../parsers/setupReturnScanner';

/** 幽灵文本最大展示长度，超出截断并补充 tooltip 全文。 */
const MAX_LABEL_LENGTH = 60;

interface HintCacheEntry {
    version: number;
    length: number;
    hints: SetupReturnHint[];
}

/**
 * Vue3 setup `return { ... }` 块内的幽灵文本注释（Inlay Hint）：
 * 在各 return 项后展示其声明处的注释（行尾注释优先，其次紧邻上方的 // 注释）。
 * 数据来自轻量文本扫描，不依赖 Vue 索引是否已构建；可在设置 setupReturnInlayHints 中关闭。
 */
export class SetupReturnInlayHintsProvider implements vscode.InlayHintsProvider {
    private readonly cache = new Map<string, HintCacheEntry>();

    provideInlayHints(document: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken): vscode.InlayHint[] {
        if (token.isCancellationRequested) { return []; }
        const config = vscode.workspace.getConfiguration('leidong-tools', document.uri);
        if (!config.get<boolean>('setupReturnInlayHints', true)) { return []; }
        const text = document.getText();
        // 仅对 .dev.js 页面或包含 createApp 的 JS 文件生效，避免普通 JS 的 return 对象误触发
        if (!path.basename(document.uri.fsPath).toLowerCase().endsWith('.dev.js') && !text.includes('createApp')) { return []; }

        const result: vscode.InlayHint[] = [];
        for (const hint of this.getHints(document, text)) {
            if (hint.line < range.start.line || hint.line > range.end.line) { continue; }
            const label = hint.doc.length > MAX_LABEL_LENGTH ? `${hint.doc.slice(0, MAX_LABEL_LENGTH)}…` : hint.doc;
            const item = new vscode.InlayHint(new vscode.Position(hint.line, hint.character), label);
            item.paddingLeft = true;
            if (label !== hint.doc) { item.tooltip = hint.doc; }
            result.push(item);
        }
        return result;
    }

    /** 按文档版本缓存扫描结果（Inlay 请求随滚动/编辑频繁触发）。 */
    private getHints(document: vscode.TextDocument, text: string): SetupReturnHint[] {
        const key = document.uri.toString();
        const cached = this.cache.get(key);
        if (cached && cached.version === document.version && cached.length === text.length) {
            return cached.hints;
        }
        const hints = scanSetupReturnHints(text);
        this.cache.set(key, { version: document.version, length: text.length, hints });
        return hints;
    }
}
