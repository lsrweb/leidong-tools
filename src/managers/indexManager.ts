import { buildAndCacheTemplateIndex, removeTemplateIndex, pruneTemplateIndex, recreateTemplateIndexCache } from '../finders/templateIndexer';
import { getOrCreateVueIndexFromContent, removeVueIndexForUri, recreateVueIndexCache, pruneVueIndexCache } from '../parsers/parseDocument';
import * as vscode from 'vscode';

/** 管理索引的生命周期：仅在文档打开或可见时构建索引；文档隐藏或关闭时移除索引 */
export function registerIndexLifecycle(context: vscode.ExtensionContext) {
    const disposables: vscode.Disposable[] = [];
    let rebuildOnSave = vscode.workspace.getConfiguration('leidong-tools').get<boolean>('rebuildOnSave', true);

    // watch for config change
    disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('leidong-tools.maxIndexEntries')) {
            recreateVueIndexCache();
        }
        if (e.affectsConfiguration('leidong-tools.maxTemplateIndexEntries')) {
            recreateTemplateIndexCache();
        }
        if (e.affectsConfiguration('leidong-tools.rebuildOnSave')) {
            rebuildOnSave = vscode.workspace.getConfiguration('leidong-tools').get<boolean>('rebuildOnSave', true);
        }
    }));

    // 在编辑器打开或切换到可见时构建索引（force rebuild）
    const ensureIndexForEditor = (editor: vscode.TextEditor | undefined) => {
        if (!editor) { return; }
        const doc = editor.document;
        if (doc.languageId === 'html') { buildAndCacheTemplateIndex(doc); }
        if (doc.languageId === 'javascript' || doc.languageId === 'typescript') {
            // 强制重建 JS index for current file
            getOrCreateVueIndexFromContent(doc.getText(), doc.uri, 0, true);
        }
    };

    disposables.push(vscode.window.onDidChangeVisibleTextEditors((editors) => {
        // 可见编辑器改变：为所有可见的editor确保索引
        editors.forEach(e => ensureIndexForEditor(e));
    }));

    disposables.push(vscode.workspace.onDidOpenTextDocument((doc) => {
        // 打开文件时建立索引
        if (doc.languageId === 'html') { buildAndCacheTemplateIndex(doc); }
        if (doc.languageId === 'javascript' || doc.languageId === 'typescript') {
            getOrCreateVueIndexFromContent(doc.getText(), doc.uri, 0, true);
        }
    }));

    // 在保存时（可配置）触发重建索引
    disposables.push(vscode.workspace.onDidSaveTextDocument((doc) => {
        if (!rebuildOnSave) { return; }
        if (doc.languageId === 'html') { buildAndCacheTemplateIndex(doc); }
        if (doc.languageId === 'javascript' || doc.languageId === 'typescript') { getOrCreateVueIndexFromContent(doc.getText(), doc.uri, 0, true); }
    }));

    disposables.push(vscode.workspace.onDidCloseTextDocument((doc) => {
        // 关闭文件时清理缓存
        removeTemplateIndex(doc as any);
        removeVueIndexForUri(doc.uri);
    }));

    // 定期修剪长时间未访问的模板索引
    const pruneInterval = setInterval(() => { pruneTemplateIndex(); pruneVueIndexCache(); }, 1000 * 60 * 10);
    context.subscriptions.push({ dispose: () => clearInterval(pruneInterval) });

    disposables.forEach(d => context.subscriptions.push(d));
}
