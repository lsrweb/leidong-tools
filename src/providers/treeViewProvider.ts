import * as vscode from 'vscode';
import { FileWatchManager } from '../managers/fileWatchManager';
import { jsSymbolParser, SymbolType } from '../parsers/jsSymbolParser';
import { resolveVueIndexForHtml, getOrCreateVueIndexFromContent } from '../parsers/parseDocument';
import type { VueIndex } from '../parsers/parseDocument';
import * as path from 'path';
import * as fs from 'fs';


/**
 * 树节点项
 */
export class TreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'root' | 'category' | 'item' | 'empty',
        public readonly data?: any
    ) {
        super(label, collapsibleState);
        
        // 设置图标
        if (type === 'root') {
            this.iconPath = new vscode.ThemeIcon('symbol-namespace');
        } else if (type === 'category') {
            this.iconPath = new vscode.ThemeIcon('folder');
        } else if (type === 'item') {
            this.iconPath = this.getIconForItem();
        } else if (type === 'empty') {
            this.iconPath = new vscode.ThemeIcon('info');
            this.description = '(空)';
        }
        
        // 设置上下文值，用于右键菜单
        this.contextValue = type;
    }
    
    private getIconForItem(): vscode.ThemeIcon {
        const itemType = this.data?.itemType;
        switch (itemType) {
            case 'data':
                return new vscode.ThemeIcon('symbol-property');
            case 'method':
                return new vscode.ThemeIcon('symbol-method');
            case 'computed':
                return new vscode.ThemeIcon('symbol-function');
            case 'watch':
                return new vscode.ThemeIcon('eye');
            case 'filter':
                return new vscode.ThemeIcon('filter');
            case 'lifecycle':
                return new vscode.ThemeIcon('clock');
            case 'prop':
                return new vscode.ThemeIcon('symbol-field');
            default:
                return new vscode.ThemeIcon('symbol-variable');
        }
    }
}

/**
 * 侧边栏 TreeView 提供器
 */
