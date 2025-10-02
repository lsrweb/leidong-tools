/**
 * 控制台日志工具函数
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { LogType } from '../types';
import { EXTENSION_CONFIG } from '../core/config';

/**
 * 插入控制台日志
 */
export function insertConsoleLog(logType: LogType) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return; // No active editor
    }

    const document = editor.document;
    const selection = editor.selection;
    let variableToLog = '';

    if (!selection.isEmpty) {
        // Use selected text if there is a selection
        variableToLog = document.getText(selection);
    } else {
        // Otherwise, get the word at the cursor position
        const wordRange = document.getWordRangeAtPosition(selection.active, /[\w\.$]+/); // Regex to capture variable names, including properties like this.xxx
        if (wordRange) {
            variableToLog = document.getText(wordRange);
        } else {
            // If no word is found, prompt the user or insert a placeholder
            variableToLog = 'variable'; // Default placeholder
        }
    }

    // Get filename and line number
    const currentLine = selection.active.line;
    const fileName = path.basename(document.fileName);
    const logLineNumber = currentLine + 1; // Log statement will be on the next line

    // Determine indentation of the current line
    const currentLineText = document.lineAt(currentLine).text;
    const indentationMatch = currentLineText.match(/^\s*/);
    const indentation = indentationMatch ? indentationMatch[0] : '';

    // Construct the log message
    const logMessage = `${indentation}console.${logType}(\`${fileName}:${logLineNumber} ${variableToLog}:\`, ${variableToLog});`;

    // Insert the log message on the line below
    editor.edit(editBuilder => {
        // Position to insert: end of the current line to place the newline correctly
        const insertPosition = new vscode.Position(currentLine, currentLineText.length);
        editBuilder.insert(insertPosition, `\n${logMessage}`);
    }).then(success => {
        if (success) {
            // Optionally move the cursor to the end of the inserted line
            const endPosition = new vscode.Position(logLineNumber, logMessage.length);
            editor.selection = new vscode.Selection(endPosition, endPosition);
            // Reveal the new line if necessary
            editor.revealRange(new vscode.Range(endPosition, endPosition));
        }
    });
}

/**
 * 快速日志插入函数（支持快捷键）
 */
export function quickInsertConsoleLog(logType: LogType) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('没有打开的编辑器');
        return;
    }

    const document = editor.document;
    const selection = editor.selection;
    let variableToLog = '';

    if (!selection.isEmpty) {
        // 使用选中的文本
        variableToLog = document.getText(selection);
    } else {
        // 获取光标位置的单词
        const wordRange = document.getWordRangeAtPosition(selection.active, /[\w\.$\[\]]+/);
        if (wordRange) {
            variableToLog = document.getText(wordRange);
        } else {
            // 如果没有找到单词，提示用户输入
            vscode.window.showInputBox({
                prompt: '请输入要打印的变量名',
                placeHolder: '变量名'
            }).then(input => {
                if (input) {
                    insertQuickLog(input, logType, editor, document);
                }
            });
            return;
        }
    }

    insertQuickLog(variableToLog, logType, editor, document);
}

/**
 * 插入快速日志的核心函数
 */
export function insertQuickLog(variableToLog: string, logType: LogType, editor: vscode.TextEditor, document: vscode.TextDocument) {
    const selection = editor.selection;
    const currentLine = selection.active.line;
    const fileName = path.basename(document.fileName);
    const logLineNumber = currentLine + 2; // 下一行的行号

    // 获取当前行的缩进
    const currentLineText = document.lineAt(currentLine).text;
    const indentationMatch = currentLineText.match(/^\s*/);
    const indentation = indentationMatch ? indentationMatch[0] : '';

    // 构造日志消息
    const logIcon = EXTENSION_CONFIG.LOG.ICONS[logType];
    const logMessage = `${indentation}console.${logType}(\`${logIcon} ${fileName}:${logLineNumber} ${variableToLog}:\`, ${variableToLog});`;

    // 在当前行下方插入日志
    editor.edit(editBuilder => {
        const insertPosition = new vscode.Position(currentLine, currentLineText.length);
        editBuilder.insert(insertPosition, `\n${logMessage}`);
    }).then(success => {
        if (success) {
            // 移动光标到插入行的末尾
            const endPosition = new vscode.Position(currentLine + 1, logMessage.length);
            editor.selection = new vscode.Selection(endPosition, endPosition);
            editor.revealRange(new vscode.Range(endPosition, endPosition));
            
            // 显示成功消息
            vscode.window.showInformationMessage(`${logIcon} 已插入 console.${logType}(${variableToLog})`);
        }
    });
}

/**
 * 选中变量快速日志插入函数
 */
export function logSelectedVariable() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('没有活动的编辑器');
        return;
    }

    const document = editor.document;
    const selection = editor.selection;

    if (selection.isEmpty) {
        vscode.window.showWarningMessage('请先选中要打印的变量');
        return;
    }

    // 获取选中的文本
    const selectedText = document.getText(selection);
    const fileName = path.basename(document.fileName);
    const currentLine = selection.end.line;
    const logLineNumber = currentLine + 2; // 下一行的行号

    // 获取当前行的缩进
    const currentLineText = document.lineAt(currentLine).text;
    const indentationMatch = currentLineText.match(/^\s*/);
    const indentation = indentationMatch ? indentationMatch[0] : '';

    // 构造日志消息
    const logMessage = `${indentation}console.log(\`🔥 ${fileName}:${logLineNumber} ${selectedText}:\`, ${selectedText});`;

    // 在选中内容结束的行下方插入日志
    editor.edit(editBuilder => {
        const insertPosition = new vscode.Position(currentLine, currentLineText.length);
        editBuilder.insert(insertPosition, `\n${logMessage}`);
    }).then(success => {
        if (success) {
            // 移动光标到插入行的末尾
            const endPosition = new vscode.Position(currentLine + 1, logMessage.length);
            editor.selection = new vscode.Selection(endPosition, endPosition);
            vscode.window.showInformationMessage(`📝 已为变量 "${selectedText}" 插入日志`);
        } else {
            vscode.window.showErrorMessage('插入日志失败');
        }
    });
}


