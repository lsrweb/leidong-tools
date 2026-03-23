import * as vscode from 'vscode';
import { jsSymbolParser, SymbolType, ParseResult } from '../parsers/jsSymbolParser';
import { getExternalDevScriptPathsForHtml } from '../parsers/parseDocument';
import { monitor } from '../monitoring/performanceMonitor';
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
    private _lastParsedUri: string = '';
    private _lastVariables: VariableItem[] = [];

    constructor(private readonly extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri;

        // ✅ 只在切换文件时刷新（打开新文件）
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                this.refresh();
            }
        });

        // ✅ 保存时只清除缓存，不立即刷新（避免编辑时频繁重建）
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
     * 清除文档的缓存
     */
    private invalidateCacheForDocument(document: vscode.TextDocument): void {
        this._lastParsedUri = '';
        this._lastVariables = [];
        
        // 清除 jsSymbolParser 缓存
        jsSymbolParser.invalidateCache(document.uri);
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
    @monitor('variableIndexWebview.collectVariables')
    private async collectVariables(document: vscode.TextDocument): Promise<VariableItem[]> {
        const results: Array<{ result: ParseResult; uri: vscode.Uri }> = [];
        let cacheKey = document.uri.toString();

        try {
            // HTML 文件处理
            if (document.languageId === 'html') {
                const scriptPaths = getExternalDevScriptPathsForHtml(document);
                if (scriptPaths.length > 0) {
                    cacheKey = scriptPaths.join('|');
                    if (this._lastParsedUri === cacheKey) {
                        console.log('[VariableIndexWebview] 缓存命中，跳过重复解析:', cacheKey);
                        return this._lastVariables;
                    }

                    for (const scriptPath of scriptPaths) {
                        if (!fs.existsSync(scriptPath)) {
                            continue;
                        }
                        const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
                        const scriptUri = vscode.Uri.file(scriptPath);
                        const parsed = await jsSymbolParser.parse(scriptContent, scriptUri);
                        results.push({ result: parsed, uri: scriptUri });
                    }
                } else {
                    const inlineScript = this.extractInlineScript(document.getText());
                    if (inlineScript) {
                        cacheKey = `${document.uri.toString()}:${inlineScript.startLine}`;
                        if (this._lastParsedUri === cacheKey) {
                            console.log('[VariableIndexWebview] 缓存命中，跳过重复解析:', cacheKey);
                            return this._lastVariables;
                        }
                        const parsed = await jsSymbolParser.parse(
                            inlineScript.content,
                            document.uri,
                            inlineScript.startLine
                        );
                        results.push({ result: parsed, uri: document.uri });
                    }
                }
            }
            // JS/TS 文件
            else if (document.languageId === 'javascript' || document.languageId === 'typescript') {
                cacheKey = document.uri.toString();
                if (this._lastParsedUri === cacheKey) {
                    console.log('[VariableIndexWebview] 缓存命中，跳过重复解析:', cacheKey);
                    return this._lastVariables;
                }
                const parsed = await jsSymbolParser.parse(document, document.uri);
                results.push({ result: parsed, uri: document.uri });
            }
        } catch (e) {
            console.error('[VariableIndexWebview] Parse error:', e);
        }

        if (results.length === 0) {
            console.log('[VariableIndexWebview] ? 解析失败，parseResult 为空');
            return [];
        }

        const totals = results.reduce(
            (acc, item) => {
                acc.symbols += item.result.symbols.length;
                acc.variables += item.result.variables.size;
                acc.functions += item.result.functions.size;
                acc.classes += item.result.classes.size;
                acc.thisReferences += item.result.thisReferences.size;
                return acc;
            },
            { symbols: 0, variables: 0, functions: 0, classes: 0, thisReferences: 0 }
        );

        console.log('[VariableIndexWebview] ?? 解析结果:', totals);

        const variables = this.buildVariableItems(results);
        if (variables.length === 0) {
            console.log('[VariableIndexWebview] ? 完全没有找到变量或函数');
        } else {
            console.log(`[VariableIndexWebview] ? 找到 ${variables.length} 个变量/函数`);
        }

        this._lastParsedUri = cacheKey;
        this._lastVariables = variables;

        return variables;
    }

    /**
     * 生成变量列表
     */
    private buildVariableItems(results: Array<{ result: ParseResult; uri: vscode.Uri }>): VariableItem[] {
        const hasThisReferences = results.some(item => item.result.thisReferences.size > 0);
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

        if (hasThisReferences) {
            results.forEach(item => {
                item.result.thisReferences.forEach((symbol, name) => {
                    let type: 'data' | 'method' | 'computed' = 'data';
                    if (symbol.kind === SymbolType.Method) {
                        type = 'method';
                    } else if (symbol.kind === SymbolType.Property) {
                        type = 'data';
                    }
                    pushItem(name, type, symbol.range.start.line + 1, item.uri);
                });
            });
        } else {
            results.forEach(item => {
                item.result.variables.forEach((symbol, name) => {
                    pushItem(name, 'data', symbol.range.start.line + 1, item.uri);
                });
                item.result.functions.forEach((symbol, name) => {
                    pushItem(name, 'method', symbol.range.start.line + 1, item.uri);
                });
            });
        }

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
     * 提取内联脚本（支持多个 script 标签，合并所有内容）
     */
    private extractInlineScript(htmlContent: string): { content: string; startLine: number } | null {
        const lines = htmlContent.split('\n');
        const allScripts: { content: string; startLine: number }[] = [];
        
        let scriptStartLine = -1;
        let inScript = false;
        let scriptContent: string[] = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // 检测 script 开始标签（排除外部引用）
            if (/<script[^>]*>/i.test(line) && !line.includes('src=')) {
                inScript = true;
                scriptStartLine = i;
                
                // 单行 script
                const singleLineMatch = /<script[^>]*>([\s\S]*?)<\/script>/i.exec(line);
                if (singleLineMatch) {
                    allScripts.push({ content: singleLineMatch[1], startLine: i });
                    inScript = false;
                    continue;
                }
                continue;
            }
            
            // 检测 script 结束标签
            if (inScript && /<\/script>/i.test(line)) {
                if (scriptContent.length > 0) {
                    allScripts.push({ 
                        content: scriptContent.join('\n'), 
                        startLine: scriptStartLine + 1
                    });
                }
                inScript = false;
                scriptContent = [];
                scriptStartLine = -1;
                continue;
            }
            
            // 收集 script 内容
            if (inScript && scriptStartLine !== i) {
                scriptContent.push(line);
            }
        }
        
        if (allScripts.length === 0) {
            return null;
        }
        
        // ✅ 策略1: 找到包含 'new Vue' 的 script
        for (const script of allScripts) {
            if (script.content.includes('new Vue')) {
                console.log('[VariableIndexWebview] ✅ 找到包含 new Vue 的 script 标签');
                return script;
            }
        }
        
        // ✅ 策略2: 返回最后一个 script（Vue 实例通常在最后）
        console.log(`[VariableIndexWebview] ⚠️ 未找到 new Vue，返回最后一个 script（共 ${allScripts.length} 个）`);
        return allScripts[allScripts.length - 1];
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
        <p class="hint">打开包含 Vue 实例的文件</p>
    </div>
    
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
