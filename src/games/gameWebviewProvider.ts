/**
 * 游戏面板 Webview Provider - 轻量级远程加载器
 * 
 * 设计理念：
 *   扩展端只是一个「浏览器壳」
 *   所有游戏页面、逻辑、资源都由服务端提供
 *   更新游戏只需部署服务器，无需重新发布扩展
 */
import * as vscode from 'vscode';
import { DEFAULT_SERVER_CONFIG } from './gameTypes';
import { getPlayerUid, getDeviceHash, getPlayerNickname, ensurePlayerNickname, changePlayerNickname, handleUidConflict } from './playerIdentity';

/**
 * 游戏侧边栏 - 显示服务器连接和游戏入口
 */
export class GameSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'leidong-tools.gameSidebar';

    private _view?: vscode.WebviewView;
    private _serverUrl: string;

    constructor(private readonly _extensionUri: vscode.Uri) {
        const config = vscode.workspace.getConfiguration('leidong-tools');
        this._serverUrl = config.get<string>('gameServerUrl', DEFAULT_SERVER_CONFIG.httpUrl);
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtml();

        // 处理来自 webview 的消息
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'openGame':
                    GamePanel.createOrShow(this._extensionUri, message.serverUrl || this._serverUrl);
                    break;
                case 'updateServerUrl':
                    this._serverUrl = message.serverUrl;
                    break;
                case 'checkServer': {
                    const ok = await this._checkServer(message.serverUrl || this._serverUrl);
                    this._view?.webview.postMessage({ command: 'serverStatus', online: ok });
                    break;
                }
                case 'getPlayerInfo': {
                    const nickname = getPlayerNickname() || '未设置';
                    const uid = getPlayerUid();
                    const deviceHash = getDeviceHash();
                    this._view?.webview.postMessage({ command: 'playerInfo', nickname, uid, deviceHash });
                    break;
                }
                case 'changeNickname': {
                    const newName = await changePlayerNickname();
                    if (newName) {
                        this._view?.webview.postMessage({ command: 'playerInfo', nickname: newName, uid: getPlayerUid() });
                    }
                    break;
                }
            }
        });
    }

    /** 检查服务器是否在线 */
    private async _checkServer(url: string): Promise<boolean> {
        try {
            const http = require('http');
            return new Promise((resolve) => {
                const req = http.get(`${url}/api/status`, (res: any) => {
                    resolve(res.statusCode === 200);
                });
                req.on('error', () => resolve(false));
                req.setTimeout(3000, () => { req.destroy(); resolve(false); });
            });
        } catch {
            return false;
        }
    }

    private _getHtml(): string {
        return /* html */`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            padding: 10px;
        }
        .section { margin-bottom: 14px; }
        .section-title {
            font-size: 11px;
            text-transform: uppercase;
            color: var(--vscode-sideBarSectionHeader-foreground);
            margin-bottom: 6px;
            font-weight: 600;
            letter-spacing: 0.5px;
        }
        .btn {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 6px 12px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
            width: 100%;
            justify-content: center;
            margin-bottom: 4px;
            transition: background 0.2s;
        }
        .btn:hover { background: var(--vscode-button-hoverBackground); }
        .btn.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        input {
            width: 100%;
            padding: 5px 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            margin-bottom: 6px;
            font-size: 12px;
            outline: none;
        }
        input:focus { border-color: var(--vscode-focusBorder); }
        .status-row {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 8px;
            font-size: 12px;
        }
        .status-dot {
            width: 8px; height: 8px;
            border-radius: 50%;
            display: inline-block;
            transition: background 0.3s;
        }
        .status-dot.online { background: #4caf50; }
        .status-dot.offline { background: #f44336; }
        .status-dot.checking { background: #ff9800; animation: pulse 1s infinite; }
        @keyframes pulse { 50% { opacity: 0.3; } }
        .tip {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 8px;
            padding: 8px;
            background: var(--vscode-editor-background);
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
            line-height: 1.5;
        }
    </style>
</head>
<body>
    <!-- 玩家信息 -->
    <div class="section">
        <div class="section-title">👤 玩家信息</div>
        <div class="status-row" style="justify-content:space-between">
            <span>昵称：<strong id="nicknameDisplay">加载中...</strong></span>
            <span style="font-size:11px;cursor:pointer;color:var(--vscode-textLink-foreground)" onclick="changeNickname()">✏️ 修改</span>
        </div>
        <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:-4px">UID: <code id="uidDisplay" style="font-size:10px">-</code></div>
    </div>

    <!-- 服务器配置 -->
    <div class="section">
        <div class="section-title">🌐 游戏服务器</div>
        <div class="status-row">
            <span class="status-dot offline" id="statusDot"></span>
            <span id="statusText">未检测</span>
        </div>
        <input type="text" id="serverUrl" value="${this._serverUrl}" placeholder="http://localhost:8088" />
        <button class="btn secondary" onclick="checkServer()">🔍 检测服务器</button>
        <div id="serverGuide" class="tip" style="display:none;margin-top:4px;border-color:var(--vscode-editorWarning-foreground)">
            ⚠️ 服务器未启动，请在终端运行：<br>
            <code style="font-size:11px">cd server && php start.php --dev</code><br>
            <span style="font-size:10px;opacity:0.7">将在 <span id="retryCountdown">30</span>s 后自动重试</span>
        </div>
    </div>

    <!-- 进入游戏 -->
    <div class="section">
        <div class="section-title">🎮 小游戏</div>
        <button class="btn" onclick="openGame()">🚀 打开游戏大厅</button>
    </div>

    <div class="tip">
        💡 所有游戏在服务端运行，扩展只是浏览器壳。<br>
        新游戏上线只需更新服务器，无需更新扩展。
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let retryTimer = null;
        let retrySeconds = 0;

        function getServerUrl() {
            return document.getElementById('serverUrl').value.replace(/\\/+$/, '');
        }

        function checkServer() {
            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');
            dot.className = 'status-dot checking';
            text.textContent = '检测中...';
            stopRetry();
            vscode.postMessage({ command: 'checkServer', serverUrl: getServerUrl() });
        }

        function openGame() {
            const url = getServerUrl();
            vscode.postMessage({ command: 'updateServerUrl', serverUrl: url });
            vscode.postMessage({ command: 'openGame', serverUrl: url });
        }

        function changeNickname() {
            vscode.postMessage({ command: 'changeNickname' });
        }

        function startRetry() {
            stopRetry();
            retrySeconds = 30;
            const guide = document.getElementById('serverGuide');
            const countdown = document.getElementById('retryCountdown');
            if (guide) guide.style.display = 'block';
            retryTimer = setInterval(() => {
                retrySeconds--;
                if (countdown) countdown.textContent = retrySeconds;
                if (retrySeconds <= 0) {
                    checkServer();
                }
            }, 1000);
        }

        function stopRetry() {
            if (retryTimer) clearInterval(retryTimer);
            retryTimer = null;
            const guide = document.getElementById('serverGuide');
            if (guide) guide.style.display = 'none';
        }

        // 接收消息
        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.command === 'serverStatus') {
                const dot = document.getElementById('statusDot');
                const text = document.getElementById('statusText');
                dot.className = 'status-dot ' + (msg.online ? 'online' : 'offline');
                text.textContent = msg.online ? '✅ 在线' : '❌ 离线';
                if (msg.online) {
                    stopRetry();
                } else {
                    startRetry();
                }
            }
            if (msg.command === 'playerInfo') {
                document.getElementById('nicknameDisplay').textContent = msg.nickname || '-';
                document.getElementById('uidDisplay').textContent = msg.uid || '-';
            }
        });

        // 初始化：获取玩家信息 + 检测服务器
        vscode.postMessage({ command: 'getPlayerInfo' });
        setTimeout(checkServer, 500);
    </script>
</body>
</html>`;
    }
}


