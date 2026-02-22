/**
 * @file enhancedDefinitionLogic.ts
 * @description 增强的定义查找逻辑，整合 JSSymbolParser
 * 保持向后兼容，同时提供更准确的解析
 */
import * as vscode from 'vscode';
import { monitor } from '../monitoring/performanceMonitor';
import { jsSymbolParser, SymbolInfo, SymbolType } from '../parsers/jsSymbolParser';
import { 
    resolveVueIndexForHtml, 
    getOrCreateVueIndexFromContent, 
    findDefinitionInIndex, 
    findChainedRootDefinition 
} from '../parsers/parseDocument';
import { findTemplateVar } from './templateIndexer';
import { getXTemplateIdAtPosition } from '../helpers/templateContext';
import { getTemplateLiteralAtPosition } from '../helpers/templateLiteralHelper';

const HTML_ATTR_BLACKLIST = new Set([
    'class','id','style','src','href','alt','title','width','height','type','value','name','placeholder','rel','for','aria-label'
]);

/**
 * 增强版定义查找逻辑
 * 优先使用 JSSymbolParser，降级到原始实现
 */
export class EnhancedDefinitionLogic {
    /**
     * 主入口：提供定义跳转
     */
    @monitor('provideDefinition')
    public async provideDefinition(
        document: vscode.TextDocument, 
        position: vscode.Position
    ): Promise<vscode.Location | null> {
        try {
            // 检查功能是否启用
            if (!this.isFeatureEnabled()) {
                return null;
            }

            const rawWordInfo = this.extractWord(document, position);
            if (!rawWordInfo) {
                return null;
            }

            const { word, contextType, fullChain } = rawWordInfo;
            if (!word) {
                return null;
            }

            // JS/TS 文件：优先使用新解析器
            if (document.languageId === 'javascript' || document.languageId === 'typescript') {
                return await this.handleJavaScriptFile(document, position, word, fullChain, contextType);
            }

            // HTML 文件：尝试外部 JS 或内联脚本
            if (document.languageId === 'html') {
                return await this.handleHtmlFile(document, position, word, fullChain);
            }

            return null;
        } catch (e) {
            console.error('[enhanced-jump][fatal]', e);
            return null;
        }
    }

    /**
     * 处理 JavaScript 文件
     */
    private async handleJavaScriptFile(
        document: vscode.TextDocument,
        position: vscode.Position,
        word: string,
        fullChain: string | undefined,
        contextType: 'this' | 'that' | 'plain' | 'alias'
    ): Promise<vscode.Location | null> {
        if (this.shouldLog()) {
            console.log(`[enhanced-jump][js] word=${word} chain=${fullChain || ''} context=${contextType}`);
        }

        // 检测是否在 template: `...` 模板字符串内
        const templateInfo = getTemplateLiteralAtPosition(document, position);
        if (templateInfo) {
            return this.handleTemplateLiteralDefinition(document, position, word, fullChain);
        }

        try {
            // 1. 尝试新解析器
            const parseResult = await jsSymbolParser.parse(document);
            
            const chainRoot = fullChain ? fullChain.split('.')[0] : word;
            const thisRoot = fullChain && (contextType === 'this' || contextType === 'that' || contextType === 'alias')
                ? fullChain.split('.')[1] || word
                : word;

            // 如果是 this.xxx 或 that.xxx，查找 Vue 实例成员
            if (contextType === 'this' || contextType === 'that' || contextType === 'alias') {
                const symbol = parseResult.thisReferences.get(thisRoot) || parseResult.thisReferences.get(word);
                if (symbol) {
                    const location = new vscode.Location(document.uri, symbol.selectionRange);
                    if (this.shouldLog()) {
                        console.log(`[enhanced-jump][js][new-parser-hit] ${word} -> ${document.uri.fsPath}:${symbol.range.start.line + 1}`);
                    }
                    return location;
                }
            }

            if (contextType === 'plain') {
                const localSymbol = await jsSymbolParser.findLocalSymbol(document, position, chainRoot);
                if (localSymbol) {
                    const location = new vscode.Location(document.uri, localSymbol.selectionRange);
                    if (this.shouldLog()) {
                        console.log(`[enhanced-jump][js][local-hit] ${chainRoot} -> ${document.uri.fsPath}:${localSymbol.range.start.line + 1}`);
                    }
                    return location;
                }
            }

            // 普通变量/函数/类查找
            let symbol: SymbolInfo | undefined;
            
            // 先查找变量
            symbol = parseResult.variables.get(chainRoot);
            
            // 再查找函数
            if (!symbol) {
                symbol = parseResult.functions.get(chainRoot);
            }
            
            // 最后查找类
            if (!symbol) {
                symbol = parseResult.classes.get(chainRoot);
            }

            if (symbol) {
                const location = new vscode.Location(document.uri, symbol.selectionRange);
                if (this.shouldLog()) {
                    console.log(`[enhanced-jump][js][new-parser-hit] ${word} (${symbol.kind}) -> ${document.uri.fsPath}:${symbol.range.start.line + 1}`);
                }
                return location;
            }

            // 2. 降级到原始解析器
            if (this.shouldLog()) {
                console.log(`[enhanced-jump][js][fallback] Using legacy parser`);
            }
            
            const content = document.getText();
            const index = getOrCreateVueIndexFromContent(content, document.uri, 0);
            let target = findDefinitionInIndex(word, index);
            
            if (!target && fullChain) {
                target = findChainedRootDefinition(fullChain, index);
            }

            if (target) {
                if (this.shouldLog()) {
                    console.log(`[enhanced-jump][js][legacy-hit] ${word} -> ${target.uri.fsPath}:${target.range.start.line + 1}`);
                }
                return target;
            }

            if (this.shouldLog()) {
                console.log(`[enhanced-jump][js][miss] ${word}`);
            }

        } catch (e) {
            console.error('[enhanced-jump][js][error]', e);
            // 发生错误时降级
            const content = document.getText();
            const index = getOrCreateVueIndexFromContent(content, document.uri, 0);
            return findDefinitionInIndex(word, index);
        }

        return null;
    }

