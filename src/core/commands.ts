/**
 * 命令注册模块
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { 
    insertConsoleLog,
    quickInsertConsoleLog,
    logSelectedVariable
} from '../tools/consoleLogger';
import { performanceMonitor } from '../monitoring/performanceMonitor';
import { compressMultipleLines } from '../tools/codeCompressor';
import { COMMANDS } from './config';
import { clearVueIndexCache } from '../parsers/parseDocument';
import { pruneTemplateIndex, showTemplateIndexSummary } from '../finders/templateIndexer';
import { FileWatchManager } from '../managers/fileWatchManager';

/**
 * 日志配置项接口 (用于 dotLogReplace 命令)
 */
interface LogConfigItem {
    trigger: string;
    description: string;
    format: string;
    icon: string;
    hideName?: boolean;
}

/**
 * 注册所有命令
 */
export function registerCommands(context: vscode.ExtensionContext): FileWatchManager {
    const fileWatchManager = new FileWatchManager(context);
    
    // 注册跳转到定义命令（供 TreeView 使用）
    context.subscriptions.push(
        vscode.commands.registerCommand('leidong-tools.jumpToDefinition', (uri: vscode.Uri, location: any) => {
            // 如果 location 是 vscode.Location 对象
            if (location && location.uri && location.range) {
                vscode.window.showTextDocument(location.uri).then(editor => {
                    editor.selection = new vscode.Selection(location.range.start, location.range.end);
                    editor.revealRange(location.range, vscode.TextEditorRevealType.InCenter);
                });
            } else if (uri && location) {
                // 如果是分开的 uri 和位置
                vscode.workspace.openTextDocument(uri).then(doc => {
                    vscode.window.showTextDocument(doc).then(editor => {
                        const range = new vscode.Range(location.line || 0, location.character || 0, location.line || 0, location.character || 0);
                        editor.selection = new vscode.Selection(range.start, range.end);
                        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                    });
                });
            }
        })
    );
    
    // 注册文件监听相关命令
    context.subscriptions.push(
        vscode.commands.registerCommand('leidong-tools.startWatch', async (uri: vscode.Uri) => {
            await fileWatchManager.startWatch(uri);
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('leidong-tools.showWatchList', async () => {
            await fileWatchManager.showWatchList();
        })
    );
    
    // 注册 .log 补全替换命令 (参考 jaluik/dot-log 实现)
    const dotLogReplaceHandler = (
        editor: vscode.TextEditor,
        edit: vscode.TextEditorEdit,
        position: vscode.Position,
        config: LogConfigItem
    ) => {
        const lineText = editor.document.lineAt(position.line).text;
        const fileName = path.basename(editor.document.fileName);
        const lineNumber = position.line + 1;
        
        // 匹配变量名.trigger 模式，例如 variableName.log
        // 改进的正则：匹配任何非空白字符（包括点号），但排除引号
        const matchVarReg = new RegExp(
            `([^\\s'"\`]+)\\.${config.trigger}$`
        );
        
        // 匹配字符串.trigger 模式，例如 'string'.log, "string".log
        const matchStrReg = new RegExp(
            `(['"\`])([^'"\`]*?)\\1\\.${config.trigger}$`
        );
        
        let matchFlag: 'var' | 'str' = 'var';
        let text: string | undefined, key: string | undefined, quote = "'", insertVal = '';
        
        // 先尝试匹配变量
        const varMatch = lineText.match(matchVarReg);
        if (varMatch) {
            [text, key] = varMatch;
        } else {
            // 再尝试匹配字符串
            const strMatch = lineText.match(matchStrReg);
            if (strMatch) {
                [text, quote, key] = strMatch;
                matchFlag = 'str';
            }
        }
        
        // 如果匹配成功
        if (key && text) {
            const index = lineText.indexOf(text);
            
            // 删除原来的文本 (variableName.log 或 'string'.log)
            edit.delete(
                new vscode.Range(
                    position.with(undefined, index),
                    position.with(undefined, index + text.length)
                )
            );
            
            // 根据匹配类型生成插入文本
            if (matchFlag === 'var') {
                // 变量模式: console.log('fileName:line variableName:', variableName)
                // 如果变量名包含单引号，使用双引号
                if (key.includes("'")) {
                    quote = '"';
                }
                
                if (config.hideName) {
                    // 仅输出值
                    insertVal = `${config.format}(${key})`;
                } else {
                    // 输出变量名和值，包含文件信息
                    insertVal = `${config.format}(${quote}${fileName}:${lineNumber} ${key}:${quote}, ${key})`;
                }
            } else if (matchFlag === 'str') {
                // 字符串模式: console.log('string')
                insertVal = `${config.format}(${quote}${key}${quote})`;
            }
            
            // 在相同位置插入新文本
            edit.insert(position.with(undefined, index), insertVal);
        }
        
        return Promise.resolve([]);
    };
    
    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand(
            'leidong-tools.dotLogReplace',
            dotLogReplaceHandler
        )
    );
    
    // Register logging commands
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
            pruneTemplateIndex(0); // 清理全部
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

    // 切换定义跳转功能
    context.subscriptions.push(
        vscode.commands.registerCommand('leidong-tools.toggleDefinitionJump', async () => {
            const cfg = vscode.workspace.getConfiguration('leidong-tools');
            const current = cfg.get<boolean>('enableDefinitionJump', true) === true;
            await cfg.update('enableDefinitionJump', !current, vscode.ConfigurationTarget.Workspace);
            const status = !current ? '✅ 已启用' : '❌ 已禁用';
            vscode.window.showInformationMessage(`Vue 变量跳转功能 ${status}`);
        })
    );
    
    return fileWatchManager;
}
