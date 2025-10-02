import * as vscode from 'vscode';
import { jsSymbolParser, SymbolType } from '../parsers/jsSymbolParser';
import * as path from 'path';
import * as fs from 'fs';

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

/**
 * 变量索引 WebView 提供器
 * 支持虚拟滚动，轻松处理万级变量
 */
export class VariableIndexWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'leidong-tools.variableIndexWebview';
    
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;

    constructor(private readonly extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri;

        // 监听文档变化
        vscode.window.onDidChangeActiveTextEditor(() => {
            this.refresh();
        });

        vscode.workspace.onDidSaveTextDocument(() => {
            this.refresh();
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
        webviewView.webview.onDidReceiveMessage((message: JumpMessage) => {
            if (message.type === 'jump') {
                this.jumpToDefinition(message.data.uri, message.data.line);
            } else if (message.type === 'refresh') {
                this.refresh();
            }
        });

        // 初始加载
        this.refresh();
    }

    /**
     * 刷新变量索引
     */
    public async refresh() {
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
        const variables = await this.collectVariables(document);
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
     * 收集变量（支持 HTML 内联脚本和外部 JS）
     */
    private async collectVariables(document: vscode.TextDocument): Promise<VariableItem[]> {
        let parseResult;
        let targetUri = document.uri;

        try {
            // HTML 文件处理
            if (document.languageId === 'html') {
                const scriptPath = this.findExternalScript(document.uri.fsPath);
                
                if (scriptPath && fs.existsSync(scriptPath)) {
                    // 外部 JS 文件
                    targetUri = vscode.Uri.file(scriptPath);
                    const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
                    parseResult = await jsSymbolParser.parse(scriptContent, targetUri);
                } else {
                    // 内联脚本
                    const inlineScript = this.extractInlineScript(document.getText());
                    if (inlineScript) {
                        parseResult = await jsSymbolParser.parse(
                            inlineScript.content,
                            document.uri,
                            inlineScript.startLine
                        );
                        targetUri = document.uri;
                    }
                }
            } 
            // JS/TS 文件
            else if (document.languageId === 'javascript' || document.languageId === 'typescript') {
                parseResult = await jsSymbolParser.parse(document, document.uri);
            }
        } catch (e) {
            console.error('[VariableIndexWebview] Parse error:', e);
        }

        if (!parseResult || parseResult.thisReferences.size === 0) {
            return [];
        }

        // 转换为 VariableItem 数组
        const variables: VariableItem[] = [];
        parseResult.thisReferences.forEach((symbol, name) => {
            let type: 'data' | 'method' | 'computed' = 'data';
            
            if (symbol.kind === SymbolType.Method) {
                type = 'method';
            } else if (symbol.kind === SymbolType.Property) {
                type = 'data';
            }

            variables.push({
                name,
                type,
                line: symbol.range.start.line + 1,
                uri: targetUri.toString()
            });
        });

        // ✅ 按行号排序，保持代码顺序
        variables.sort((a, b) => a.line - b.line);

        return variables;
    }

    /**
     * 查找外部脚本文件
     */
    private findExternalScript(htmlPath: string): string | null {
        const dir = path.dirname(htmlPath);
        const basename = path.basename(htmlPath, path.extname(htmlPath));
        
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
     * 提取内联脚本
     */
    private extractInlineScript(htmlContent: string): { content: string; startLine: number } | null {
        const lines = htmlContent.split('\n');
        let scriptStartLine = -1;
        let inScript = false;
        let scriptContent: string[] = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            if (/<script[^>]*>/i.test(line) && !line.includes('src=')) {
                inScript = true;
                scriptStartLine = i;
                
                const singleLineMatch = /<script[^>]*>([\s\S]*?)<\/script>/i.exec(line);
                if (singleLineMatch) {
                    return { content: singleLineMatch[1], startLine: i };
                }
                continue;
            }
            
            if (inScript && /<\/script>/i.test(line)) {
                if (scriptContent.length > 0) {
                    return { 
                        content: scriptContent.join('\n'), 
                        startLine: scriptStartLine + 1
                    };
                }
            }
            
            if (inScript && scriptStartLine !== i) {
                scriptContent.push(line);
            }
        }
        
        return null;
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
            <button id="refreshBtn" title="刷新">🔄</button>
        </div>
        <div class="stats" id="stats">加载中...</div>
    </div>
    
    <div class="categories">
        <button class="category-btn active" data-type="all">全部</button>
        <button class="category-btn" data-type="data">Data</button>
        <button class="category-btn" data-type="method">Methods</button>
    </div>
    
    <div class="variable-list" id="variableList">
        <!-- 虚拟滚动容器 -->
        <div class="scroll-container" id="scrollContainer">
            <div class="scroll-content" id="scrollContent"></div>
        </div>
    </div>
    
    <div class="empty-state" id="emptyState" style="display: none;">
        <p>📂 未找到 Vue 变量定义</p>
        <p class="hint">打开包含 Vue 实例的文件</p>
    </div>
    
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
