/**
 * 高性能 AST 解析工具 - 重构版本
 * 专注于变量跳转和定义查找
 */
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as vscode from 'vscode';
import { ParseResult } from '../types';

// 定义索引项
interface IndexItem {
    name: string;
    location: { line: number; column: number };
    type: 'method' | 'computed' | 'data' | 'variable' | 'function' | 'mixin-method' | 'mixin-computed' | 'mixin-data';
    context: string; // Vue组件、mixin名称等
    priority: number; // 优先级，用于排序
}

// 导入新的缓存和错误处理模块
import { astIndexCache, documentParseCache } from './cacheManager';
import { safeExecute, handleParseError, ErrorType } from './errorHandler';

// 优先级配置
const PRIORITY_CONFIG = {
    VUE_METHOD: 1,
    VUE_COMPUTED: 2,
    VUE_DATA: 3,
    MIXIN_METHOD: 4,
    MIXIN_COMPUTED: 5,
    MIXIN_DATA: 6,
    FUNCTION: 7,
    VARIABLE: 8
} as const;

/**
 * 解析搜索词，提取目标名称和调用类型
 */
function parseSearchWord(searchWord: string): { targetName: string; isThisCall: boolean; subProperty: string } {
    const isThisCall = searchWord.startsWith('this.');
    const targetName = isThisCall ? searchWord.substring(5).split('(')[0] : searchWord.split('.')[0];
    const subProperty = searchWord.includes('.') ? searchWord.split('.').slice(1).join('.') : '';
    
    return { targetName, isThisCall, subProperty };
}

/**
 * 获取项目类型的优先级
 */
function getItemPriority(type: IndexItem['type'], isThisCall: boolean): number {
    if (isThisCall) {
        // this调用时，Vue相关项优先级更高
        switch (type) {
            case 'method': return PRIORITY_CONFIG.VUE_METHOD;
            case 'computed': return PRIORITY_CONFIG.VUE_COMPUTED;
            case 'data': return PRIORITY_CONFIG.VUE_DATA;
            case 'mixin-method': return PRIORITY_CONFIG.MIXIN_METHOD;
            case 'mixin-computed': return PRIORITY_CONFIG.MIXIN_COMPUTED;
            case 'mixin-data': return PRIORITY_CONFIG.MIXIN_DATA;
            default: return PRIORITY_CONFIG.VARIABLE;
        }
    } else {
        // 普通调用时，函数和方法优先级更高
        switch (type) {
            case 'function':
            case 'method':
            case 'mixin-method': return PRIORITY_CONFIG.FUNCTION;
            default: return PRIORITY_CONFIG.VARIABLE;
        }
    }
}

/**
 * 创建索引项
 */
function createIndexItem(
    name: string,
    location: { line: number; column: number },
    type: IndexItem['type'],
    context: string = 'vue'
): IndexItem {
    return {
        name,
        location,
        type,
        context,
        priority: getItemPriority(type, false)
    };
}

/**
 * Vue组件解析器
 */
class VueComponentParser {
    private index: IndexItem[] = [];

    /**
     * 解析Vue组件结构
     */
    parseVueComponent(ast: t.File): void {
        traverse(ast, {
            // 处理Vue组件对象
            ObjectExpression: (path) => {
                this.processVueObject(path);
            },
            
            // 处理函数声明（mixin函数）
            FunctionDeclaration: (path) => {
                this.processMixinFunction(path);
            },
            
            // 处理变量声明
            VariableDeclarator: (path) => {
                this.processVariableDeclaration(path);
            }
        });
    }

    /**
     * 处理Vue组件对象
     */
    private processVueObject(path: any): void {
        const properties = path.node.properties;
        if (!properties) return;

        // 检查是否是Vue组件对象
        const hasVueProps = properties.some((prop: any) => {
            if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
                return ['data', 'methods', 'computed', 'mixins'].includes(prop.key.name);
            }
            if (t.isObjectMethod(prop) && t.isIdentifier(prop.key)) {
                return ['data', 'methods', 'computed'].includes(prop.key.name);
            }
            return false;
        });

        if (!hasVueProps) return;

