/**
 * Provider 注册模块
 */
import * as vscode from 'vscode';
import { VueHtmlDefinitionProvider } from '../providers/definitionProvider';
import { VueHoverProvider } from '../providers/hoverProvider';
import { 
    JavaScriptCompletionProvider, 
    QuickLogCompletionProvider,
    HtmlVueCompletionProvider,
    VonCompletionProvider
} from '../providers/completionProvider';
import { VueDocumentSymbolProvider } from '../providers/documentSymbolProvider';
import { VueReferenceProvider } from '../providers/referenceProvider';
import { VueCodeLensProvider, updateInlineRefDecorations, clearInlineRefDecorations } from '../providers/codeLensProvider';
import { VueColorProvider } from '../providers/colorProvider';
import { updateLaytplBracketHighlights } from '../providers/laytplBracketHighlighter';
import { LaytplFoldingRangeProvider } from '../providers/laytplFoldingProvider';
import { XTemplateFoldingRangeProvider } from '../providers/xTemplateFoldingProvider';
import { XTemplateRangeFormattingProvider } from '../providers/xTemplateFormattingProvider';
import { registerCopilotAnalyzer } from '../providers/copilotAnalyzer';
import { VariableIndexWebviewProvider } from '../providers/variableIndexWebview';
import { registerSftpManager } from '../sftp/sftpManager';
import { DiagnosticsWebviewProvider } from '../providers/diagnosticsWebview';
import { WatchServiceTreeDataProvider } from '../providers/watchServiceTreeView';
import { GameSidebarProvider } from '../games/gameWebviewProvider';
import { FileWatchManager } from '../managers/fileWatchManager';
import { FILE_SELECTORS } from './config';

let refreshProviderConfigurationImpl: (() => void) | undefined;

export function refreshProviderConfiguration(): void {
    refreshProviderConfigurationImpl?.();
}

/**
 * 注册所有 Language Providers
 */
