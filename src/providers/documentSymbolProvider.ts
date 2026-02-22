/**
 * DocumentSymbolProvider - Breadcrumb / Outline 增强
 * 让 VS Code 的面包屑导航和大纲视图 (Ctrl+Shift+O) 识别
 * Vue 2 CDN 文件的结构层级: data > props > methods > computed > watch > lifecycle > filters
 */
import * as vscode from 'vscode';
import { resolveVueIndexForHtml, getOrCreateVueIndexFromContent } from '../parsers/parseDocument';
import type { VueIndex } from '../parsers/parseDocument';

export class VueDocumentSymbolProvider implements vscode.DocumentSymbolProvider {

    provideDocumentSymbols(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.DocumentSymbol[] | null {
        const config = vscode.workspace.getConfiguration('leidong-tools');
        if (!config.get<boolean>('enableOutlineSymbols', false)) {
            return null;
        }

        let vueIndex: VueIndex | null = null;
        try {
            if (document.languageId === 'html') {
                vueIndex = resolveVueIndexForHtml(document);
            } else if (document.languageId === 'javascript' || document.languageId === 'typescript') {
                vueIndex = getOrCreateVueIndexFromContent(document.getText(), document.uri, 0);
            }
        } catch { /* ignore */ }

        if (!vueIndex) { return null; }

        const symbols: vscode.DocumentSymbol[] = [];
        const docUri = document.uri;

        // Helper: 从 Map 创建子 symbols
        const buildChildren = (
            map: Map<string, vscode.Location>,
            kind: vscode.SymbolKind,
            detail?: string,
            metaMap?: Map<string, { params?: string[]; doc?: string; type?: string }>
        ): vscode.DocumentSymbol[] => {
            const children: vscode.DocumentSymbol[] = [];
            // 按行号排序
            const sorted = Array.from(map.entries())
                .filter(([_, loc]) => loc.uri.fsPath === docUri.fsPath)
                .sort((a, b) => a[1].range.start.line - b[1].range.start.line);

            for (const [name, loc] of sorted) {
                const range = new vscode.Range(loc.range.start, new vscode.Position(loc.range.start.line, loc.range.start.character + name.length + 20));
                const selRange = new vscode.Range(loc.range.start, new vscode.Position(loc.range.start.line, loc.range.start.character + name.length));
                let detailStr = detail || '';
                if (metaMap) {
                    const meta = metaMap.get(name);
                    if (meta) {
                        if ((meta as any).params?.length) {
                            detailStr = `(${(meta as any).params.join(', ')})`;
                        }
                        if ((meta as any).type) {
                            detailStr = (meta as any).type;
                        }
                    }
                }
                children.push(new vscode.DocumentSymbol(name, detailStr, kind, range, selRange));
            }
            return children;
        };

        // Helper: 创建分类父节点
        const addCategory = (
            name: string,
            icon: vscode.SymbolKind,
            map: Map<string, vscode.Location>,
            childKind: vscode.SymbolKind,
            childDetail?: string,
            metaMap?: Map<string, any>
        ) => {
            if (map.size === 0) { return; }
            const children = buildChildren(map, childKind, childDetail, metaMap);
            if (children.length === 0) { return; }
            // 分类节点使用第一个子节点到最后一个子节点的范围
            const first = children[0].range.start;
            const last = children[children.length - 1].range.end;
            const catRange = new vscode.Range(first, last);
            const catSymbol = new vscode.DocumentSymbol(
                name, `${children.length}`,
                icon, catRange, catRange
            );
            catSymbol.children = children;
            symbols.push(catSymbol);
        };

        // Props
        addCategory('Props', vscode.SymbolKind.Interface, vueIndex.props, vscode.SymbolKind.Field, '', vueIndex.propsMeta);
        // Data
        addCategory('Data', vscode.SymbolKind.Struct, vueIndex.data, vscode.SymbolKind.Property, '', vueIndex.dataMeta);
        // Computed
        addCategory('Computed', vscode.SymbolKind.Struct, vueIndex.computed, vscode.SymbolKind.Property, '', vueIndex.computedMeta);
        // Methods
        addCategory('Methods', vscode.SymbolKind.Module, vueIndex.methods, vscode.SymbolKind.Method, '', vueIndex.methodMeta);
        // Watch
        addCategory('Watch', vscode.SymbolKind.Event, vueIndex.watch, vscode.SymbolKind.Event, '', vueIndex.watchMeta);
        // Filters
        addCategory('Filters', vscode.SymbolKind.Namespace, vueIndex.filters, vscode.SymbolKind.Function, '', vueIndex.filtersMeta);
        // Lifecycle
        addCategory('Lifecycle', vscode.SymbolKind.Constructor, vueIndex.lifecycle, vscode.SymbolKind.Function);
        // Mixin Data (展平)
        if (vueIndex.mixinData.size > 0) {
            addCategory('Mixin Data', vscode.SymbolKind.Struct, vueIndex.mixinData, vscode.SymbolKind.Property);
        }
        if (vueIndex.mixinMethods.size > 0) {
            addCategory('Mixin Methods', vscode.SymbolKind.Module, vueIndex.mixinMethods, vscode.SymbolKind.Method);
        }
        if (vueIndex.mixinComputed.size > 0) {
            addCategory('Mixin Computed', vscode.SymbolKind.Struct, vueIndex.mixinComputed, vscode.SymbolKind.Property);
        }

        return symbols.length > 0 ? symbols : null;
    }
}
