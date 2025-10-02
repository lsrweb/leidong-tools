/**
 * @file jsSymbolParser.ts
 * @description 增强的 JavaScript 符号解析器
 * 参考 outline-map 仓库的实现，提供更准确的符号识别
 * @see https://github.com/Gerrnperl/outline-map
 */
import * as vscode from 'vscode';
import * as parser from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { LRUCache } from '../cache/lruCache';

/**
 * 符号类型枚举
 */
export enum SymbolType {
    Variable = 'Variable',
    Function = 'Function',
    Method = 'Method',
    Property = 'Property',
    Class = 'Class',
    Constant = 'Constant',
}

/**
 * 符号信息接口
 */
export interface SymbolInfo {
    name: string;
    kind: SymbolType;
    range: vscode.Range;
    selectionRange: vscode.Range;
    detail?: string;
    children?: SymbolInfo[];
}

/**
 * 解析结果接口
 */
export interface ParseResult {
    symbols: SymbolInfo[];
    variables: Map<string, SymbolInfo>;
    functions: Map<string, SymbolInfo>;
    classes: Map<string, SymbolInfo>;
    thisReferences: Map<string, SymbolInfo>; // Vue/React 的 this.xxx
}

/**
 * 缓存条目
 */
interface CacheEntry {
    result: ParseResult;
    timestamp: number;
    hash: string;
}

/**
 * JavaScript 符号解析器
 * 参考 outline-map 的 DocumentSymbolProvider 实现
 */
export class JSSymbolParser {
    private cache: LRUCache<string, CacheEntry>;
    private readonly CACHE_TTL = 30000; // 30秒缓存

    constructor(maxCacheSize: number = 200) {
        this.cache = new LRUCache(maxCacheSize);
    }

    /**
     * 解析文档并提取所有符号
     * @param document VSCode 文档或字符串内容
     * @param uri 文档 URI
     * @param baseLine 基础行号偏移（用于 HTML 内联脚本）
     */
    public async parse(document: vscode.TextDocument | string, uri?: vscode.Uri, baseLine: number = 0): Promise<ParseResult> {
        const content = typeof document === 'string' ? document : document.getText();
        const docUri = uri || (typeof document !== 'string' ? document.uri : vscode.Uri.parse('untitled'));

        // 检查缓存（包含 baseLine 在 key 中）
        const cacheKey = `${docUri.toString()}:${baseLine}`;
        const hash = this.fastHash(content);
        const cached = this.cache.get(cacheKey);
        
        if (cached && cached.hash === hash && (Date.now() - cached.timestamp < this.CACHE_TTL)) {
            return cached.result;
        }

        // 解析代码
        const result = await this.parseContent(content, docUri, baseLine);
        
        // 缓存结果
        this.cache.set(cacheKey, {
            result,
            timestamp: Date.now(),
            hash
        });

        return result;
    }

    /**
     * 解析内容并构建符号树
     * @param baseLine 基础行号偏移
     */
    private async parseContent(content: string, uri: vscode.Uri, baseLine: number = 0): Promise<ParseResult> {
        const result: ParseResult = {
            symbols: [],
            variables: new Map(),
            functions: new Map(),
            classes: new Map(),
            thisReferences: new Map(),
        };

        try {
            // 清理模板代码
            const cleanContent = this.cleanTemplates(content);
            
            // 解析 AST
            const ast = parser.parse(cleanContent, {
                sourceType: 'module',
                plugins: ['jsx', 'typescript', 'decorators-legacy'],
                errorRecovery: true,
            });

            // 遍历 AST 并收集符号（传递 baseLine）
            this.traverseAST(ast, uri, result, baseLine);

            // 后处理：重建层级关系
            this.reconstructHierarchy(result.symbols);

        } catch (error) {
            console.error('[JSSymbolParser] Parse error:', error);
        }

        return result;
    }

