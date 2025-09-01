/**
 * 命令注册模块
 */
import * as vscode from 'vscode';
import { 
    insertConsoleLog,
    quickInsertConsoleLog,
    logSelectedVariable,
    performanceMonitor,
    DefinitionLogic
} from '../utils';
import { compressMultipleLines } from '../utils/codeCompressor';
import { COMMANDS } from './config';
import { clearVueIndexCache } from '../utils/parseDocument';
import { clearTemplateIndexCache, showTemplateIndexSummary } from '../utils/templateIndexer';

/**
 * 注册所有命令
 */
export function registerCommands(context: vscode.ExtensionContext) {
    const definitionLogic = new DefinitionLogic();
    
    // Register the new command to open definition in a new tab
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.GO_TO_DEFINITION_NEW_TAB, async () => {
            console.log('[HTML Vue Jump] goToDefinitionInNewTab command triggered.');

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                console.log('[HTML Vue Jump] No active editor.');
                return;
            }

            const document = editor.document;
            const position = editor.selection.active;

            // Use the new definition logic to find the definition
            console.log('[HTML Vue Jump] Calling definitionLogic.provideDefinition...');
            const location = await definitionLogic.provideDefinition(document, position);
            console.log('[HTML Vue Jump] definitionLogic.provideDefinition returned:', location);

            if (location) {
                try {
                    console.log('[HTML Vue Jump] Location found. Opening in new tab...');
                    // Open the document containing the definition
                    // Show the document in a new editor column beside the current one
                    await vscode.window.showTextDocument(location.uri, {
                        viewColumn: vscode.ViewColumn.Beside, // Open beside
                        selection: location.range // Select the definition range
                    });
                    console.log('[HTML Vue Jump] showTextDocument called successfully.');
                } catch (error) {
                    console.error("[HTML Vue Jump] Error opening definition:", error);
                    vscode.window.showErrorMessage('Could not open definition.');
                }
            } else {
                console.log('[HTML Vue Jump] Definition not found.');
                vscode.window.showInformationMessage('Definition not found.');
            }
        })
    );    // Register logging commands
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.LOG_VARIABLE, () => {
            insertConsoleLog('log');
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.ERROR_VARIABLE, () => {
            insertConsoleLog('error');
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.INFO_VARIABLE, () => {
            insertConsoleLog('info');
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.DEBUG_VARIABLE, () => {
            insertConsoleLog('debug');
        })
    );

    // 注册快速日志插入命令（支持快捷键）
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.QUICK_LOG_VARIABLE, () => {
            quickInsertConsoleLog('log');
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.QUICK_ERROR_VARIABLE, () => {
            quickInsertConsoleLog('error');
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.QUICK_INFO_VARIABLE, () => {
            quickInsertConsoleLog('info');
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.QUICK_DEBUG_VARIABLE, () => {
            quickInsertConsoleLog('debug');
        })
    );

    // 注册多行压缩命令
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.COMPRESS_LINES, () => {
            compressMultipleLines();
        })
    );

    // 注册快速日志命令（简洁快捷键）
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.QUICK_CONSOLE_LOG, () => {
            quickInsertConsoleLog('log');
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.QUICK_CONSOLE_ERROR, () => {
            quickInsertConsoleLog('error');
        })
    );

    // 注册选中变量快速日志命令
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.LOG_SELECTED_VARIABLE, () => {
            logSelectedVariable();
        })
    );

    // 注册性能报告命令
    context.subscriptions.push(
        vscode.commands.registerCommand('leidong-tools.showPerformanceReport', async () => {
            await performanceMonitor.showReport();
        })
    );

    // 清理索引缓存命令（内部）
    context.subscriptions.push(
        vscode.commands.registerCommand('leidong-tools.clearIndexCache', () => {
            clearVueIndexCache();
            clearTemplateIndexCache();
            vscode.window.showInformationMessage('索引缓存已清理');
        })
    );

    // 展示索引摘要
    context.subscriptions.push(
        vscode.commands.registerCommand('leidong-tools.showIndexSummary', () => {
            showTemplateIndexSummary();
            vscode.window.showInformationMessage('已输出索引摘要到控制台');
        })
    );

    // 切换日志
    context.subscriptions.push(
        vscode.commands.registerCommand('leidong-tools.toggleIndexLogging', async () => {
            const cfg = vscode.workspace.getConfiguration('leidong-tools');
            const current = cfg.get<boolean>('indexLogging', true) === true;
            await cfg.update('indexLogging', !current, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage(`Index Logging 已切换为 ${!current}`);
        })
    );
}
