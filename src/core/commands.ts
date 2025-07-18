/**
 * 命令注册模块
 */
import * as vscode from 'vscode';
import { 
    insertConsoleLog,
    quickInsertConsoleLog,
    logSelectedVariable,
    performanceMonitor
} from '../utils';
import { compressMultipleLines } from '../utils/codeCompressor';
import { findVueDefinition } from '../utils/vueHelper';
import { COMMANDS } from './config';

/**
 * 注册所有命令
 */
export function registerCommands(context: vscode.ExtensionContext) {    // Register the new command to open definition in a new tab
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

            // Use the helper function to find the definition
            console.log('[HTML Vue Jump] Calling findVueDefinition...');
            const location = await findVueDefinition(document, position);
            console.log('[HTML Vue Jump] findVueDefinition returned:', location);

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
}
