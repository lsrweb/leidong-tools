import * as vscode from 'vscode';
import { scanWorkspaceText, collectLineHits, WorkspaceTextHit } from '../finders/workspaceTextSearch';

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 跨文件引用（Shift+F12 / 右键「查找所有引用」/ Peek References）：
 * 在工作区内搜索光标符号的全部出现（全局组件 window.xxx、页面方法、工具函数等），
 * 当前文档使用内存内容，未保存的编辑也能被搜到；
 * 已有文件级 Vue 引用提供器（enableReferences）的结果会与本结果自动合并。
 */
export class WorkspaceReferenceProvider implements vscode.ReferenceProvider {
    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.ReferenceContext,
        token: vscode.CancellationToken,
    ): Promise<vscode.Location[] | null> {
        const config = vscode.workspace.getConfiguration('leidong-tools', document.uri);
        if (!config.get<boolean>('enableWorkspaceReferences', true)) { return null; }
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_$][\w$]*/);
        if (!wordRange) { return null; }
        const word = document.getText(wordRange);
        if (word.length < 2) { return null; }

        const pattern = `\\b${escapeRegExp(word)}\\b`;
        const hits = await scanWorkspaceText(pattern, { maxResults: 300 }, token);
        // 当前文档优先用内存内容：未保存的编辑同样能命中
        let merged = hits;
        if (document.isDirty) {
            const inMemory: WorkspaceTextHit[] = [];
            collectLineHits(document.uri, document.getText(), new RegExp(pattern, 'gd'), { maxHitsPerFile: 300, maxResults: 300 }, inMemory);
            merged = [...hits.filter(hit => hit.uri.toString() !== document.uri.toString()), ...inMemory];
        }
        if (!merged.length) { return null; }
        return merged.map(hit => new vscode.Location(hit.uri, new vscode.Range(hit.line, hit.character, hit.line, hit.character + hit.length)));
    }
}
