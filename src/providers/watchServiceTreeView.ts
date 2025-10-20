import * as vscode from 'vscode';
import { FileWatchManager } from '../managers/fileWatchManager';

/**
 * 监听服务 TreeView 节点
 */
export class WatchServiceTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'watch' | 'empty',
        public readonly data?: any
    ) {
        super(label, collapsibleState);
        
        if (type === 'watch') {
            this.iconPath = new vscode.ThemeIcon('eye');
        } else if (type === 'empty') {
            this.iconPath = new vscode.ThemeIcon('info');
            this.description = '(空)';
        }
        
        this.contextValue = type;
    }
}

/**
 * 监听服务 TreeDataProvider
 * 只负责显示文件监听列表
 */
export class WatchServiceTreeDataProvider implements vscode.TreeDataProvider<WatchServiceTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<WatchServiceTreeItem | undefined | null | void> = 
        new vscode.EventEmitter<WatchServiceTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<WatchServiceTreeItem | undefined | null | void> = 
        this._onDidChangeTreeData.event;
    
    constructor(private fileWatchManager: FileWatchManager) {}
    
    refresh(): void {
        this._onDidChangeTreeData.fire();
    }
    
    getTreeItem(element: WatchServiceTreeItem): vscode.TreeItem {
        return element;
    }
    
    getChildren(element?: WatchServiceTreeItem): WatchServiceTreeItem[] {
        if (element) {
            return [];
        }
        
        const watchItems = this.fileWatchManager.getAllWatchItems();
        
        if (watchItems.length === 0) {
            return [new WatchServiceTreeItem(
                '暂无运行的监听服务',
                vscode.TreeItemCollapsibleState.None,
                'empty'
            )];
        }
        
        return watchItems.map((item: any) => {
            // 显示项目名称，如果暂停则添加暂停标记
            const statusIcon = item.isPaused ? '⏸️' : '▶️';
            const label = `${statusIcon} ${item.projectName || '未命名项目'}`;
            const description = item.directory;
            
            const treeItem = new WatchServiceTreeItem(
                label,
                vscode.TreeItemCollapsibleState.None,
                'watch',
                { watchId: item.id, isPaused: item.isPaused }
            );
            
            treeItem.description = description;
            
            // 如果暂停了，灰显项目，否则正常显示
            if (item.isPaused) {
                treeItem.iconPath = new vscode.ThemeIcon('pause');
                treeItem.contextValue = 'watch-paused';
            } else {
                treeItem.iconPath = new vscode.ThemeIcon('eye');
                treeItem.contextValue = 'watch-running';
            }
            
            treeItem.command = {
                command: 'revealInExplorer',
                title: 'Reveal in Explorer',
                arguments: [vscode.Uri.file(item.directory)]
            };
            
            return treeItem;
        });
    }
}