        // 处理Vue组件的各个部分
        for (const prop of properties) {
            if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
                switch (prop.key.name) {
                    case 'data':
                        this.processDataProperty(prop);
                        break;
                    case 'methods':
                        this.processMethodsProperty(prop);
                        break;
                    case 'computed':
                        this.processComputedProperty(prop);
                        break;
                    case 'mixins':
                        this.processMixinsProperty(prop);
                        break;
                }
            } else if (t.isObjectMethod(prop) && t.isIdentifier(prop.key)) {
                switch (prop.key.name) {
                    case 'data':
                        this.processDataMethod(prop);
                        break;
                    case 'methods':
                        this.processMethodsMethod(prop);
                        break;
                    case 'computed':
                        this.processComputedMethod(prop);
                        break;
                }
            }
        }
    }

    /**
     * 处理data属性
     */
    private processDataProperty(prop: t.ObjectProperty): void {
        if (t.isFunctionExpression(prop.value) || t.isArrowFunctionExpression(prop.value)) {
            const returnObj = this.findReturnObject(prop.value);
            if (returnObj) {
                this.processDataReturnObject(returnObj);
            }
        }
    }

    /**
     * 处理data方法
     */
    private processDataMethod(method: t.ObjectMethod): void {
        const returnObj = this.findReturnObjectInMethod(method);
        if (returnObj) {
            this.processDataReturnObject(returnObj);
        }
    }

    /**
     * 处理methods属性
     */
    private processMethodsProperty(prop: t.ObjectProperty): void {
        if (t.isObjectExpression(prop.value)) {
            this.processMethodsObject(prop.value);
        }
    }

    /**
     * 处理methods方法
     */
    private processMethodsMethod(method: t.ObjectMethod): void {
        if (t.isBlockStatement(method.body)) {
            for (const stmt of method.body.body) {
                if (t.isReturnStatement(stmt) && t.isObjectExpression(stmt.argument)) {
                    this.processMethodsObject(stmt.argument);
                    break;
                }
            }
        }
    }

    /**
     * 处理computed属性
     */
    private processComputedProperty(prop: t.ObjectProperty): void {
        if (t.isObjectExpression(prop.value)) {
            this.processComputedObject(prop.value);
        }
    }

    /**
     * 处理computed方法
     */
    private processComputedMethod(method: t.ObjectMethod): void {
        if (t.isBlockStatement(method.body)) {
            for (const stmt of method.body.body) {
                if (t.isReturnStatement(stmt) && t.isObjectExpression(stmt.argument)) {
                    this.processComputedObject(stmt.argument);
                    break;
                }
            }
        }
    }

    /**
     * 处理mixins属性
     */
    private processMixinsProperty(prop: t.ObjectProperty): void {
        if (t.isArrayExpression(prop.value)) {
            for (const element of prop.value.elements) {
                if (t.isIdentifier(element)) {
                    // 这里可以进一步处理mixin引用
                    console.log(`[Vue Parser] Found mixin reference: ${element.name}`);
                }
            }
        }
    }

    /**
     * 处理data返回对象
     */
    private processDataReturnObject(objExpr: t.ObjectExpression): void {
        for (const prop of objExpr.properties) {
            if (t.isObjectProperty(prop) && t.isIdentifier(prop.key) && prop.loc) {
                this.index.push(createIndexItem(
                    prop.key.name,
                    { line: prop.loc.start.line - 1, column: prop.loc.start.column },
                    'data',
                    'vue'
                ));
            }
        }
    }

    /**
     * 处理方法对象
     */
    private processMethodsObject(objExpr: t.ObjectExpression): void {
        for (const prop of objExpr.properties) {
            if (t.isObjectMethod(prop) && t.isIdentifier(prop.key) && prop.loc) {
                this.index.push(createIndexItem(
                    prop.key.name,
                    { line: prop.loc.start.line - 1, column: prop.loc.start.column },
                    'method',
                    'vue'
                ));
            } else if (t.isObjectProperty(prop) && t.isIdentifier(prop.key) && prop.loc) {
                this.index.push(createIndexItem(
                    prop.key.name,
                    { line: prop.loc.start.line - 1, column: prop.loc.start.column },
                    'method',
                    'vue'
                ));
            }
        }
    }

    /**
     * 处理计算属性对象
     */
    private processComputedObject(objExpr: t.ObjectExpression): void {
        for (const prop of objExpr.properties) {
            if (t.isObjectMethod(prop) && t.isIdentifier(prop.key) && prop.loc) {
                this.index.push(createIndexItem(
                    prop.key.name,
                    { line: prop.loc.start.line - 1, column: prop.loc.start.column },
                    'computed',
                    'vue'
                ));
            } else if (t.isObjectProperty(prop) && t.isIdentifier(prop.key) && prop.loc) {
                this.index.push(createIndexItem(
                    prop.key.name,
                    { line: prop.loc.start.line - 1, column: prop.loc.start.column },
                    'computed',
                    'vue'
                ));
            }
        }
    }

    /**
     * 处理mixin函数
     */
    private processMixinFunction(path: any): void {
        if (!path.node.id || !t.isIdentifier(path.node.id)) return;

        const functionName = path.node.id.name;
        const returnObj = this.findReturnObjectInFunction(path.node);
        
        if (returnObj) {
            // 处理mixin返回对象
            this.processMixinReturnObject(returnObj, functionName);
        }
    }

    /**
     * 处理变量声明
     */
    private processVariableDeclaration(path: any): void {
        if (t.isIdentifier(path.node.id) && path.node.init && path.node.loc) {
            const name = path.node.id.name;
            
            // 检查是否是函数或对象
            if (t.isFunctionExpression(path.node.init) || t.isArrowFunctionExpression(path.node.init)) {
                this.index.push(createIndexItem(
                    name,
                    { line: path.node.loc.start.line - 1, column: path.node.loc.start.column },
                    'function',
                    'global'
                ));
            } else if (t.isObjectExpression(path.node.init)) {
                // 检查是否是mixin对象
                const hasMixinProps = path.node.init.properties.some((prop: any) => {
                    if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
                        return ['data', 'methods', 'computed'].includes(prop.key.name);
                    }
                    return false;
                });

                if (hasMixinProps) {
                    this.processMixinReturnObject(path.node.init, name);
                } else {
                    this.index.push(createIndexItem(
                        name,
                        { line: path.node.loc.start.line - 1, column: path.node.loc.start.column },
                        'variable',
                        'global'
                    ));
                }
            } else {
                this.index.push(createIndexItem(
                    name,
                    { line: path.node.loc.start.line - 1, column: path.node.loc.start.column },
                    'variable',
                    'global'
                ));
            }
        }
    }

    /**
     * 处理mixin返回对象
     */
    private processMixinReturnObject(objExpr: t.ObjectExpression, mixinName: string): void {
        for (const prop of objExpr.properties) {
            if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
                switch (prop.key.name) {
                    case 'data':
                        if (t.isFunctionExpression(prop.value) || t.isArrowFunctionExpression(prop.value)) {
                            const returnObj = this.findReturnObject(prop.value);
                            if (returnObj) {
                                this.processMixinDataReturnObject(returnObj, mixinName);
                            }
                        }
                        break;
                    case 'methods':
                        if (t.isObjectExpression(prop.value)) {
                            this.processMixinMethodsObject(prop.value, mixinName);
                        }
                        break;
                    case 'computed':
                        if (t.isObjectExpression(prop.value)) {
                            this.processMixinComputedObject(prop.value, mixinName);
                        }
                        break;
                }
            }
        }
    }

    /**
     * 处理mixin data返回对象
     */
    private processMixinDataReturnObject(objExpr: t.ObjectExpression, mixinName: string): void {
        for (const prop of objExpr.properties) {
            if (t.isObjectProperty(prop) && t.isIdentifier(prop.key) && prop.loc) {
                this.index.push(createIndexItem(
                    prop.key.name,
                    { line: prop.loc.start.line - 1, column: prop.loc.start.column },
                    'mixin-data',
                    mixinName
                ));
            }
        }
    }

    /**
     * 处理mixin methods对象
     */
    private processMixinMethodsObject(objExpr: t.ObjectExpression, mixinName: string): void {
        for (const prop of objExpr.properties) {
            if (t.isObjectMethod(prop) && t.isIdentifier(prop.key) && prop.loc) {
                this.index.push(createIndexItem(
                    prop.key.name,
                    { line: prop.loc.start.line - 1, column: prop.loc.start.column },
                    'mixin-method',
                    mixinName
                ));
            }
        }
    }

    /**
     * 处理mixin computed对象
     */
    private processMixinComputedObject(objExpr: t.ObjectExpression, mixinName: string): void {
        for (const prop of objExpr.properties) {
            if (t.isObjectMethod(prop) && t.isIdentifier(prop.key) && prop.loc) {
                this.index.push(createIndexItem(
                    prop.key.name,
                    { line: prop.loc.start.line - 1, column: prop.loc.start.column },
                    'mixin-computed',
                    mixinName
                ));
            }
        }
    }

    /**
     * 查找函数返回对象
     */
    private findReturnObject(funcNode: t.FunctionExpression | t.ArrowFunctionExpression): t.ObjectExpression | undefined {
        if (t.isArrowFunctionExpression(funcNode) && t.isObjectExpression(funcNode.body)) {
            return funcNode.body;
        }

        if (t.isBlockStatement(funcNode.body)) {
            for (const stmt of funcNode.body.body) {
                if (t.isReturnStatement(stmt) && t.isObjectExpression(stmt.argument)) {
                    return stmt.argument;
                }
            }
        }

        return undefined;
    }

    /**
     * 查找方法返回对象
     */
    private findReturnObjectInMethod(methodNode: t.ObjectMethod): t.ObjectExpression | undefined {
        if (t.isBlockStatement(methodNode.body)) {
            for (const stmt of methodNode.body.body) {
                if (t.isReturnStatement(stmt) && t.isObjectExpression(stmt.argument)) {
                    return stmt.argument;
                }
            }
        }
        return undefined;
    }

    /**
     * 查找函数返回对象
     */
    private findReturnObjectInFunction(funcNode: t.FunctionDeclaration): t.ObjectExpression | undefined {
        if (t.isBlockStatement(funcNode.body)) {
            for (const stmt of funcNode.body.body) {
                if (t.isReturnStatement(stmt) && t.isObjectExpression(stmt.argument)) {
                    return stmt.argument;
                }
            }
        }
        return undefined;
    }

    /**
     * 获取解析结果
     */
    getIndex(): IndexItem[] {
        return this.index;
    }
}