    /**
     * 遍历 AST 并收集符号
     * 参考 outline-map 的 DocumentSymbol 收集方式
     * @param baseLine 基础行号偏移（用于内联脚本）
     */
    private traverseAST(ast: t.File, uri: vscode.Uri, result: ParseResult, baseLine: number = 0): void {
        const symbols: SymbolInfo[] = [];
        const scopeStack: SymbolInfo[] = []; // 作用域栈

        traverse(ast, {
            // 变量声明
            VariableDeclaration: (path) => {
                path.node.declarations.forEach(decl => {
                    if (t.isIdentifier(decl.id) && decl.id.loc) {
                        const symbol = this.createSymbol(
                            decl.id.name,
                            path.node.kind === 'const' ? SymbolType.Constant : SymbolType.Variable,
                            decl.id.loc,
                            uri,
                            undefined,
                            baseLine
                        );
                        
                        if (scopeStack.length > 0) {
                            this.addChildToScope(scopeStack[scopeStack.length - 1], symbol);
                        } else {
                            symbols.push(symbol);
                            result.variables.set(symbol.name, symbol);
                        }
                    }
                });
            },

            // 函数声明
            FunctionDeclaration: (path) => {
                if (path.node.id && path.node.id.loc && path.node.loc) {
                    const symbol = this.createSymbol(
                        path.node.id.name,
                        SymbolType.Function,
                        path.node.loc,
                        uri,
                        path.node.id.loc,
                        baseLine
                    );
                    
                    // 添加参数信息
                    symbol.detail = this.getFunctionSignature(path.node);
                    
                    if (scopeStack.length > 0) {
                        this.addChildToScope(scopeStack[scopeStack.length - 1], symbol);
                    } else {
                        symbols.push(symbol);
                        result.functions.set(symbol.name, symbol);
                    }

                    // 进入函数作用域
                    scopeStack.push(symbol);
                }
            },

            'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression': {
                exit: (path) => {
                    // 退出函数作用域
                    if (scopeStack.length > 0) {
                        const last = scopeStack[scopeStack.length - 1];
                        if (last.kind === SymbolType.Function || last.kind === SymbolType.Method) {
                            scopeStack.pop();
                        }
                    }
                }
            },

            // 类声明
            ClassDeclaration: {
                enter: (path) => {
                    if (path.node.id && path.node.id.loc && path.node.loc) {
                        const symbol = this.createSymbol(
                            path.node.id.name,
                            SymbolType.Class,
                            path.node.loc,
                            uri,
                            path.node.id.loc,
                            baseLine
                        );
                        
                        symbols.push(symbol);
                        result.classes.set(symbol.name, symbol);
                        
                        // 进入类作用域
                        scopeStack.push(symbol);
                    }
                },
                exit: () => {
                    // 退出类作用域
                    if (scopeStack.length > 0 && scopeStack[scopeStack.length - 1].kind === SymbolType.Class) {
                        scopeStack.pop();
                    }
                }
            },

            // 类方法
            ClassMethod: {
                enter: (path) => {
                    if (t.isIdentifier(path.node.key) && path.node.key.loc && path.node.loc) {
                        const symbol = this.createSymbol(
                            path.node.key.name,
                            SymbolType.Method,
                            path.node.loc,
                            uri,
                            path.node.key.loc,
                            baseLine
                        );
                        
                        symbol.detail = this.getFunctionSignature(path.node);
                        
                        if (scopeStack.length > 0) {
                            this.addChildToScope(scopeStack[scopeStack.length - 1], symbol);
                        }

                        scopeStack.push(symbol);
                    }
                },
                exit: () => {
                    if (scopeStack.length > 0 && scopeStack[scopeStack.length - 1].kind === SymbolType.Method) {
                        scopeStack.pop();
                    }
                }
            },

            // 对象属性（Vue data/methods/computed）
            ObjectProperty: (path) => {
                if (t.isIdentifier(path.node.key) && path.node.key.loc) {
                    // 检查是否在 Vue 选项对象中
                    if (this.isInVueContext(path)) {
                        const parentKey = this.getParentObjectKey(path);
                        
                        if (parentKey === 'data' || parentKey === 'computed' || parentKey === 'props') {
                            const symbol = this.createSymbol(
                                path.node.key.name,
                                SymbolType.Property,
                                path.node.key.loc,
                                uri,
                                undefined,
                                baseLine
                            );
                            result.thisReferences.set(symbol.name, symbol);
                        } else if (parentKey === 'methods') {
                            const symbol = this.createSymbol(
                                path.node.key.name,
                                SymbolType.Method,
                                path.node.loc || path.node.key.loc,
                                uri,
                                path.node.key.loc,
                                baseLine
                            );
                            result.thisReferences.set(symbol.name, symbol);
                        }
                    }
                }
            },

            // 对象方法（简写形式）
            ObjectMethod: (path) => {
                if (t.isIdentifier(path.node.key) && path.node.key.loc && path.node.loc) {
                    if (this.isInVueContext(path)) {
                        const symbol = this.createSymbol(
                            path.node.key.name,
                            SymbolType.Method,
                            path.node.loc,
                            uri,
                            path.node.key.loc,
                            baseLine
                        );
                        
                        symbol.detail = this.getFunctionSignature(path.node);
                        result.thisReferences.set(symbol.name, symbol);
                    }
                }
            },
        });

        result.symbols = symbols;
    }