    /**
     * 处理 HTML 文件
     */
    private async handleHtmlFile(
        document: vscode.TextDocument,
        position: vscode.Position,
        word: string,
        fullChain: string | undefined
    ): Promise<vscode.Location | null> {
        // 先尝试模板局部变量 (v-for / slot-scope)
        const templateHit = findTemplateVar(document, position, word);
        if (templateHit) {
            if (this.shouldLog()) {
                console.log(`[enhanced-jump][html][template-hit] ${word} -> ${templateHit.uri.fsPath}:${templateHit.range.start.line + 1}`);
            }
            return templateHit;
        }

        // 解析 HTML 中的 Vue 索引（外部 JS 或内联 script）
        let index = resolveVueIndexForHtml(document);
        if (!index) {
            return null;
        }
        const templateId = getXTemplateIdAtPosition(document, position);
        if (templateId && index.componentsByTemplateId && index.componentsByTemplateId.has(templateId)) {
            index = index.componentsByTemplateId.get(templateId)!;
        }

        if (this.shouldLog()) {
            console.log(`[enhanced-jump][html] word=${word} chain=${fullChain || ''}`);
        }

        const preferredScope = this.detectHtmlScope(document, position);
        let target = this.findDefinitionByScope(word, index, preferredScope);
        if (!target) {
            target = findDefinitionInIndex(word, index);
        }
        
        if (!target && fullChain) {
            target = findChainedRootDefinition(fullChain, index);
        }

        if (target) {
            if (this.shouldLog()) {
                console.log(`[enhanced-jump][html][hit] ${word} -> ${target.uri.fsPath}:${target.range.start.line + 1}`);
            }
            return target;
        }

        if (this.shouldLog()) {
            console.log(`[enhanced-jump][html][miss] ${word}`);
        }

        return null;
    }