/**
 * 构建高效索引
 */
async function buildASTIndex(scriptContent: string): Promise<IndexItem[]> {
    const cacheKey = scriptContent;
    
    // 检查缓存
    const cachedIndex = astIndexCache.getIndex(cacheKey);
    if (cachedIndex) {
        return cachedIndex;
    }

    const result = await safeExecute(() => {
        const ast = parser.parse(scriptContent, {
            sourceType: 'module',
            plugins: ['jsx'],
            errorRecovery: true,
        });

        const vueParser = new VueComponentParser();
        vueParser.parseVueComponent(ast);
        
        const index = vueParser.getIndex();
        
        // 缓存结果
        astIndexCache.setIndex(cacheKey, index);
        
        console.log(`[AST Parser] 构建索引完成，共 ${index.length} 个项目`);
        return index;
    }, ErrorType.PARSE_ERROR);
    
    return result || [];
}

/**
 * 查找定义 - 主要入口函数
 */
export async function parseAST(scriptContent: string, searchWord: string, isThisCall: boolean): Promise<{ line: number; column: number } | null> {
    console.time('[AST Parser] 查找定义耗时');
    
    try {
        const { targetName, isThisCall: parsedIsThisCall } = parseSearchWord(searchWord);
        const shouldUseThisCall = isThisCall || parsedIsThisCall;

        console.log(`[AST Parser] 查找: ${targetName}, isThisCall: ${shouldUseThisCall}`);

        // 构建索引
        const index = await buildASTIndex(scriptContent);

        // 查找匹配项
        const matchItems = index.filter(item => item.name === targetName);
        
        if (matchItems.length > 0) {
            // 根据调用类型重新计算优先级并排序
            const sortedItems = matchItems.map(item => ({
                ...item,
                priority: getItemPriority(item.type, shouldUseThisCall)
            })).sort((a, b) => a.priority - b.priority);

            const bestMatch = sortedItems[0];
            console.log(`[AST Parser] 找到最佳匹配: ${bestMatch.name} (${bestMatch.type}) 在 ${bestMatch.context}`);
            console.timeEnd('[AST Parser] 查找定义耗时');
            return bestMatch.location;
        }

        console.log(`[AST Parser] 未找到匹配项: ${targetName}`);
        console.timeEnd('[AST Parser] 查找定义耗时');
        return null;
    } catch (error) {
        console.error('[AST Parser] 查找定义时出错:', error);
        console.timeEnd('[AST Parser] 查找定义耗时');
        return null;
    }
}

