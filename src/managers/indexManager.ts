import { removeTemplateIndex, pruneTemplateIndex, recreateTemplateIndexCache } from '../finders/templateIndexer';
import { removeVueIndexForUri, recreateVueIndexCache, pruneVueIndexCache } from '../parsers/parseDocument';
import * as vscode from 'vscode';

/** 管理索引的生命周期：仅在文档打开或可见时构建索引；文档隐藏或关闭时移除索引 */
export function registerIndexLifecycle(context: vscode.ExtensionContext) {
    const disposables: vscode.Disposable[] = [];

    // watch for config change
    disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('leidong-tools.maxIndexEntries')) {
            recreateVueIndexCache();
        }
        if (e.affectsConfiguration('leidong-tools.maxTemplateIndexEntries')) {
            recreateTemplateIndexCache();
        }
    }));

    disposables.push(vscode.workspace.onDidCloseTextDocument((doc) => {
        // 关闭文件时清理缓存
        removeTemplateIndex(doc as any);
        removeVueIndexForUri(doc.uri);
    }));

    // 定期修剪长时间未访问的缓存（每 5 分钟，最长保留 30 分钟）
    const pruneInterval = setInterval(() => { pruneTemplateIndex(); pruneVueIndexCache(1000 * 60 * 30); }, 1000 * 60 * 5);
    context.subscriptions.push({ dispose: () => clearInterval(pruneInterval) });

    disposables.forEach(d => context.subscriptions.push(d));
}
