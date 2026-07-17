import * as vscode from 'vscode';

const TOOLBOX_URL = 'https://todo.srliforever.ltd/';
const TOOLBOX_ORIGIN = 'https://todo.srliforever.ltd';

export interface ToolboxPayload {
    text: string;
    language?: string;
    source?: string;
    fileName?: string;
}

/** Shared host for the sidebar view and movable editor panels. */
export class ToolboxWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'leidong-tools.toolboxWebview';
    private sidebarView?: vscode.WebviewView;
    private readonly panels = new Set<vscode.WebviewPanel>();
    private editorPanel?: vscode.WebviewPanel;
    private latestPayload?: ToolboxPayload;

    constructor(private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.sidebarView = webviewView;
        this.configure(webviewView.webview);
        webviewView.onDidDispose(() => {
            if (this.sidebarView === webviewView) { this.sidebarView = undefined; }
        });
    }

    openInEditor(): void {
        if (this.editorPanel) {
            this.editorPanel.reveal(vscode.ViewColumn.Active, true);
            return;
        }
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;
        const panel = vscode.window.createWebviewPanel(
            'leidong-tools.toolboxEditor',
            '在线工具箱',
            { viewColumn: column, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
        );
        this.editorPanel = panel;
        this.panels.add(panel);
        this.configure(panel.webview);
        panel.onDidDispose(() => {
            this.panels.delete(panel);
            if (this.editorPanel === panel) { this.editorPanel = undefined; }
        });
    }

    send(payload: ToolboxPayload): void {
        this.latestPayload = payload;
        this.openInEditor();
        this.sidebarView?.show?.(true);
        this.sidebarView?.webview.postMessage({ type: 'toolboxData', payload });
        for (const panel of this.panels) {
            void panel.webview.postMessage({ type: 'toolboxData', payload });
        }
    }

    private configure(webview: vscode.Webview): void {
        webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
        webview.html = this.getHtml(webview);
        webview.onDidReceiveMessage((message: { command?: string }) => {
            if (message.command === 'openExternal') {
                void vscode.env.openExternal(vscode.Uri.parse(TOOLBOX_URL));
            }
        });
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = createNonce();
        const csp = [
            "default-src 'none'",
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
            `frame-src ${TOOLBOX_ORIGIN}`,
        ].join('; ');
        const pending = JSON.stringify(this.latestPayload ?? null).replace(/</g, '\\u003c');

        return /* html */ `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}"><title>工具箱</title>
<style>
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden}body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)}.toolbar{height:34px;padding:5px 8px;display:flex;gap:6px;align-items:center;border-bottom:1px solid var(--vscode-panel-border)}.title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--vscode-descriptionForeground)}button{border:0;border-radius:3px;padding:4px 8px;cursor:pointer;font-size:12px;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}button:hover{background:var(--vscode-button-secondaryHoverBackground)}iframe{display:block;width:100%;height:calc(100% - 34px);border:0;background:var(--vscode-editor-background)}
</style></head><body>
<div class="toolbar"><span class="title">todo.srliforever.ltd · 工具箱</span><button type="button" id="reload" title="刷新">↻</button><button type="button" id="external" title="在默认浏览器打开">↗</button></div>
<iframe id="toolbox" title="工具箱" src="${TOOLBOX_URL}" sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"></iframe>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(),frame=document.getElementById('toolbox');let pending=${pending};
function deliver(){if(!pending||!frame.contentWindow)return;frame.contentWindow.postMessage({source:'leidong-vscode-tools',type:'receive-text',payload:pending},'${TOOLBOX_ORIGIN}');}
frame.addEventListener('load',()=>{frame.contentWindow.postMessage({source:'leidong-vscode-tools',type:'host-ready'},'${TOOLBOX_ORIGIN}');deliver();});
window.addEventListener('message',event=>{const message=event.data;if(message?.type==='toolboxData'){pending=message.payload;deliver();}});
document.getElementById('reload').addEventListener('click',()=>{frame.src=frame.src});document.getElementById('external').addEventListener('click',()=>vscode.postMessage({command:'openExternal'}));
</script></body></html>`;
    }
}

function createNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index += 1) { value += alphabet.charAt(Math.floor(Math.random() * alphabet.length)); }
    return value;
}