/**
 * 解析文档，提取变量和方法
 */
export async function parseDocument(document: vscode.TextDocument): Promise<ParseResult | null> {
    const text = document.getText();
    const filename = document.fileName;
    
    console.time('[AST Parser] 解析文档耗时');
    
    try {
        // 使用已经构建的索引
        const index = await buildASTIndex(text);

        // 初始化结果
        const variables: vscode.CompletionItem[] = [];
        const methods: vscode.CompletionItem[] = [];
        const thisReferences = new Map<string, vscode.CompletionItem>();

        // 从索引转换为补全项
        for (const item of index) {
            const completionItem = new vscode.CompletionItem(
                item.name,
                getCompletionItemKind(item.type)
            );

            completionItem.detail = getCompletionItemDetail(item);

            // 根据类型添加到对应集合
            switch (item.type) {
                case 'variable':
                    variables.push(completionItem);
                    break;

                case 'function':
                case 'method':
                case 'mixin-method':
                    methods.push(completionItem);

                    // 如果是Vue方法，也添加到this引用中
                    if (item.type !== 'function') {
                        thisReferences.set(item.name, completionItem);
                    }
                    break;

                case 'computed':
                case 'data':
                case 'mixin-computed':
                case 'mixin-data':
                    // Vue相关属性添加到this引用
                    thisReferences.set(item.name, completionItem);
                    break;
            }
        }

        console.timeEnd('[AST Parser] 解析文档耗时');
        console.log(`[AST Parser] 解析结果: ${variables.length}个变量, ${methods.length}个方法, ${thisReferences.size}个this引用`);

        return {
            variables,
            methods,
            thisReferences,
            timestamp: Date.now()
        };
    } catch (error) {
        console.error(`[AST Parser] 解析文档 ${filename} 时出错:`, error);
        console.timeEnd('[AST Parser] 解析文档耗时');
        return {
            variables: [],
            methods: [],
            thisReferences: new Map(),
            timestamp: Date.now()
        };
    }
}

