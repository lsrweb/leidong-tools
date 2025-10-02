/**
 * 代码压缩工具
 */
import * as vscode from 'vscode';

/**
 * 压缩多行代码的主函数
 */
export function compressMultipleLines() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('没有打开的编辑器');
        return;
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
        vscode.window.showInformationMessage('请先选择要压缩的多行文本');
        return;
    }

    const selectedText = editor.document.getText(selection);
    const document = editor.document;
    
    // 首先检查是否是注释内容
    if (isCommentContent(selectedText)) {
        const compressedText = compressComments(selectedText);
        // 替换选中的文本
        editor.edit(editBuilder => {
            editBuilder.replace(selection, compressedText);
        }).then(success => {
            if (success) {
                vscode.window.showInformationMessage('成功压缩注释内容');
            } else {
                vscode.window.showErrorMessage('压缩失败');
            }
        });
        return;
    }
    
    // 根据文件类型决定压缩策略
    const languageId = document.languageId;
    let compressedText = '';

    try {
        switch (languageId) {
            case 'html':
            case 'xml':
                compressedText = compressHtml(selectedText);
                break;
            case 'javascript':
            case 'typescript':
            case 'vue':
                compressedText = compressJavaScript(selectedText);
                break;
            case 'json':
            case 'jsonc':
                compressedText = compressJson(selectedText);
                break;
            case 'css':
            case 'scss':
            case 'sass':
            case 'less':
                compressedText = compressCss(selectedText);
                break;
            default:
                // 默认压缩策略：移除多余空白和换行
                compressedText = compressGeneric(selectedText);
                break;
        }

        // 替换选中的文本
        editor.edit(editBuilder => {
            editBuilder.replace(selection, compressedText);
        }).then(success => {
            if (success) {
                vscode.window.showInformationMessage(`成功压缩 ${languageId} 代码`);
            } else {
                vscode.window.showErrorMessage('压缩失败');
            }
        });

    } catch (error) {
        console.error('[Compress Lines] Error:', error);
        vscode.window.showErrorMessage('压缩过程中发生错误');
    }
}

/**
 * 检查是否是注释内容
 */
function isCommentContent(text: string): boolean {
    const trimmedText = text.trim();
    
    // JavaScript/TypeScript/CSS 多行注释
    if (trimmedText.startsWith('/*') && trimmedText.endsWith('*/')) {
        return true;
    }
    
    // HTML 注释
    if (trimmedText.startsWith('<!--') && trimmedText.endsWith('-->')) {
        return true;
    }
    
    // 检查是否所有行都是单行注释
    const lines = text.split('\n');
    const nonEmptyLines = lines.filter(line => line.trim() !== '');
    
    if (nonEmptyLines.length === 0) {
        return false;
    }
    
    // JavaScript/TypeScript 单行注释
    if (nonEmptyLines.every(line => line.trim().startsWith('//'))) {
        return true;
    }
    
    // Python/Shell 单行注释
    if (nonEmptyLines.every(line => line.trim().startsWith('#'))) {
        return true;
    }
    
    // SQL 单行注释
    if (nonEmptyLines.every(line => line.trim().startsWith('--'))) {
        return true;
    }
    
    return false;
}

/**
 * 压缩注释内容
 */
function compressComments(text: string): string {
    const trimmedText = text.trim();
    
    // 处理 JavaScript/TypeScript/CSS 多行注释
    if (trimmedText.startsWith('/*') && trimmedText.endsWith('*/')) {
        const content = trimmedText.slice(2, -2).trim();
        const compressedContent = content
            .replace(/^\s*\*/gm, '') // 移除行首的 *
            .replace(/\s+/g, ' ') // 合并空白
            .trim();
        return `/* ${compressedContent} */`;
    }
    
    // 处理 HTML 注释
    if (trimmedText.startsWith('<!--') && trimmedText.endsWith('-->')) {
        const content = trimmedText.slice(4, -3).trim();
        const compressedContent = content
            .replace(/\s+/g, ' ') // 合并空白
            .trim();
        return `<!-- ${compressedContent} -->`;
    }
    
    // 处理单行注释
    const lines = text.split('\n');
    const nonEmptyLines = lines.filter(line => line.trim() !== '');
    
    if (nonEmptyLines.length === 0) {
        return text;
    }
    
    // JavaScript/TypeScript 单行注释
    if (nonEmptyLines.every(line => line.trim().startsWith('//'))) {
        const content = nonEmptyLines
            .map(line => line.trim().replace(/^\/\/\s*/, ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        return `// ${content}`;
    }
    
    // Python/Shell 单行注释
    if (nonEmptyLines.every(line => line.trim().startsWith('#'))) {
        const content = nonEmptyLines
            .map(line => line.trim().replace(/^#\s*/, ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        return `# ${content}`;
    }
    
    // SQL 单行注释
    if (nonEmptyLines.every(line => line.trim().startsWith('--'))) {
        const content = nonEmptyLines
            .map(line => line.trim().replace(/^--\s*/, ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        return `-- ${content}`;
    }
    
    // 如果不是标准注释格式，使用通用压缩
    return compressGeneric(text);
}

/**
 * HTML 压缩策略
 */
function compressHtml(text: string): string {
    return text
        // 移除标签间的换行和多余空白
        .replace(/>\s+</g, '><')
        // 移除行首行尾空白
        .replace(/^\s+|\s+$/gm, '')
        // 合并多个空白为单个空格
        .replace(/\s+/g, ' ')
        // 移除注释（可选）
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
}

/**
 * JavaScript/TypeScript 压缩策略
 */
function compressJavaScript(text: string): string {
    return text
        // 移除单行注释
        .replace(/\/\/.*$/gm, '')
        // 移除多行注释
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // 移除行首行尾空白
        .replace(/^\s+|\s+$/gm, '')
        // 移除空行
        .replace(/\n\s*\n/g, '\n')
        // 在语句结束符后添加空格（如果后面不是换行）
        .replace(/([;{}])\s*(?=\S)/g, '$1 ')
        // 合并连续的空白为单个空格
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * JSON 压缩策略
 */
function compressJson(text: string): string {
    try {
        // 尝试解析并重新格式化 JSON
        const parsed = JSON.parse(text);
        return JSON.stringify(parsed);
    } catch (error) {
        // 如果不是有效的 JSON，使用通用策略
        return compressGeneric(text);
    }
}

/**
 * CSS 压缩策略
 */
function compressCss(text: string): string {
    return text
        // 移除注释
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // 移除行首行尾空白
        .replace(/^\s+|\s+$/gm, '')
        // 移除空行
        .replace(/\n\s*\n/g, '\n')
        // 在选择器和大括号之间移除空白
        .replace(/\s*{\s*/g, '{')
        .replace(/\s*}\s*/g, '}')
        // 在属性冒号前后规范空白
        .replace(/\s*:\s*/g, ':')
        // 在分号后规范空白
        .replace(/;\s*/g, ';')
        // 合并连续空白为单个空格
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 通用压缩策略
 */
function compressGeneric(text: string): string {
    return text
        // 移除行首行尾空白
        .replace(/^\s+|\s+$/gm, '')
        // 移除空行
        .replace(/\n\s*\n/g, '\n')
        // 合并连续空白为单个空格
        .replace(/\s+/g, ' ')
        .trim();
}