export function registerProviders(context: vscode.ExtensionContext, fileWatchManager: FileWatchManager) {
    const vueLanguageSelector = [
        { scheme: 'file', language: 'html' },
        { scheme: 'file', language: 'javascript' },
        { scheme: 'file', language: 'typescript' },
        { scheme: 'file', language: 'javascriptreact' },
        { scheme: 'file', language: 'typescriptreact' }
    ];
    const vueLanguageWithVueSelector = [
        ...vueLanguageSelector,
        { scheme: 'file', language: 'vue' }
    ];

    // 注册 HTML/JS Vue 定义提供器 
    // 确保只注册一次
    if (!context.subscriptions.some(sub => sub.constructor.name === 'DefinitionProviderRegistration')) {
        context.subscriptions.push(
            vscode.languages.registerDefinitionProvider(
                vueLanguageSelector,
                new VueHtmlDefinitionProvider()
            )
        );
    }

    // 注册悬停提供器
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            vueLanguageSelector,
            new VueHoverProvider()
        )
    );

    // 注册 JavaScript 补全提供器
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            FILE_SELECTORS.JAVASCRIPT_ONLY,
            new JavaScriptCompletionProvider(),
            '.', '"', '\'' // 仅在 Vue 成员和事件名场景主动触发，降低对原生 JS/TS/Emmet 的干扰
        )
    );

    // 注册 HTML 模板补全提供器
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            FILE_SELECTORS.HTML,
            new HtmlVueCompletionProvider(),
            '.', ':', '@', '{'
        )
    );

    // 注册快速日志补全提供器 (重写版，使用 command 模式)
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            FILE_SELECTORS.JAVASCRIPT,
            new QuickLogCompletionProvider(),
            'l', 'e', 'i', 'd', 'w', // 仅在输入 log/err/info/dbg/warn 的首字母时触发
        )
    );

    // 注册 Von 代码片段补全提供器 - 支持所有文件类型
    // 注册 Von 代码片段补全提供器 - 仅在常用文件类型中，不设触发字符以避免每次击键都触发
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            [
                { scheme: 'file', language: 'javascript' },
                { scheme: 'file', language: 'typescript' },
                { scheme: 'file', language: 'html' },
                { scheme: 'file', language: 'json' },
            ],
            new VonCompletionProvider()
            // 不设置 trigger characters，仅在用户主动请求补全（如输入 von 后按 Ctrl+Space）时触发
        )
    );

    let outlineRegistration: vscode.Disposable | undefined;
    let referenceRegistration: vscode.Disposable | undefined;
    let codeLensRegistration: vscode.Disposable | undefined;
    let colorRegistration: vscode.Disposable | undefined;
    let codeLensProvider: VueCodeLensProvider | undefined;

    const registerOptionalProviders = () => {
        const cfg = vscode.workspace.getConfiguration('leidong-tools');

        outlineRegistration?.dispose();
        outlineRegistration = undefined;
        if (cfg.get<boolean>('enableOutlineSymbols', false)) {
            outlineRegistration = vscode.languages.registerDocumentSymbolProvider(
                vueLanguageSelector,
                new VueDocumentSymbolProvider()
            );
        }

        referenceRegistration?.dispose();
        referenceRegistration = undefined;
        if (cfg.get<boolean>('enableReferences', false)) {
            referenceRegistration = vscode.languages.registerReferenceProvider(
                vueLanguageSelector,
                new VueReferenceProvider()
            );
        }

        codeLensRegistration?.dispose();
        codeLensRegistration = undefined;
        codeLensProvider = undefined;
        if (cfg.get<boolean>('enableCodeLens', false) || cfg.get<boolean>('enableAIAnalysis', false)) {
            codeLensProvider = new VueCodeLensProvider();
            codeLensRegistration = vscode.languages.registerCodeLensProvider(
                vueLanguageWithVueSelector,
                codeLensProvider
            );
            codeLensProvider.refresh();
        }

        colorRegistration?.dispose();
        colorRegistration = undefined;
        if (cfg.get<boolean>('enableColorPicker', false)) {
            colorRegistration = vscode.languages.registerColorProvider(
                [
                    { scheme: 'file', language: 'html' },
                    { scheme: 'file', language: 'css' }
                ],
                new VueColorProvider()
            );
        }
    };

    const refreshConfiguration = () => {
        registerOptionalProviders();
        codeLensProvider?.refresh();
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            clearInlineRefDecorations(editor);
            updateInlineRefDecorations(editor);
        }
    };

    refreshProviderConfigurationImpl = refreshConfiguration;
    refreshConfiguration();
    context.subscriptions.push({
        dispose: () => {
            outlineRegistration?.dispose();
            referenceRegistration?.dispose();
            codeLensRegistration?.dispose();
            colorRegistration?.dispose();
            if (refreshProviderConfigurationImpl === refreshConfiguration) {
                refreshProviderConfigurationImpl = undefined;
            }
        }
    });

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            updateInlineRefDecorations(editor);
            updateLaytplBracketHighlights(editor);
        }),
        vscode.window.onDidChangeTextEditorSelection((event) => {
            updateLaytplBracketHighlights(event.textEditor);
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('leidong-tools.enableOutlineSymbols') ||
                e.affectsConfiguration('leidong-tools.enableReferences') ||
                e.affectsConfiguration('leidong-tools.enableCodeLens') ||
                e.affectsConfiguration('leidong-tools.enableAIAnalysis') ||
                e.affectsConfiguration('leidong-tools.enableColorPicker') ||
                e.affectsConfiguration('leidong-tools.codeLensPosition') ||
                e.affectsConfiguration('leidong-tools.enableAIAnalysis')) {
                refreshConfiguration();
            }
        })
    );
    // 初始化当前编辑器的装饰
    updateInlineRefDecorations(vscode.window.activeTextEditor);
    updateLaytplBracketHighlights(vscode.window.activeTextEditor);

    // 注册 layui laytpl 折叠提供器（补充 HTML 中 {{# ... }} 代码块折叠）
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(
            FILE_SELECTORS.HTML,
            new LaytplFoldingRangeProvider()
        )
    );

    // 注册 text/x-template 折叠提供器（让 script 内封装的组件 HTML 标签可折叠）
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(
            FILE_SELECTORS.HTML,
            new XTemplateFoldingRangeProvider()
        )
    );

    // 注册 text/x-template 局部格式化（Format Selection）
    context.subscriptions.push(
        vscode.languages.registerDocumentRangeFormattingEditProvider(
            FILE_SELECTORS.HTML,
            new XTemplateRangeFormattingProvider()
        )
    );

    // 注册 Copilot Chat 分析参与者
    registerCopilotAnalyzer(context);

    // 注册侧边栏视图
    // 1. 变量索引 WebView（虚拟滚动，支持万级变量）
    const variableIndexProvider = new VariableIndexWebviewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            VariableIndexWebviewProvider.viewType,
            variableIndexProvider
        )
    );

    // 远程资源 WebView（与变量索引使用相同的注册链路）
    registerSftpManager(context);

    const diagnosticsProvider = new DiagnosticsWebviewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            DiagnosticsWebviewProvider.viewType,
            diagnosticsProvider
        )
    );

    // 2. 监听服务 TreeView
    const watchServiceProvider = new WatchServiceTreeDataProvider(fileWatchManager);
    const watchServiceTreeView = vscode.window.createTreeView('leidong-tools.watchServiceView', {
        treeDataProvider: watchServiceProvider,
        showCollapseAll: false
    });
    context.subscriptions.push(watchServiceTreeView);

    // 将 TreeView 刷新方法注入到 FileWatchManager
    fileWatchManager.onWatchItemsChanged(() => {
        watchServiceProvider.refresh();
    });

    // 3. 游戏面板 WebView
    const gameSidebarProvider = new GameSidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            GameSidebarProvider.viewType,
            gameSidebarProvider
        )
    );
}