/**
 * 获取补全项的类型
 */
function getCompletionItemKind(type: string): vscode.CompletionItemKind {
    switch (type) {
        case 'method':
        case 'mixin-method':
            return vscode.CompletionItemKind.Method;
        case 'function':
            return vscode.CompletionItemKind.Function;
        case 'computed':
        case 'mixin-computed':
        case 'data':
        case 'mixin-data':
            return vscode.CompletionItemKind.Property;
        case 'variable':
        default:
            return vscode.CompletionItemKind.Variable;
    }
}

/**
 * 获取补全项的详情文本
 */
function getCompletionItemDetail(item: IndexItem): string {
    switch (item.type) {
        case 'method':
            return `(Vue method) ${item.name}`;
        case 'mixin-method':
            return `(Mixin '${item.context}' method) ${item.name}`;
        case 'computed':
            return `(Vue computed) ${item.name}`;
        case 'mixin-computed':
            return `(Mixin '${item.context}' computed) ${item.name}`;
        case 'data':
            return `(Vue data property) ${item.name}`;
        case 'mixin-data':
            return `(Mixin '${item.context}' data) ${item.name}`;
        case 'function':
            return `(函数) ${item.name}`;
        case 'variable':
        default:
            return `(变量) ${item.name}`;
    }
}
