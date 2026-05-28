import { buildAndCacheTemplateIndex, removeTemplateIndex, pruneTemplateIndex, recreateTemplateIndexCache } from '../finders/templateIndexer';
import { buildVueIndexForContent, removeVueIndexForUri, recreateVueIndexCache, pruneVueIndexCache, resolveVueIndexForHtml } from '../parsers/parseDocument';
import * as vscode from 'vscode';

type IndexBuildMode = 'manual' | 'onSave' | 'interval';

function getIndexBuildMode(): IndexBuildMode {
    try {
        const mode = vscode.workspace.getConfiguration('leidong-tools').get<string>('indexBuildMode', 'manual');
        if (mode === 'onSave' || mode === 'interval') { return mode; }
        return 'manual';
    } catch {
        return 'manual';
    }
}

function getIndexBuildIntervalMs(): number {
    try {
        const minutes = vscode.workspace.getConfiguration('leidong-tools').get<number>('indexBuildIntervalMinutes', 10);
        return Math.max(1, minutes || 10) * 60 * 1000;
    } catch {
        return 10 * 60 * 1000;
    }
}

function isIndexableDocument(document: vscode.TextDocument): boolean {
    return document.languageId === 'html'
        || document.languageId === 'javascript'
        || document.languageId === 'typescript'
        || document.languageId === 'javascriptreact'
        || document.languageId === 'typescriptreact'
        || document.languageId === 'vue';
}

export function buildVueRelatedIndexesForDocument(document: vscode.TextDocument): boolean {
    if (!isIndexableDocument(document)) { return false; }

    if (document.languageId === 'html') {
        resolveVueIndexForHtml(document, true);
        buildAndCacheTemplateIndex(document);
        return true;
    }

    buildVueIndexForContent(document.getText(), document.uri, 0);
    return true;
}

/** 管理索引生命周期：默认只清理/失效缓存；构建必须由手动命令、保存模式或定时模式触发。 */
export function registerIndexLifecycle(context: vscode.ExtensionContext) {
    const disposables: vscode.Disposable[] = [];
    let intervalTimer: NodeJS.Timeout | null = null;

    // watch for config change
    disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('leidong-tools.maxIndexEntries')) {
            recreateVueIndexCache();
        }
        if (e.affectsConfiguration('leidong-tools.maxTemplateIndexEntries')) {
            recreateTemplateIndexCache();
        }
        if (e.affectsConfiguration('leidong-tools.indexBuildMode') || e.affectsConfiguration('leidong-tools.indexBuildIntervalMinutes')) {
            resetIntervalBuild();
        }
    }));

    disposables.push(vscode.workspace.onDidCloseTextDocument((doc) => {
        // 关闭文件时清理缓存
        removeTemplateIndex(doc as any);
        removeVueIndexForUri(doc.uri);
    }));

    disposables.push(vscode.workspace.onDidSaveTextDocument((doc) => {
        removeTemplateIndex(doc as any);
        removeVueIndexForUri(doc.uri);
        if (getIndexBuildMode() === 'onSave') {
            buildVueRelatedIndexesForDocument(doc);
        }
    }));

    function resetIntervalBuild() {
        if (intervalTimer) {
            clearInterval(intervalTimer);
            intervalTimer = null;
        }
        if (getIndexBuildMode() !== 'interval') { return; }

        intervalTimer = setInterval(() => {
            const seen = new Set<string>();
            for (const editor of vscode.window.visibleTextEditors) {
                const doc = editor.document;
                const key = doc.uri.toString();
                if (seen.has(key) || doc.isClosed || doc.isDirty) { continue; }
                seen.add(key);
                buildVueRelatedIndexesForDocument(doc);
            }
        }, getIndexBuildIntervalMs());
    }

    resetIntervalBuild();

    // 定期修剪长时间未访问的缓存（每 5 分钟，最长保留 30 分钟）
    const pruneInterval = setInterval(() => { pruneTemplateIndex(); pruneVueIndexCache(1000 * 60 * 30); }, 1000 * 60 * 5);
    context.subscriptions.push({ dispose: () => clearInterval(pruneInterval) });
    context.subscriptions.push({ dispose: () => { if (intervalTimer) { clearInterval(intervalTimer); } } });

    disposables.forEach(d => context.subscriptions.push(d));
}