export class LeidongTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeItem | undefined | null | void> = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    
    constructor(
        private fileWatchManager: FileWatchManager
    ) {
        // 监听文档变化，刷新树视图
        vscode.window.onDidChangeActiveTextEditor(() => {
            this.refresh();
        });
        
        // 监听文档保存，刷新树视图
        vscode.workspace.onDidSaveTextDocument(() => {
            this.refresh();
        });
    }
    
    /**
     * 刷新树视图
     */
    refresh(): void {
        this._onDidChangeTreeData.fire();
    }
    
    /**
     * 获取树节点
     */
    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }
    
    /**
     * 获取子节点
     */
    async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        if (!element) {
            // 根节点：两个主菜单
            return [
                new TreeItem('变量索引', vscode.TreeItemCollapsibleState.Expanded, 'root'),
                new TreeItem('监听服务', vscode.TreeItemCollapsibleState.Expanded, 'root')
            ];
        }
        
        if (element.type === 'root') {
            if (element.label === '变量索引') {
                return this.getVariableIndexChildren();
            } else if (element.label === '监听服务') {
                return this.getWatchServiceChildren();
            }
        }
        
        if (element.type === 'category') {
            return this.getCategoryChildren(element);
        }
        
        return [];
    }
    
    /**
     * 简单的外部脚本查找
     */
    private findExternalScript(htmlPath: string): string | null {
        const dir = path.dirname(htmlPath);
        const basename = path.basename(htmlPath, path.extname(htmlPath));
        
        // 查找 js/<basename>.dev.js
        const patterns = [
            path.join(dir, 'js', `${basename}.dev.js`),
            path.join(dir, 'js', basename, `${basename}.dev.js`)
        ];
        
        for (const p of patterns) {
            if (fs.existsSync(p)) {
                return p;
            }
        }
        
        return null;
    }

    /**
     * 提取 HTML 中的内联脚本
     * 返回脚本内容和起始行号
     */
    private extractInlineScript(htmlContent: string): { content: string; startLine: number } | null {
        const lines = htmlContent.split('\n');
        
        // 查找 <script> 标签（排除外部引用）
        let scriptStartLine = -1;
        let scriptEndLine = -1;
        let inScript = false;
        let scriptContent: string[] = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // 检测 script 开始标签（排除有 src 属性的）
            if (/<script[^>]*>/i.test(line) && !line.includes('src=')) {
                inScript = true;
                scriptStartLine = i;
                
                // 检查是否同一行有闭合标签
                const singleLineMatch = /<script[^>]*>([\s\S]*?)<\/script>/i.exec(line);
                if (singleLineMatch) {
                    console.log('[TreeView] Found single-line inline script at line', i);
                    return { content: singleLineMatch[1], startLine: i };
                }
                continue;
            }
            
            // 检测 script 结束标签
            if (inScript && /<\/script>/i.test(line)) {
                scriptEndLine = i;
                inScript = false;
                
                // 找到了完整的 script 块
                if (scriptContent.length > 0) {
                    console.log(`[TreeView] Found multi-line inline script at lines ${scriptStartLine}-${scriptEndLine}`);
                    return { 
                        content: scriptContent.join('\n'), 
                        startLine: scriptStartLine + 1  // +1 因为内容从下一行开始
                    };
                }
            }
            
            // 收集 script 内容
            if (inScript && scriptStartLine !== i) {
                scriptContent.push(line);
            }
        }
        
        // 如果没有找到标准 script 标签，尝试正则匹配 Vue 实例
        console.log('[TreeView] No standard script tag found, trying regex patterns');
        
        // 方法2: 查找 var xxx = new Vue({...})
        const vueVarMatch = /var\s+\w+\s*=\s*new\s+Vue\s*\(/i.exec(htmlContent);
        if (vueVarMatch) {
            const matchIndex = vueVarMatch.index;
            const linesBeforeMatch = htmlContent.substring(0, matchIndex).split('\n');
            const startLine = linesBeforeMatch.length - 1;
            
            // 尝试提取完整的 Vue 对象
            const remainingContent = htmlContent.substring(matchIndex);
            const vueBlockMatch = /var\s+\w+\s*=\s*new\s+Vue\s*\(\s*\{[\s\S]*?\}\s*\)\s*;?/i.exec(remainingContent);
            
            if (vueBlockMatch) {
                console.log('[TreeView] Extracted Vue instance via regex at line', startLine);
                return { content: vueBlockMatch[0], startLine };
            }
        }
        
        // 方法3: 直接查找 new Vue({...})
        const vueMatch = /new\s+Vue\s*\(/i.exec(htmlContent);
        if (vueMatch) {
            const matchIndex = vueMatch.index;
            const linesBeforeMatch = htmlContent.substring(0, matchIndex).split('\n');
            const startLine = linesBeforeMatch.length - 1;
            
            const remainingContent = htmlContent.substring(matchIndex);
            const vueBlockMatch = /new\s+Vue\s*\(\s*\{[\s\S]*?\}\s*\)\s*;?/i.exec(remainingContent);
            
            if (vueBlockMatch) {
                console.log('[TreeView] Extracted Vue instance (new Vue) via regex at line', startLine);
                return { content: vueBlockMatch[0], startLine };
            }
        }
        
        console.log('[TreeView] No inline script extracted');
        return null;
    }
    
    /**
     * 获取变量索引子节点
     */
    private async getVariableIndexChildren(): Promise<TreeItem[]> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return [new TreeItem('请打开一个文件', vscode.TreeItemCollapsibleState.None, 'empty')];
        }
        
        const document = editor.document;
        let parseResult;
        let targetUri = document.uri;
        
        try {
            // HTML 文件：查找外部 JS 文件或内联脚本
            if (document.languageId === 'html') {
                const scriptPath = this.findExternalScript(document.uri.fsPath);
                
                // 优先使用外部 JS 文件
                if (scriptPath && fs.existsSync(scriptPath)) {
                    console.log('[TreeView] Found external script:', scriptPath);
                    targetUri = vscode.Uri.file(scriptPath);
                    const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
                    parseResult = await jsSymbolParser.parse(scriptContent, targetUri);
                    console.log('[TreeView] External script parsed, thisReferences:', parseResult.thisReferences.size);
                } else {
                    // 没有外部文件，解析内联脚本
                    console.log('[TreeView] No external script found, parsing inline script');
                    const inlineScript = this.extractInlineScript(document.getText());
                    
                    if (inlineScript) {
                        console.log('[TreeView] Inline script found at line:', inlineScript.startLine, 'length:', inlineScript.content.length);
                        
                        // 解析内联脚本，传入起始行号用于正确定位
                        parseResult = await jsSymbolParser.parse(inlineScript.content, document.uri, inlineScript.startLine);
                        targetUri = document.uri;
                        console.log('[TreeView] Inline script parsed, thisReferences:', parseResult.thisReferences.size);
                    } else {
                        console.log('[TreeView] No inline script found');
                    }
                }
            } 
            // JS/TS 文件：直接解析
            else if (document.languageId === 'javascript' || document.languageId === 'typescript') {
                console.log('[TreeView] Parsing JS/TS file:', document.uri.fsPath);
                parseResult = await jsSymbolParser.parse(document, document.uri);
                console.log('[TreeView] JS/TS parsed, thisReferences:', parseResult.thisReferences.size);
            }
        } catch (e) {
            console.error('[TreeView] Parse error:', e);
        }
        
        if (!parseResult || parseResult.thisReferences.size === 0) {
            return [new TreeItem('未找到 Vue 定义', vscode.TreeItemCollapsibleState.None, 'empty')];
        }
        
        const categories: TreeItem[] = [];
        
        // 获取 VueIndex（包含 watch/filters/lifecycle）
        let vueIndex: VueIndex | null = null;
        try {
            if (document.languageId === 'html') {
                vueIndex = resolveVueIndexForHtml(document);
            } else if (document.languageId === 'javascript' || document.languageId === 'typescript') {
                vueIndex = getOrCreateVueIndexFromContent(document.getText(), document.uri, 0);
            }
        } catch { /* ignore */ }
        
        // 统计各类型数量
        let dataCount = 0;
        let methodCount = 0;
        
        parseResult.thisReferences.forEach((symbol) => {
            if (symbol.kind === SymbolType.Property) {
                dataCount++;
            } else if (symbol.kind === SymbolType.Method) {
                methodCount++;
            }
        });
        
        // Props (from VueIndex)
        if (vueIndex && vueIndex.props.size > 0) {
            categories.push(new TreeItem(
                `Props (${vueIndex.props.size})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'category',
                { categoryType: 'props', vueIndex, targetUri }
            ));
        }
        
        // Data 属性
        if (dataCount > 0) {
            categories.push(new TreeItem(
                `Data (${dataCount})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'category',
                { categoryType: 'data', parseResult, targetUri }
            ));
        }
        
        // Methods 方法
        if (methodCount > 0) {
            categories.push(new TreeItem(
                `Methods (${methodCount})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'category',
                { categoryType: 'methods', parseResult, targetUri }
            ));
        }

        // Computed (from VueIndex)
        if (vueIndex && vueIndex.computed.size > 0) {
            categories.push(new TreeItem(
                `Computed (${vueIndex.computed.size})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'category',
                { categoryType: 'computed', vueIndex, targetUri }
            ));
        }
        
        // Watch (from VueIndex)
        if (vueIndex && vueIndex.watch.size > 0) {
            categories.push(new TreeItem(
                `Watch (${vueIndex.watch.size})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'category',
                { categoryType: 'watch', vueIndex, targetUri }
            ));
        }
        
        // Filters (from VueIndex)
        if (vueIndex && vueIndex.filters.size > 0) {
            categories.push(new TreeItem(
                `Filters (${vueIndex.filters.size})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'category',
                { categoryType: 'filters', vueIndex, targetUri }
            ));
        }
        
        // Lifecycle (from VueIndex)
        if (vueIndex && vueIndex.lifecycle.size > 0) {
            categories.push(new TreeItem(
                `Lifecycle (${vueIndex.lifecycle.size})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'category',
                { categoryType: 'lifecycle', vueIndex, targetUri }
            ));
        }
        
        if (categories.length === 0) {
            return [new TreeItem('Vue 实例为空', vscode.TreeItemCollapsibleState.None, 'empty')];
        }
        
        return categories;
    }
    
    /**
     * 获取分类子节点（data/methods 的具体项）
     * 性能优化：按代码行号排序，保持原始顺序
     */
    private getCategoryChildren(element: TreeItem): TreeItem[] {
        const { categoryType, parseResult, targetUri, vueIndex } = element.data;
        const items: TreeItem[] = [];
        const fileName = targetUri.fsPath.split(/[\\/]/).pop() || '';
        
        // VueIndex-based categories: props, computed, watch, filters, lifecycle
        if (vueIndex && ['props', 'computed', 'watch', 'filters', 'lifecycle'].includes(categoryType)) {
            const sourceMap: Map<string, any> | undefined = (vueIndex as any)[categoryType];
            if (!sourceMap) { return items; }
            
            // 按 key 名排序
            const sorted = Array.from(sourceMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
            
            for (const [name, loc] of sorted) {
                const itemType = categoryType === 'filters' ? 'filter'
                    : categoryType === 'lifecycle' ? 'lifecycle'
                    : categoryType === 'props' ? 'prop'
                    : categoryType === 'watch' ? 'data'  // watch 用 data 图标
                    : 'data';
                
                const item = new TreeItem(
                    name,
                    vscode.TreeItemCollapsibleState.None,
                    'item',
                    { itemType }
                );
                
                // 附加元信息
                if (categoryType === 'watch' && vueIndex.watchMeta) {
                    const meta = vueIndex.watchMeta.get(name);
                    if (meta) {
                        const flags: string[] = [];
                        if (meta.deep) { flags.push('deep'); }
                        if (meta.immediate) { flags.push('immediate'); }
                        item.description = flags.length > 0 ? flags.join(', ') : '';
                    }
                }
                if (categoryType === 'filters' && vueIndex.filtersMeta) {
                    const meta = vueIndex.filtersMeta.get(name);
                    if (meta) {
                        item.description = `(${meta.params.join(', ')})`;
                    }
                }
                
                // 如果 loc 是 vscode.Location，可以跳转
                if (loc && loc.range) {
                    const pos = loc.range.start;
                    item.tooltip = `${fileName} (line ${pos.line + 1})`;
                    if (!item.description) { item.description = `:${pos.line + 1}`; }
                    item.command = {
                        command: 'leidong-tools.jumpToDefinition',
                        title: 'Jump to Definition',
                        arguments: [targetUri, new vscode.Position(pos.line, pos.character)]
                    };
                }
                
                items.push(item);
            }
            return items;
        }
        
        // 原始 jsSymbolParser 逻辑: data / methods
        const symbols: Array<{ name: string; symbol: any; line: number }> = [];
        
        if (parseResult) {
            parseResult.thisReferences.forEach((symbol: any, name: string) => {
                let shouldInclude = false;
                
                if (categoryType === 'data' && symbol.kind === SymbolType.Property) {
                    shouldInclude = true;
                } else if (categoryType === 'methods' && symbol.kind === SymbolType.Method) {
                    shouldInclude = true;
                }
                
                if (shouldInclude) {
                    symbols.push({
                        name,
                        symbol,
                        line: symbol.range.start.line
                    });
                }
            });
        }
        
        // ✅ 按代码行号排序，保持原始顺序
        symbols.sort((a, b) => a.line - b.line);
        
        // 创建 TreeItem 节点
        symbols.forEach(({ name, symbol }) => {
            const itemType = categoryType === 'data' ? 'data' : 'method';
            const lineNumber = symbol.range.start.line + 1;
            
            const item = new TreeItem(
                name,
                vscode.TreeItemCollapsibleState.None,
                'item',
                { itemType }
            );
            
            // 轻量化：只显示行号，不显示文件名（减少渲染开销）
            item.description = `:${lineNumber}`;
            item.tooltip = `${fileName} (line ${lineNumber})`;
            
            // 设置点击命令
            const jumpPosition = new vscode.Position(symbol.range.start.line, symbol.range.start.character);
            item.command = {
                command: 'leidong-tools.jumpToDefinition',
                title: 'Jump to Definition',
                arguments: [targetUri, jumpPosition]
            };
            
            items.push(item);
        });
        
        return items;
    }
    
    /**
     * 获取监听服务子节点
     */
    private getWatchServiceChildren(): TreeItem[] {
        const watchItems = this.fileWatchManager.getAllWatchItems();
        
        if (watchItems.length === 0) {
            return [new TreeItem('暂无运行的监听服务', vscode.TreeItemCollapsibleState.None, 'empty')];
        }
        
        return watchItems.map((item: any) => {
            const label = item.projectName || '未命名项目';
            const description = item.directory;
            
            const treeItem = new TreeItem(
                label,
                vscode.TreeItemCollapsibleState.None,
                'item',
                { itemType: 'watch', watchId: item.id }
            );
            
            treeItem.description = description;
            treeItem.command = {
                command: 'revealInExplorer',
                title: 'Reveal in Explorer',
                arguments: [vscode.Uri.file(item.directory)]
            };
            
            return treeItem;
        });
    }
}
