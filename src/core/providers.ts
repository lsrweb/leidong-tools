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
import { VariableIndexWebviewProvider } from '../providers/variableIndexWebview';
import { WatchServiceTreeDataProvider } from '../providers/watchServiceTreeView';
import { FileWatchManager } from '../managers/fileWatchManager';
import { FILE_SELECTORS } from './config';

/**
 * 注册所有 Language Providers
 */
export function registerProviders(context: vscode.ExtensionContext, fileWatchManager: FileWatchManager) {
    // 注册 HTML/JS Vue 定义提供器 
    // 确保只注册一次
    if (!context.subscriptions.some(sub => sub.constructor.name === 'DefinitionProviderRegistration')) {
        context.subscriptions.push(
            vscode.languages.registerDefinitionProvider(
                [
                    { scheme: 'file', language: 'html' },
                    { scheme: 'file', language: 'javascript' },
                    { scheme: 'file', language: 'typescript' }
                ],
                new VueHtmlDefinitionProvider()
            )
        );
    }

    // 注册悬停提供器
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            [
                { scheme: 'file', language: 'html' },
                { scheme: 'file', language: 'javascript' },
                { scheme: 'file', language: 'typescript' }
            ],
            new VueHoverProvider()
        )
    );

    // 注册 JavaScript 补全提供器
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            FILE_SELECTORS.JAVASCRIPT_ONLY,
            new JavaScriptCompletionProvider(),
            '.', // 触发补全的字符
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
            '.', // 触发补全的字符
        )
    );

    // 注册 Von 代码片段补全提供器 - 支持所有文件类型
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            [
                { scheme: 'file', language: 'javascript' },
                { scheme: 'file', language: 'typescript' },
                { scheme: 'file', language: 'html' },
                { scheme: 'file', language: 'css' },
                { scheme: 'file', language: 'json' },
                { scheme: 'file', language: 'markdown' },
                { scheme: 'file', language: 'plaintext' },
                { scheme: 'file', pattern: '**/*' } // 支持所有文件
            ],
            new VonCompletionProvider(),
            'v', 'o', 'n' // 触发补全的字符
        )
    );

    // 注册侧边栏视图
    // 1. 变量索引 WebView（虚拟滚动，支持万级变量）
    const variableIndexProvider = new VariableIndexWebviewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            VariableIndexWebviewProvider.viewType,
            variableIndexProvider
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
}
