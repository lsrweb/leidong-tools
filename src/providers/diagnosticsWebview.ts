import * as vscode from 'vscode';
import { getVueIndexCacheStats } from '../parsers/parseDocument';
import { getTemplateIndexCacheStats } from '../finders/templateIndexer';
import { documentParseCache } from '../cache/cacheManager';

interface DiagnosticsPayload {
    updatedAt: number;
    vueIndex: ReturnType<typeof getVueIndexCacheStats>;
    templateIndex: ReturnType<typeof getTemplateIndexCacheStats>;
    documentParse: ReturnType<typeof documentParseCache.getStats>;
}

interface DiagnosticsUpdateMessage {
    type: 'update';
    data: DiagnosticsPayload;
}

interface DiagnosticsRequestMessage {
    type: 'refresh';
}

export class DiagnosticsWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'leidong-tools.diagnosticsWebview';

    private _view?: vscode.WebviewView;

    constructor(private readonly extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((message: DiagnosticsRequestMessage) => {
            if (message.type === 'refresh') {
                this.refresh();
            }
        });

        this.refresh();
    }

    public refresh() {
        const data = this.collectStats();
        this.postMessage({ type: 'update', data });
    }

    private collectStats(): DiagnosticsPayload {
        return {
            updatedAt: Date.now(),
            vueIndex: getVueIndexCacheStats(),
            templateIndex: getTemplateIndexCacheStats(),
            documentParse: documentParseCache.getStats()
        };
    }

    private postMessage(message: DiagnosticsUpdateMessage) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'diagnostics.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'diagnostics.js')
        );

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
    <link href="${styleUri}" rel="stylesheet">
    <title>诊断面板</title>
</head>
<body>
    <div class="app">
        <header class="header">
            <div>
                <div class="eyebrow">诊断面板</div>
                <h1>索引与缓存状态</h1>
                <div class="subtitle" id="lastUpdated">最后更新: --</div>
            </div>
            <button id="refreshBtn" class="refresh-btn" title="刷新">刷新</button>
        </header>

        <section class="grid">
            <div class="card">
                <div class="card-title">Vue 索引 (Vue Index)</div>
                <div class="card-body">
                    <div class="metric"><span>条目数</span><strong id="vueIndexSize">0</strong></div>
                    <div class="metric"><span>最后构建</span><strong id="vueIndexBuilt">--</strong></div>
                    <div class="metric"><span>外部构建</span><strong id="vueIndexExternal">--</strong></div>
                    <div class="metric"><span>外部缓存</span><strong id="vueIndexExternalSize">0</strong></div>
                </div>
            </div>

            <div class="card">
                <div class="card-title">模板索引 (Template Index)</div>
                <div class="card-body">
                    <div class="metric"><span>条目数</span><strong id="templateIndexSize">0</strong></div>
                    <div class="metric"><span>最后构建</span><strong id="templateIndexBuilt">--</strong></div>
                </div>
            </div>

            <div class="card full">
                <div class="card-title">文档解析缓存 (Document Parse Cache)</div>
                <div class="card-body">
                    <div class="metric"><span>条目数</span><strong id="documentParseSize">0</strong></div>
                    <div class="metric"><span>最大容量</span><strong id="documentParseMax">0</strong></div>
                    <div class="metric"><span>总访问量</span><strong id="documentParseAccess">0</strong></div>
                    <div class="metric"><span>平均访问</span><strong id="documentParseAvg">0</strong></div>
                </div>
            </div>
        </section>
    </div>

    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