/**
 * 全屏游戏面板 - 加载服务端页面
 * 
 * 这是一个极简的 WebView 容器：
 *   1. 创建一个允许脚本和外部资源的 WebView
 *   2. 生成一个 iframe 加载服务器页面
 *   3. 通过 URL 参数传递 VS Code 主题等信息
 *   4. 就这么多，所有游戏逻辑都在服务端
 */
export class GamePanel {
    public static currentPanel: GamePanel | undefined;
    private static readonly viewType = 'leidong-tools.gamePanel';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _serverUrl: string;

    private constructor(panel: vscode.WebviewPanel, serverUrl: string) {
        this._panel = panel;
        this._serverUrl = serverUrl;

        this._panel.webview.html = this._getHtml();

        this._panel.onDidDispose(() => {
            GamePanel.currentPanel = undefined;
        });

        // 处理来自 webview 的消息
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'showInfo':
                    vscode.window.showInformationMessage(msg.text || '');
                    break;
                case 'showError':
                    vscode.window.showErrorMessage(msg.text || '');
                    break;
                case 'copyToClipboard':
                    vscode.env.clipboard.writeText(msg.text || '');
                    vscode.window.showInformationMessage('已复制到剪贴板');
                    break;
                case 'changeNickname': {
                    const newName = await changePlayerNickname();
                    if (newName) {
                        // 通知 iframe 刷新昵称
                        this._panel.webview.postMessage({
                            command: 'nicknameChanged',
                            nickname: newName,
                            uid: getPlayerUid(),
                        });
                    }
                    break;
                }
                case 'uidConflict': {
                    // 服务端检测到设备码冲突，缓存新uid
                    if (msg.newUid) {
                        await handleUidConflict(msg.newUid);
                    }
                    break;
                }
            }
        });
    }

    static createOrShow(extensionUri: vscode.Uri, serverUrl: string): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (GamePanel.currentPanel) {
            GamePanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            GamePanel.viewType,
            '🎮 小游戏大厅',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        GamePanel.currentPanel = new GamePanel(panel, serverUrl);
    }

    private _getHtml(): string {
        // 收集 VS Code 主题信息传递给服务端
        const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
            ? 'dark' : vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
            ? 'light' : 'hc';

        const uid = getPlayerUid();
        const deviceHash = getDeviceHash();
        const nickname = encodeURIComponent(getPlayerNickname() || '未设置昵称');

        const iframeSrc = `${this._serverUrl}?theme=${theme}&playerName=${nickname}&uid=${uid}&deviceHash=${deviceHash}&source=vscode`;

        return /* html */`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; overflow: hidden; }
        body {
            background: var(--vscode-editor-background, #1e1e1e);
            display: flex;
            flex-direction: column;
        }
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 4px 12px;
            background: var(--vscode-titleBar-activeBackground, #333);
            border-bottom: 1px solid var(--vscode-panel-border, #555);
            height: 32px;
            flex-shrink: 0;
        }
        .toolbar-left {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            color: var(--vscode-titleBar-activeForeground, #ccc);
        }
        .toolbar-right {
            display: flex;
            gap: 6px;
        }
        .tool-btn {
            background: none;
            border: 1px solid var(--vscode-button-secondaryBackground, #555);
            color: var(--vscode-foreground, #ccc);
            padding: 2px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
        }
        .tool-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, #444);
        }
        #gameFrame {
            flex: 1;
            width: 100%;
            border: none;
            background: var(--vscode-editor-background, #1e1e1e);
        }
        .loading {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            font-size: 14px;
            color: var(--vscode-descriptionForeground, #888);
            flex-direction: column;
            gap: 12px;
        }
        .loading .spinner {
            width: 32px; height: 32px;
            border: 3px solid var(--vscode-panel-border, #555);
            border-top: 3px solid var(--vscode-focusBorder, #007acc);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .error-page {
            display: none;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            gap: 12px;
            text-align: center;
            padding: 20px;
        }
        .error-page .err-icon { font-size: 48px; }
        .error-page .err-title { font-size: 18px; font-weight: 600; }
        .error-page .err-detail {
            font-size: 13px;
            color: var(--vscode-descriptionForeground, #888);
            max-width: 400px;
        }
        .error-page .btn {
            padding: 8px 24px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            color: var(--vscode-button-foreground, #fff);
            background: var(--vscode-button-background, #0e639c);
            margin-top: 8px;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <div class="toolbar-left">
            <span>🎮</span>
            <span>游戏大厅</span>
            <span style="opacity:0.5">|</span>
            <span id="serverAddr" style="opacity:0.6">${this._serverUrl}</span>
        </div>
        <div class="toolbar-right">
            <button class="tool-btn" onclick="reload()">🔄 刷新</button>
            <button class="tool-btn" onclick="copyLink()">📋 复制链接</button>
        </div>
    </div>

    <div id="loadingView" class="loading">
        <div class="spinner"></div>
        <span>正在连接游戏服务器...</span>
    </div>

    <div id="errorView" class="error-page">
        <div class="err-icon">😵</div>
        <div class="err-title">无法连接到游戏服务器</div>
        <div class="err-detail">
            请确认服务器已启动：<br>
            <code style="color:var(--vscode-textLink-foreground)">${this._serverUrl}</code>
        </div>
        <div style="margin-top:16px;font-size:12px;text-align:left;max-width:380px;line-height:1.8;color:var(--vscode-descriptionForeground,#888)">
            <div style="font-weight:600;margin-bottom:6px;color:var(--vscode-foreground,#ccc)">📋 启动指南：</div>
            <div>1. 打开终端，进入服务器目录</div>
            <div>2. 运行 <code style="background:var(--vscode-textCodeBlock-background,#2d2d2d);padding:2px 6px;border-radius:3px">composer install</code>（首次）</div>
            <div>3. 运行 <code style="background:var(--vscode-textCodeBlock-background,#2d2d2d);padding:2px 6px;border-radius:3px">php start.php --dev</code></div>
            <div>4. 看到 "📡 服务器已就绪" 后点击下方重试</div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
            <button class="btn" onclick="reload()">🔄 重试连接</button>
            <span id="reconnectInfo" style="font-size:11px;color:var(--vscode-descriptionForeground,#888)"></span>
        </div>
    </div>

    <iframe id="gameFrame" style="display:none"
        src="${iframeSrc}"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        allow="clipboard-write"
    ></iframe>

    <script>
        const vscode = acquireVsCodeApi();
        const frame = document.getElementById('gameFrame');
        const loading = document.getElementById('loadingView');
        const errorView = document.getElementById('errorView');
        const reconnectInfo = document.getElementById('reconnectInfo');

        let loadTimeout;
        let reconnectTimer;
        let reconnectAttempt = 0;
        const MAX_RECONNECT = 30; // 最多自动重试30次
        const RECONNECT_INTERVALS = [5, 10, 15, 30]; // 重试间隔递增（秒）

        function showFrame() {
            clearTimeout(loadTimeout);
            stopReconnect();
            loading.style.display = 'none';
            errorView.style.display = 'none';
            frame.style.display = 'block';
        }

        function showError() {
            clearTimeout(loadTimeout);
            loading.style.display = 'none';
            frame.style.display = 'none';
            errorView.style.display = 'flex';
            scheduleReconnect();
        }

        function stopReconnect() {
            clearInterval(reconnectTimer);
            reconnectTimer = null;
            reconnectAttempt = 0;
        }

        function scheduleReconnect() {
            if (reconnectTimer) return;
            reconnectAttempt++;
            if (reconnectAttempt > MAX_RECONNECT) {
                reconnectInfo.textContent = '已停止自动重试，请手动重试';
                return;
            }
            const idx = Math.min(reconnectAttempt - 1, RECONNECT_INTERVALS.length - 1);
            let countdown = RECONNECT_INTERVALS[idx];
            reconnectInfo.textContent = countdown + 's 后自动重试 (' + reconnectAttempt + '/' + MAX_RECONNECT + ')';
            reconnectTimer = setInterval(() => {
                countdown--;
                if (countdown <= 0) {
                    clearInterval(reconnectTimer);
                    reconnectTimer = null;
                    reconnectInfo.textContent = '正在重试...';
                    reload();
                } else {
                    reconnectInfo.textContent = countdown + 's 后自动重试 (' + reconnectAttempt + '/' + MAX_RECONNECT + ')';
                }
            }, 1000);
        }

        frame.onload = () => showFrame();
        frame.onerror = () => showError();

        // 超时检测
        loadTimeout = setTimeout(() => {
            if (frame.style.display === 'none') {
                showError();
            }
        }, 8000);

        function reload() {
            loading.style.display = 'flex';
            errorView.style.display = 'none';
            frame.style.display = 'none';
            frame.src = frame.src;
            loadTimeout = setTimeout(() => {
                if (frame.style.display === 'none') showError();
            }, 8000);
        }

        function copyLink() {
            vscode.postMessage({ command: 'copyToClipboard', text: '${iframeSrc}' });
        }

        // 监听来自 iframe 的消息（服务端可以通过 postMessage 与扩展通信）
        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg && msg.target === 'vscode') {
                vscode.postMessage(msg);
            }
        });
    </script>
</body>
</html>`;
    }
}
