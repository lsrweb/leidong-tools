import * as vscode from 'vscode';
import { buildVueIndexForContent, getCachedVueIndex, resolveVueIndexForHtml } from '../parsers/parseDocument';
import type { VueIndex } from '../parsers/parseDocument';
import { monitor } from '../monitoring/performanceMonitor';
import * as path from 'path';

interface VariableItem {
    name: string;
    type: 'data' | 'method' | 'computed';
    line: number;
    uri: string;
}

interface UpdateMessage {
    type: 'update';
    data: {
        variables: VariableItem[];
        fileName: string;
    };
}

interface JumpMessage {
    type: 'jump';
    data: {
        uri: string;
        line: number;
    };
}

interface RefreshMessage {
    type: 'refresh';
}

/**
 * 变量索引 WebView 提供器
 * 支持虚拟滚动，轻松处理万级变量
 */
export class VariableIndexWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'leidong-tools.variableIndexWebview';
    
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _lastParsedUri: string = '';
    private _lastVariables: VariableItem[] = [];

    constructor(private readonly extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri;

        // 保存时只清空本视图的派生缓存，不触发索引构建。
        vscode.workspace.onDidSaveTextDocument((document) => {
            this.invalidateCacheForDocument(document);
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // 处理来自 webview 的消息
        webviewView.webview.onDidReceiveMessage((message: JumpMessage | RefreshMessage) => {
            if (message.type === 'jump') {
                this.jumpToDefinition(message.data.uri, message.data.line);
            } else if (message.type === 'refresh') {
                this.refresh(true);
            }
        });

        // 初始加载只读取已有缓存，不因打开侧边栏而构建索引。
        this.refresh();
    }

    /**
     * 清除文档的缓存
     */
    private invalidateCacheForDocument(document: vscode.TextDocument): void {
        this._lastParsedUri = '';
        this._lastVariables = [];
    }

    /**
     * 刷新变量索引
     */
    public async refresh(manualBuild = false) {
        if (!this._view) {
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this.postMessage({
                type: 'update',
                data: {
                    variables: [],
                    fileName: '未打开文件'
                }
            });
            return;
        }

        const document = editor.document;
        const variables = await this.collectVariables(document, manualBuild);
        const fileName = path.basename(document.uri.fsPath);

        this.postMessage({
            type: 'update',
            data: {
                variables,
                fileName
            }
        });
    }

    /**
     * 收集变量。默认只读取缓存；用户点击刷新按钮时才显式构建。
     */
    @monitor('variableIndexWebview.collectVariables')
    private async collectVariables(document: vscode.TextDocument, manualBuild = false): Promise<VariableItem[]> {
        let cacheKey = document.uri.toString();

        try {
            const vueIndex = this.getVueIndexForDocument(document, manualBuild);
            if (!vueIndex) { return []; }
            cacheKey = `${document.uri.toString()}:${vueIndex.hash}:${manualBuild ? 'manual' : 'cache'}`;
            if (!manualBuild && this._lastParsedUri === cacheKey) {
                return this._lastVariables;
            }

            const variables = this.buildVariableItems(vueIndex);
            this._lastParsedUri = cacheKey;
            this._lastVariables = variables;

            return variables;
        } catch (e) {
            console.error('[VariableIndexWebview] collect error:', e);
            return [];
        }
    }

    private getVueIndexForDocument(document: vscode.TextDocument, manualBuild: boolean): VueIndex | null {
        if (document.languageId === 'html') {
            return resolveVueIndexForHtml(document, manualBuild);
        }
        if (document.languageId === 'javascript' || document.languageId === 'typescript'
            || document.languageId === 'javascriptreact' || document.languageId === 'typescriptreact'
            || document.languageId === 'vue') {
            return manualBuild
                ? buildVueIndexForContent(document.getText(), document.uri, 0)
                : getCachedVueIndex(document.uri);
        }
        return null;
    }

    /**
     * 生成变量列表
     */
    private buildVariableItems(index: VueIndex): VariableItem[] {
        const variables: VariableItem[] = [];
        const seen = new Set<string>();

        const pushItem = (name: string, type: 'data' | 'method' | 'computed', line: number, uri: vscode.Uri) => {
            const key = `${uri.toString()}|${type}|${name}|${line}`;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            variables.push({
                name,
                type,
                line,
                uri: uri.toString()
            });
        };

        index.data.forEach((loc, name) => pushItem(name, 'data', loc.range.start.line + 1, loc.uri));
        index.mixinData.forEach((loc, name) => pushItem(name, 'data', loc.range.start.line + 1, loc.uri));
        index.computed.forEach((loc, name) => pushItem(name, 'computed', loc.range.start.line + 1, loc.uri));
        index.mixinComputed.forEach((loc, name) => pushItem(name, 'computed', loc.range.start.line + 1, loc.uri));
        index.methods.forEach((loc, name) => pushItem(name, 'method', loc.range.start.line + 1, loc.uri));
        index.mixinMethods.forEach((loc, name) => pushItem(name, 'method', loc.range.start.line + 1, loc.uri));

        variables.sort((a, b) => {
            const uriCompare = a.uri.localeCompare(b.uri);
            if (uriCompare !== 0) {
                return uriCompare;
            }
            return a.line - b.line;
        });
        return variables;
    }

    /**
     * 跳转到定义
     */
    private jumpToDefinition(uriString: string, line: number) {
        const uri = vscode.Uri.parse(uriString);
        const position = new vscode.Position(line - 1, 0);
        
        vscode.workspace.openTextDocument(uri).then(doc => {
            vscode.window.showTextDocument(doc, {
                selection: new vscode.Range(position, position),
                preserveFocus: false
            }).then(editor => {
                editor.revealRange(
                    new vscode.Range(position, position),
                    vscode.TextEditorRevealType.InCenter
                );
            });
        });
    }

    /**
     * 发送消息到 webview
     */
    private postMessage(message: UpdateMessage) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    /**
     * 生成 WebView HTML
     */
    private _getHtmlForWebview(webview: vscode.Webview): string {
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'variableIndex.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'variableIndex.js')
        );

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
    <link href="${styleUri}" rel="stylesheet">
    <title>变量索引</title>
</head>
<body>
    <div class="header">
        <div class="search-box">
            <input type="text" id="searchInput" placeholder="🔍 搜索变量..." />
            <button id="refreshBtn" title="手动构建/刷新索引">🔄</button>
        </div>
        <div class="stats" id="stats">加载中...</div>
    </div>
    
    <div class="categories">
        <button class="category-btn active" data-type="all">全部</button>
        <button class="category-btn" data-type="data">Data</button>
        <button class="category-btn" data-type="method">Methods</button>
    </div>

    <div class="pinned-section" id="pinnedSection" style="display: none;">
        <div class="pinned-header">
            <span>📌 Pinned</span>
            <button id="clearPins" title="清空 Pin">清空</button>
        </div>
        <div class="pinned-list" id="pinnedList"></div>
    </div>
    
    <div class="variable-list" id="variableList">
        <!-- 虚拟滚动容器 -->
        <div class="scroll-container" id="scrollContainer">
            <div class="scroll-content" id="scrollContent"></div>
        </div>
    </div>
    
    <div class="empty-state" id="emptyState" style="display: none;">
        <p>📂 未找到 Vue 变量定义</p>
        <p class="hint">点击刷新按钮手动构建当前文件索引</p>
    </div>
    
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