    /**
     * 处理 JS 文件中 template: `...` 模板字符串内的定义跳转
     * 将模板中的变量名映射到同文件 Vue 组件的 data/methods/computed
     */
    private async handleTemplateLiteralDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        word: string,
        fullChain: string | undefined
    ): Promise<vscode.Location | null> {
        if (this.shouldLog()) {
            console.log(`[enhanced-jump][js][template-literal] word=${word} chain=${fullChain || ''}`);
        }

        try {
            // 解析整个 JS 文件构建 Vue 索引
            const content = document.getText();
            const index = getOrCreateVueIndexFromContent(content, document.uri, 0);

            // 在 Vue 索引中查找定义
            let target = findDefinitionInIndex(word, index);
            if (!target && fullChain) {
                target = findChainedRootDefinition(fullChain, index);
            }

            if (target) {
                if (this.shouldLog()) {
                    console.log(`[enhanced-jump][js][template-literal-hit] ${word} -> ${target.uri.fsPath}:${target.range.start.line + 1}`);
                }
                return target;
            }

            // 降级：尝试新解析器查找普通符号
            const parseResult = await jsSymbolParser.parse(document);
            const symbol = parseResult.thisReferences.get(word)
                || parseResult.variables.get(word)
                || parseResult.functions.get(word);
            if (symbol) {
                if (this.shouldLog()) {
                    console.log(`[enhanced-jump][js][template-literal-symbol-hit] ${word} -> ${document.uri.fsPath}:${symbol.range.start.line + 1}`);
                }
                return new vscode.Location(document.uri, symbol.selectionRange);
            }

            if (this.shouldLog()) {
                console.log(`[enhanced-jump][js][template-literal-miss] ${word}`);
            }
        } catch (e) {
            console.error('[enhanced-jump][js][template-literal-error]', e);
        }

        return null;
    }

    private detectHtmlScope(document: vscode.TextDocument, position: vscode.Position): 'method' | 'data' | 'computed' | null {
        const line = document.lineAt(position.line).text;
        const before = line.substring(0, position.character);
        const after = line.substring(position.character);
        const eventAttr = /(@[\w-]+|v-on:[\w-]+)\s*=\s*["'][^"']*$/.test(before);
        if (eventAttr) { return 'method'; }
        if (/^\s*\(/.test(after)) { return 'method'; }
        return null;
    }

    private findDefinitionByScope(
        name: string,
        index: ReturnType<typeof resolveVueIndexForHtml>,
        scope: 'method' | 'data' | 'computed' | null
    ): vscode.Location | null {
        if (!index || !scope) { return null; }
        if (scope === 'method') {
            return index.methods.get(name) || index.mixinMethods.get(name) || null;
        }
        if (scope === 'computed') {
            return index.computed.get(name) || index.mixinComputed.get(name) || null;
        }
        if (scope === 'data') {
            return index.data.get(name) || index.mixinData.get(name) || null;
        }
        return null;
    }

    /**
     * 提取光标下的词 + 上下文类型
     */
    private extractWord(
        document: vscode.TextDocument, 
        position: vscode.Position
    ): { word: string; contextType: 'this' | 'that' | 'plain' | 'alias'; fullChain?: string } | null {
        const lineText = document.lineAt(position.line).text;
        const beforeCursor = lineText.substring(0, position.character);

        // 1. 捕获链式访问 (含 this/that/别名)
        const chainMatch = /([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)$/.exec(beforeCursor);
        if (chainMatch) {
            const full = chainMatch[1];
            const parts = full.split('.');
            
            if (parts.length >= 2) {
                const root = parts[0];
                const prop = parts[parts.length - 1];
                
                if (root === 'this') {
                    return { word: prop, contextType: 'this', fullChain: full };
                }
                
                // 检测 this 别名（含 that / _this / self / vm 等）
                if (root === 'that' || this.isThisAlias(document, position, root)) {
                    return { word: prop, contextType: 'alias', fullChain: full };
                }
            }
        }

        // 2. 单词匹配
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_$][\w$]*/);
        if (!wordRange) {
            return null;
        }

        const w = document.getText(wordRange);

        // HTML 属性黑名单检查
        if (document.languageId === 'html') {
            const attrNameMatch = /([a-zA-Z0-9_-]+)\s*=/.exec(lineText);
            if (attrNameMatch && attrNameMatch[1] === w && HTML_ATTR_BLACKLIST.has(w)) {
                return null;
            }
        }

        return { word: w, contextType: 'plain', fullChain: w };
    }

    /**
     * 常见 this 别名集合（无需回扫即可识别）
     */
    private static readonly COMMON_THIS_ALIASES = new Set([
        'that', '_this', 'self', '_self', 'vm', '_vm', 'me', 'ctx', 'app',
        'this_', 'thisObj', 'instance', 'inst', 'vueInstance', 'vueInst'
    ]);

    /**
     * 判断某标识符是否为 this 的别名
     * 1. 先检查常见别名列表（零成本）
     * 2. 再向上回扫最多 500 行，匹配 xxx = this 赋值模式
     */
    private isThisAlias(
        document: vscode.TextDocument, 
        position: vscode.Position, 
        alias: string
    ): boolean {
        // 快速路径：常见别名
        if (EnhancedDefinitionLogic.COMMON_THIS_ALIASES.has(alias)) {
            return true;
        }

        const maxScan = 500;
        const startLine = Math.max(0, position.line - maxScan);
        // 支持多种赋值模式：var/let/const xxx = this; xxx = this;
        const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const aliasPattern = new RegExp(`(?:(?:const|let|var)\\s+)?${escapedAlias}\\s*=\\s*this(?:\\s*[;,]|\\s*$)`);
        
        for (let line = position.line; line >= startLine; line--) {
            const text = document.lineAt(line).text;
            if (aliasPattern.test(text)) {
                return true;
            }
        }
        
        return false;
    }

    /**
     * 检查功能是否启用
     */
    private isFeatureEnabled(): boolean {
        try {
            return vscode.workspace.getConfiguration('leidong-tools')
                .get<boolean>('enableDefinitionJump', true) === true;
        } catch {
            return true;
        }
    }

    /**
     * 检查是否应该输出日志
     */
    private shouldLog(): boolean {
        try {
            return vscode.workspace.getConfiguration('leidong-tools')
                .get<boolean>('indexLogging', true) === true;
        } catch {
            return true;
        }
    }
}

/**
 * 导出单例
 */
export const enhancedDefinitionLogic = new EnhancedDefinitionLogic();
