/**
 * Vue 相关工具函数
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseAST } from '../parsers/astParser';
import { safeExecute, handleFileNotFoundError, ErrorType } from '../errors/errorHandler';

/**
 * 查找 Vue 定义
 */
export async function findVueDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location | null> {
    // 增强词语提取正则，支持更复杂的属性访问
    const wordRange = document.getWordRangeAtPosition(position, /[\w\$\.]+/);
    if (!wordRange) {
        return null;
    }
    const word = document.getText(wordRange);

    let searchWord: string;
    let isThisCall = false;

    // Check if the word looks like a 'this' call (e.g., this.methodName or this.methodName())
    if (word.startsWith('this.')) {
        // Extract the method name after 'this.' and before any potential '('
        searchWord = word.substring(5).split('(')[0];
        isThisCall = true;
        console.log(`[HTML Vue Jump] Detected 'this.' call, searching for method: ${searchWord}`);
    } else {
        // Existing logic for template variables/methods
        searchWord = word.includes('.') ? word.split('.')[0] : word;
        console.log(`[HTML Vue Jump] Searching for template variable/method: ${searchWord}`);
    }

    // --- Get script content (inline or external) ---
    const documentText = document.getText();
    const scriptTagStart = documentText.indexOf('<script>');
    const scriptTagEnd = documentText.lastIndexOf('</script>');

    let scriptContent: string | null = null;
    let scriptStartLine = 0;
    let sourceUri = document.uri; // Default to the current document URI

    if (scriptTagStart !== -1 && scriptTagEnd !== -1) {
        // Found <script> tag in the current HTML file
        scriptContent = documentText.substring(scriptTagStart + '<script>'.length, scriptTagEnd);
        scriptStartLine = document.positionAt(scriptTagStart).line;
        console.log('[HTML Vue Jump] Found <script> tag in HTML.');
    } else {
        // No <script> tag found, try looking for external JS file
        console.log('[HTML Vue Jump] No <script> tag found in HTML. Looking for external JS file...');
        const docPath = document.uri.fsPath;
        const docDir = path.dirname(docPath);
        const docBaseName = path.basename(docPath, path.extname(docPath));

        // 优先查找 js/同名.dev.js - 这是最重要的路径
        // Try several possible JS file patterns with priority on js/file.dev.js
        const possibleJsFiles = [
            // 优先查找 js/同名.dev.js
            path.join(docDir, 'js', `${docBaseName}.dev.js`),
            // 其次查找当前目录下的 .dev.js
            path.join(docDir, `${docBaseName}.dev.js`),
            // 再查找上级目录的 js/同名.dev.js
            path.join(docDir, '..', 'js', `${docBaseName}.dev.js`),
            // 最后尝试非 dev 版本
            path.join(docDir, 'js', `${docBaseName}.js`),
            path.join(docDir, `${docBaseName}.js`),
            path.join(docDir, '..', 'js', `${docBaseName}.js`)
        ];

        for (const jsFilePath of possibleJsFiles) {
            const fileContent = await safeExecute(() => {
                if (fs.existsSync(jsFilePath)) {
                    const content = fs.readFileSync(jsFilePath, 'utf8');
                    console.log(`[HTML Vue Jump] Found external JS file: ${jsFilePath}`);
                    return content;
                }
                return null;
            }, ErrorType.FILE_NOT_FOUND, {
                file: jsFilePath,
                details: `尝试读取外部JS文件`
            });

            if (fileContent) {
                scriptContent = fileContent;
                sourceUri = vscode.Uri.file(jsFilePath);
                scriptStartLine = 0; // External file starts at line 0
                break;
            }
        }
    }

    if (!scriptContent) {
        console.log('[HTML Vue Jump] No script content found.');
        return null;
    }

    // --- Parse script content to find the method/variable ---
    const result = await safeExecute(async () => {
        return await parseAST(scriptContent, searchWord, isThisCall);
    }, ErrorType.PARSE_ERROR, {
        file: document.fileName,
        details: `解析脚本内容查找定义: ${searchWord}`
    });

    if (result) {
        const targetLine = scriptStartLine + result.line;
        const targetColumn = result.column;

        const location = new vscode.Location(
            sourceUri,
            new vscode.Position(targetLine, targetColumn)
        );

        console.log(`[HTML Vue Jump] Found definition at line ${targetLine}, column ${targetColumn}`);
        return location;
    }

    console.log(`[HTML Vue Jump] Definition for '${searchWord}' not found.`);
    return null;
}

/**
 * 检查是否是注释内容
 */
export function isCommentContent(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.startsWith('//') || 
           trimmed.startsWith('/*') || 
           trimmed.startsWith('*') ||
           (trimmed.startsWith('<!--') && trimmed.endsWith('-->'));
}
