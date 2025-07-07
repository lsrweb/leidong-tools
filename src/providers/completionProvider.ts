/**
 * 自动补全提供器
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { CacheItem, LogType } from '../types';
import { parseDocument } from '../utils';

/**
 * 快速日志补全提供器
 */
export class QuickLogCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        const lineText = document.lineAt(position).text;
        const textBeforeCursor = lineText.substring(0, position.character);
        
        // 检查是否匹配快速日志模式，例如: variableName.lg, this.prop.lg, obj.method.lg
        const quickLogMatch = textBeforeCursor.match(/([\w\.]+)\.(lg|er|info|dbg)$/);
        
        if (!quickLogMatch) {
            return [];
        }
        
        const [fullMatch, variableName, logType] = quickLogMatch;
        const fileName = path.basename(document.fileName);
        const lineNumber = position.line + 1;
        
        // 根据不同的日志类型创建补全项
        const completionItems: vscode.CompletionItem[] = [];
        
        if (logType === 'lg') {
            const item = new vscode.CompletionItem('🔥 console.log', vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(`console.log(\`${fileName}:${lineNumber} ${variableName}:\`, ${variableName});`);
            item.detail = '⚡ Quick console.log with file info';
            item.documentation = `插入 console.log(${variableName}) 并包含文件名和行号`;
            item.sortText = '0000'; // 使用更强的排序前缀确保最高优先级
            item.preselect = true; // 预选中
            item.filterText = `${variableName}.lg`; // 明确的过滤文本
            item.commitCharacters = ['\t', '\n']; // 支持 Tab 和 Enter 提交
            item.range = new vscode.Range(
                position.translate(0, -fullMatch.length),
                position
            );
            completionItems.push(item);
        } else if (logType === 'er') {
            const item = new vscode.CompletionItem('❌ console.error', vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(`console.error(\`${fileName}:${lineNumber} ${variableName}:\`, ${variableName});`);
            item.detail = '⚡ Quick console.error with file info';
            item.documentation = `插入 console.error(${variableName}) 并包含文件名和行号`;
            item.sortText = '0000'; // 使用更强的排序前缀确保最高优先级
            item.preselect = true; // 预选中
            item.filterText = `${variableName}.er`; // 明确的过滤文本
            item.commitCharacters = ['\t', '\n']; // 支持 Tab 和 Enter 提交
            item.range = new vscode.Range(
                position.translate(0, -fullMatch.length),
                position
            );
            completionItems.push(item);
        } else if (logType === 'info') {
            const item = new vscode.CompletionItem('ℹ️ console.info', vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(`console.info(\`${fileName}:${lineNumber} ${variableName}:\`, ${variableName});`);
            item.detail = '⚡ Quick console.info with file info';
            item.documentation = `插入 console.info(${variableName}) 并包含文件名和行号`;
            item.sortText = '0000'; // 使用更强的排序前缀确保最高优先级
            item.preselect = true; // 预选中
            item.filterText = `${variableName}.info`; // 明确的过滤文本
            item.commitCharacters = ['\t', '\n']; // 支持 Tab 和 Enter 提交
            item.range = new vscode.Range(
                position.translate(0, -fullMatch.length),
                position
            );
            completionItems.push(item);
        } else if (logType === 'dbg') {
            const item = new vscode.CompletionItem('🐛 console.debug', vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(`console.debug(\`${fileName}:${lineNumber} ${variableName}:\`, ${variableName});`);
            item.detail = '⚡ Quick console.debug with file info';
            item.documentation = `插入 console.debug(${variableName}) 并包含文件名和行号`;
            item.sortText = '0000'; // 使用更强的排序前缀确保最高优先级
            item.preselect = true; // 预选中
            item.filterText = `${variableName}.dbg`; // 明确的过滤文本
            item.commitCharacters = ['\t', '\n']; // 支持 Tab 和 Enter 提交
            item.range = new vscode.Range(
                position.translate(0, -fullMatch.length),
                position
            );
            completionItems.push(item);
        }
        
        return completionItems;
    }
}

/**
 * 多变量日志补全提供器
 */
export class MultiVariableLogCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        const lineText = document.lineAt(position).text;
        const textBeforeCursor = lineText.substring(0, position.character);
        
        // 检查多变量日志模式，例如: var1,var2,var3.lg, this.a,that.b.lg
        const multiVarMatch = textBeforeCursor.match(/([\w\.,\s]+)\.(lg|er|info|dbg)$/);
        
        if (!multiVarMatch) {
            return [];
        }
        
        const [fullMatch, variablesText, logType] = multiVarMatch;
        
        // 只有包含逗号才是多变量，否则跳过
        if (!variablesText.includes(',')) {
            return [];
        }
        
        const variables = variablesText.split(',').map(v => v.trim());
        const fileName = path.basename(document.fileName);
        const lineNumber = position.line + 1;
        
        const completionItems: vscode.CompletionItem[] = [];
        
        // 创建变量列表字符串
        const varList = variables.join(', ');
        const varArgs = variables.join(', ');
        
        if (logType === 'lg') {
            const item = new vscode.CompletionItem('🔥 console.log (multi)', vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(`console.log(\`${fileName}:${lineNumber} [${varList}]:\`, ${varArgs});`);
            item.detail = '⚡ Quick console.log for multiple variables';
            item.documentation = `插入 console.log 输出多个变量: ${varList}`;
            item.sortText = '0000'; // 使用更强的排序前缀确保最高优先级
            item.preselect = true; // 预选中
            item.filterText = `${variablesText}.lg`; // 明确的过滤文本
            item.commitCharacters = ['\t', '\n']; // 支持 Tab 和 Enter 提交
            item.range = new vscode.Range(
                position.translate(0, -fullMatch.length),
                position
            );
            completionItems.push(item);
        } else if (logType === 'er') {
            const item = new vscode.CompletionItem('❌ console.error (multi)', vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(`console.error(\`${fileName}:${lineNumber} [${varList}]:\`, ${varArgs});`);
            item.detail = '⚡ Quick console.error for multiple variables';
            item.documentation = `插入 console.error 输出多个变量: ${varList}`;
            item.sortText = '0000'; // 使用更强的排序前缀确保最高优先级
            item.preselect = true; // 预选中
            item.filterText = `${variablesText}.er`; // 明确的过滤文本
            item.commitCharacters = ['\t', '\n']; // 支持 Tab 和 Enter 提交
            item.range = new vscode.Range(
                position.translate(0, -fullMatch.length),
                position
            );
            completionItems.push(item);
        } else if (logType === 'info') {
            const item = new vscode.CompletionItem('ℹ️ console.info (multi)', vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(`console.info(\`${fileName}:${lineNumber} [${varList}]:\`, ${varArgs});`);
            item.detail = '⚡ Quick console.info for multiple variables';
            item.documentation = `插入 console.info 输出多个变量: ${varList}`;
            item.sortText = '0000'; // 使用更强的排序前缀确保最高优先级
            item.preselect = true; // 预选中
            item.filterText = `${variablesText}.info`; // 明确的过滤文本
            item.commitCharacters = ['\t', '\n']; // 支持 Tab 和 Enter 提交
            item.range = new vscode.Range(
                position.translate(0, -fullMatch.length),
                position
            );
            completionItems.push(item);
        } else if (logType === 'dbg') {
            const item = new vscode.CompletionItem('🐛 console.debug (multi)', vscode.CompletionItemKind.Snippet);
            item.insertText = new vscode.SnippetString(`console.debug(\`${fileName}:${lineNumber} [${varList}]:\`, ${varArgs});`);
            item.detail = '⚡ Quick console.debug for multiple variables';
            item.documentation = `插入 console.debug 输出多个变量: ${varList}`;
            item.sortText = '0000'; // 使用更强的排序前缀确保最高优先级
            item.preselect = true; // 预选中
            item.filterText = `${variablesText}.dbg`; // 明确的过滤文本
            item.commitCharacters = ['\t', '\n']; // 支持 Tab 和 Enter 提交
            item.range = new vscode.Range(
                position.translate(0, -fullMatch.length),
                position
            );
            completionItems.push(item);
        }
        
        return completionItems;
    }
}

/**
 * JavaScript 变量与函数补全提供器
 */
export class JavaScriptCompletionProvider implements vscode.CompletionItemProvider {
    // 存储解析结果的缓存
    private parseCache = new Map<string, CacheItem>();

    // 缓存有效期 (30秒)
    private cacheValidityPeriod = 30 * 1000;

    // 提供自动完成项目
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList> {
        try {
            // 检查触发自动完成的字符
            const linePrefix = document.lineAt(position).text.substring(0, position.character);
            
            // 判断当前作用域
            const isThisContext = this.isInThisContext(linePrefix);
            const isThatContext = this.isInThatContext(linePrefix);
            
            // 获取当前文件的解析缓存或重新解析
            let parseResult = this.getCachedParseResult(document);
            if (!parseResult) {
                parseResult = await parseDocument(document);
                if (parseResult) {
                    this.cacheParseResult(document, parseResult);
                }
            }
            
            // 确保 parseResult 不为 null
            if (!parseResult) {
                return [];
            }
            
            let completionItems: vscode.CompletionItem[];
            
            // 根据当前上下文返回不同的补全项
            if (isThisContext) {
                // 返回 this. 相关的补全项
                completionItems = Array.from(parseResult.thisReferences.values());
            } else if (isThatContext) {
                // that 通常是 this 的别名，也返回 this 相关的补全项
                completionItems = Array.from(parseResult.thisReferences.values());
            } else {
                // 返回所有变量和方法
                completionItems = [...parseResult.variables, ...parseResult.methods];
            }
            
            // 提高所有补全项的优先级以与内置单词记录竞争
            completionItems.forEach((item, index) => {
                item.sortText = `0000${index.toString().padStart(4, '0')}`; // 确保高优先级排序
                item.preselect = false; // 避免过度预选
                // 添加标识符表明这是来自我们的扩展
                if (!item.detail?.includes('(雷动三千)')) {
                    item.detail = `${item.detail || ''} (雷动三千)`;
                }
            });
            
            // 返回 CompletionList 以获得更好的控制
            return new vscode.CompletionList(completionItems, false);
        } catch (error) {
            console.error('[JS Completion] Error providing completions:', error);
            return [];
        }
    }

    // 判断是否在 this 上下文中
    private isInThisContext(linePrefix: string): boolean {
        return linePrefix.endsWith('this.');
    }

    // 判断是否在 that 上下文中 (that 通常是 this 的别名)
    private isInThatContext(linePrefix: string): boolean {
        return linePrefix.endsWith('that.');
    }

    // 获取缓存的解析结果
    private getCachedParseResult(document: vscode.TextDocument) {
        const uri = document.uri.toString();
        const cachedResult = this.parseCache.get(uri);
        
        // 检查缓存是否存在且有效
        if (cachedResult && Date.now() - cachedResult.timestamp < this.cacheValidityPeriod) {
            return cachedResult;
        }
        
        return null;
    }

    // 缓存解析结果
    private cacheParseResult(document: vscode.TextDocument, result: CacheItem) {
        const uri = document.uri.toString();
        this.parseCache.set(uri, result);
    }
}

/**
 * Von 代码片段补全提供器
 */
export class VonCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        const lineText = document.lineAt(position).text;
        const textBeforeCursor = lineText.substring(0, position.character);
        
        // 检查是否输入了 "von"
        if (!textBeforeCursor.endsWith('von')) {
            return [];
        }
        
        const completionItems: vscode.CompletionItem[] = [];
        
        // 1. 当前时间 YYYYMMDDHHMMSS
        const currentTimeItem = new vscode.CompletionItem('🕐 Current Time (YYYYMMDDHHMMSS)', vscode.CompletionItemKind.Snippet);
        const now = new Date();
        const timeString = this.formatDateTime(now);
        currentTimeItem.insertText = new vscode.SnippetString(timeString);
        currentTimeItem.detail = '⚡ Insert current time in YYYYMMDDHHMMSS format';
        currentTimeItem.documentation = `插入当前时间: ${timeString}`;
        currentTimeItem.sortText = '0001';
        currentTimeItem.preselect = true;
        currentTimeItem.filterText = 'von';
        currentTimeItem.commitCharacters = ['\t', '\n'];
        currentTimeItem.range = new vscode.Range(
            position.translate(0, -3), // -3 for "von"
            position
        );
        completionItems.push(currentTimeItem);
        
        // 2. 随机 UUID
        const uuidItem = new vscode.CompletionItem('🆔 Random UUID', vscode.CompletionItemKind.Snippet);
        const uuid = this.generateUUID();
        uuidItem.insertText = new vscode.SnippetString(uuid);
        uuidItem.detail = '⚡ Insert random UUID';
        uuidItem.documentation = `插入随机UUID: ${uuid}`;
        uuidItem.sortText = '0002';
        uuidItem.filterText = 'von';
        uuidItem.commitCharacters = ['\t', '\n'];
        uuidItem.range = new vscode.Range(
            position.translate(0, -3), // -3 for "von"
            position
        );
        completionItems.push(uuidItem);
        
        return completionItems;
    }
    
    /**
     * 格式化时间为 YYYYMMDDHHMMSS 格式
     */
    private formatDateTime(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        
        return `${year}${month}${day}${hours}${minutes}${seconds}`;
    }
    
    /**
     * 生成随机 UUID (v4)
     */
    private generateUUID(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
}
