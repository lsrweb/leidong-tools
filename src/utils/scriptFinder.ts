/**
 * @file scriptFinder.ts
 * @description 查找并读取JS脚本源 (dev/*.dev.js 或内联 <script>)
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { safeExecute, ErrorType } from './errorHandler';
import { monitor, performanceMonitor } from './performanceMonitor';

/**
 * 代表一个脚本源
 */
export interface ScriptSource {
    content: string;
    uri: vscode.Uri;
    isExternal: boolean;
    startLine: number; // 对于内联脚本，表示 <script> 标签的起始行
}

export class ScriptFinder {
    /**
     * 查找与HTML文档关联的脚本
     * @param document HTML文档
     */
    @monitor('findScript')
    public async findScript(document: vscode.TextDocument): Promise<ScriptSource | null> {
        // 1. 优先查找外部 dev/*.dev.js 文件
        const externalScript = await this.findExternalDevScript(document);
        if (externalScript) {
            return externalScript;
        }

        // 2. 如果找不到，则查找内联 <script>
        const inlineScript = this.findInlineScript(document);
        if (inlineScript) {
            return inlineScript;
        }

        return null;
    }

    /**
     * 查找同级 dev/ 目录下的同名 .dev.js 文件
     * @param document 
     */
    private async findExternalDevScript(document: vscode.TextDocument): Promise<ScriptSource | null> {
        const docPath = document.uri.fsPath;
        const docDir = path.dirname(docPath);
        const docBaseName = path.basename(docPath, path.extname(docPath));

        const devJsPath = path.join(docDir, 'dev', `${docBaseName}.dev.js`);

        const content = await safeExecute(async () => {
            if (fs.existsSync(devJsPath)) {
                return fs.promises.readFile(devJsPath, 'utf8');
            }
            return null;
        }, ErrorType.FILE_NOT_FOUND, { file: devJsPath });

        if (content) {
            return {
                content,
                uri: vscode.Uri.file(devJsPath),
                isExternal: true,
                startLine: 0
            };
        }

        return null;
    }

    /**
     * 在文档中查找内联的 <script> 标签内容
     * @param document 
     */
    private findInlineScript(document: vscode.TextDocument): ScriptSource | null {
        const text = document.getText();
        
        // 使用更健壮的正则来匹配 <script> 标签，忽略属性
        const scriptTagRegex = /<script.*?>([\s\S]*?)<\/script>/i;
        const match = scriptTagRegex.exec(text);

        if (match && match[1]) {
            const content = match[1];
            const startPosition = document.positionAt(match.index + match[0].indexOf('>') + 1);

            return {
                content,
                uri: document.uri,
                isExternal: false,
                startLine: startPosition.line
            };
        }

        return null;
    }
} 
