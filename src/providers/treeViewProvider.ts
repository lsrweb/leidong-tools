import * as vscode from 'vscode';
import { FileWatchManager } from '../managers/fileWatchManager';
import { resolveVueIndexForHtml } from '../parsers/parseDocument';

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
        
        // 设置命令
        if (type === 'item' && data?.command) {
            this.command = data.command;
        }
        
        // 设置描述
        if (data?.description) {
            this.description = data.description;
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
     * 获取变量索引子节点
     */
    private async getVariableIndexChildren(): Promise<TreeItem[]> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return [new TreeItem('请打开一个文件', vscode.TreeItemCollapsibleState.None, 'empty')];
        }
        
        const document = editor.document;
        
        // 只处理 HTML 文件
        if (document.languageId !== 'html') {
            return [new TreeItem('仅支持 HTML 文件', vscode.TreeItemCollapsibleState.None, 'empty')];
        }
        
        // 获取 Vue 索引
        const vueIndex = resolveVueIndexForHtml(document);
        
        if (!vueIndex || (vueIndex.data.size === 0 && vueIndex.methods.size === 0 && vueIndex.computed.size === 0)) {
            return [new TreeItem('未找到 Vue 定义', vscode.TreeItemCollapsibleState.None, 'empty')];
        }
        
        const categories: TreeItem[] = [];
        
        // Data 属性
        if (vueIndex.data.size > 0) {
            categories.push(new TreeItem(
                `Data (${vueIndex.data.size})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'category',
                { categoryType: 'data', vueIndex, document }
            ));
        }
        
        // Methods 方法
        if (vueIndex.methods.size > 0) {
            categories.push(new TreeItem(
                `Methods (${vueIndex.methods.size})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'category',
                { categoryType: 'methods', vueIndex, document }
            ));
        }
        
        // Computed 计算属性
        if (vueIndex.computed.size > 0) {
            categories.push(new TreeItem(
                `Computed (${vueIndex.computed.size})`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'category',
                { categoryType: 'computed', vueIndex, document }
            ));
        }
        
        if (categories.length === 0) {
            return [new TreeItem('Vue 实例为空', vscode.TreeItemCollapsibleState.None, 'empty')];
        }
        
        return categories;
    }
    
    /**
     * 获取分类子节点（data/methods/computed 的具体项）
     */
    private getCategoryChildren(element: TreeItem): TreeItem[] {
        const { categoryType, vueIndex, document } = element.data;
        const items: TreeItem[] = [];
        
        let map: Map<string, any>;
        let itemType: string;
        
        switch (categoryType) {
            case 'data':
                map = vueIndex.data;
                itemType = 'data';
                break;
            case 'methods':
                map = vueIndex.methods;
                itemType = 'method';
                break;
            case 'computed':
                map = vueIndex.computed;
                itemType = 'computed';
                break;
            default:
                return [];
        }
        
        for (const [name, location] of map.entries()) {
            const item = new TreeItem(
                name,
                vscode.TreeItemCollapsibleState.None,
                'item',
                {
                    itemType,
                    command: {
                        command: 'leidong-tools.jumpToDefinition',
                        title: 'Jump to Definition',
                        arguments: [document.uri, location]
                    }
                }
            );
            items.push(item);
        }
        
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
            
            return new TreeItem(
                label,
                vscode.TreeItemCollapsibleState.None,
                'item',
                {
                    itemType: 'watch',
                    description,
                    command: {
                        command: 'revealInExplorer',
                        title: 'Reveal in Explorer',
                        arguments: [vscode.Uri.file(item.directory)]
                    },
                    watchId: item.id
                }
            );
        });
    }
}