    /**
     * 创建符号信息
     */
    private createSymbol(
        name: string,
        kind: SymbolType,
        loc: t.SourceLocation,
        uri: vscode.Uri,
        selectionLoc?: t.SourceLocation,
        baseLine: number = 0  // ✅ 添加 baseLine 参数
    ): SymbolInfo {
        const range = new vscode.Range(
            new vscode.Position(loc.start.line - 1 + baseLine, loc.start.column),
            new vscode.Position(loc.end.line - 1 + baseLine, loc.end.column)
        );

        const selectionRange = selectionLoc 
            ? new vscode.Range(
                new vscode.Position(selectionLoc.start.line - 1 + baseLine, selectionLoc.start.column),
                new vscode.Position(selectionLoc.end.line - 1 + baseLine, selectionLoc.end.column)
              )
            : range;

        return {
            name,
            kind,
            range,
            selectionRange,
            children: []
        };
    }

    /**
     * 添加子符号到作用域
     */
    private addChildToScope(parent: SymbolInfo, child: SymbolInfo): void {
        if (!parent.children) {
            parent.children = [];
        }
        parent.children.push(child);
    }

    /**
     * 获取函数签名
     */
    private getFunctionSignature(node: t.Function): string {
        const params = node.params.map(param => {
            if (t.isIdentifier(param)) {
                return param.name;
            } else if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
                return `${param.left.name} = ...`;
            } else if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
                return `...${param.argument.name}`;
            }
            return '...';
        }).join(', ');

        return `(${params})`;
    }

    /**
     * 检查是否在 Vue 上下文中
     */
    private isInVueContext(path: NodePath<any>): boolean {
        let current = path.parentPath;
        let depth = 0;
        const maxDepth = 5; // 限制查找深度

        while (current && depth < maxDepth) {
            const node = current.node;
            
            // 检查 new Vue({...})
            if (t.isNewExpression(node) && 
                t.isIdentifier(node.callee) && 
                node.callee.name === 'Vue') {
                return true;
            }

            // 检查 export default {...}
            if (t.isExportDefaultDeclaration(node)) {
                return true;
            }

            current = current.parentPath;
            depth++;
        }

        return false;
    }

    /**
     * 获取父对象的键名（用于判断 data/methods/computed）
     */
    private getParentObjectKey(path: NodePath<any>): string | null {
        const parent = path.parentPath;
        if (!parent) {
            return null;
        }

        const grandParent = parent.parentPath;
        if (!grandParent || !t.isObjectProperty(grandParent.node)) {
            return null;
        }

        const key = grandParent.node.key;
        if (t.isIdentifier(key)) {
            return key.name;
        }

        return null;
    }

    /**
     * 重建符号层级关系
     * 参考 outline-map 的 reconstructTree 方法
     */
    private reconstructHierarchy(symbols: SymbolInfo[]): void {
        // 按位置排序
        symbols.sort((a, b) => a.range.start.line - b.range.start.line);

        // 重建父子关系
        for (let i = 0; i < symbols.length; i++) {
            const symbol = symbols[i];
            
            for (let j = i + 1; j < symbols.length; j++) {
                const sibling = symbols[j];
                
                // 如果子符号完全包含在父符号范围内
                if (symbol.range.contains(sibling.range)) {
                    if (!symbol.children) {
                        symbol.children = [];
                    }
                    symbol.children.push(sibling);
                    symbols.splice(j, 1);
                    j--;
                }
            }
        }
    }

    /**
     * 清理模板代码
     */
    private cleanTemplates(content: string): string {
        return content
            // 移除 PHP 标签
            .replace(/<\?(=|php)?[\s\S]*?\?>/g, m => ' '.repeat(m.length))
            // 移除 Layui/Vue 模板
            .replace(/\{\{[\s\S]*?\}\}/g, m => `''/*${' '.repeat(m.length-5)}*/`);
    }

    /**
     * 快速哈希函数
     */
    private fastHash(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(36);
    }

    /**
     * 清除缓存
     */
    public clearCache(): void {
        this.cache.clear();
    }

    /**
     * 获取缓存统计
     */
    public getCacheStats(): { size: number; maxSize: number } {
        // LRUCache 使用私有属性，这里返回估算值
        return {
            size: 0, // 缓存项数量
            maxSize: 200 // 最大容量
        };
    }
}

/**
 * 全局单例
 */
export const jsSymbolParser = new JSSymbolParser();
