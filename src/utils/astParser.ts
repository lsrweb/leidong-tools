/**
 * 高性能 AST 解析工具 - 完全重写版本
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
}

// 全局索引缓存
// 全局索引和文档缓存系统
const astIndexCache = new Map<string, IndexItem[]>();
const documentCache = new Map<string, { timestamp: number; result: ParseResult }>();

// Mixin分析结果类型
interface MixinInfo {
    type: 'variable' | 'object' | 'function';
    name?: string;                  // 变量名称
    node?: t.ObjectExpression;      // 对象字面量节点
    functionPath?: any;             // 函数路径
}

/**
 * 构建高效索引 - 只遍历一次AST
 */
function buildASTIndex(scriptContent: string): IndexItem[] {
    // 内部辅助函数：在函数中查找return对象
    function findReturnObjectInFunction(funcNode: t.FunctionExpression | t.ArrowFunctionExpression): t.ObjectExpression | undefined {
        if (t.isArrowFunctionExpression(funcNode) && t.isObjectExpression(funcNode.body)) {
            return funcNode.body;
        }

        let returnObj: t.ObjectExpression | undefined;

        if (t.isBlockStatement(funcNode.body)) {
            for (const stmt of funcNode.body.body) {
                if (t.isReturnStatement(stmt) && t.isObjectExpression(stmt.argument)) {
                    returnObj = stmt.argument;
                    break;
                }
            }
        }

        return returnObj;
    }

    // 内部辅助函数：在对象方法中查找return对象
    function findReturnObjectInObjectMethod(methodNode: t.ObjectMethod): t.ObjectExpression | undefined {
        let returnObj: t.ObjectExpression | undefined;

        if (t.isBlockStatement(methodNode.body)) {
            for (const stmt of methodNode.body.body) {
                if (t.isReturnStatement(stmt) && t.isObjectExpression(stmt.argument)) {
                    returnObj = stmt.argument;
                    break;
                }
            }
        }

        return returnObj;
    }

    // 内部辅助函数：处理data返回对象中的属性
    function processDataReturnProperties(objExpr: t.ObjectExpression, indexArray: IndexItem[], context: string = 'vue'): void {
        if (!objExpr || !objExpr.properties) return;

        for (const prop of objExpr.properties) {
            if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
                const propName = prop.key.name;
                const loc = prop.loc;

                if (loc) {
                    // 确保数据属性被正确标记为Vue组件数据或mixin数据
                    const type = context === 'vue' ? 'data' : 'mixin-data';
                    indexArray.push({
                        name: propName,
                        location: { line: loc.start.line - 1, column: loc.start.column },
                        type: type,
                        context: context
                    });

                    console.log(`[AST Parser] 添加${type}属性: ${propName}, 上下文: ${context}`);
                }
            }
        }
    }

    const cacheKey = scriptContent; // 简化缓存键
    if (astIndexCache.has(cacheKey)) {
        return astIndexCache.get(cacheKey)!;
    }

    const index: IndexItem[] = [];
    const mixinVariables = new Set<string>();
    const mixinObjects: MixinInfo[] = [];
    const functionReturns = new Map<string, t.ObjectExpression>();
    // 存储变量定义，用于解析mixins
    const variableDefinitions = new Map<string, t.ObjectExpression | t.FunctionExpression | t.ArrowFunctionExpression>();
    // 存储对象方法定义，用于解析data方法等
    const objectMethods = new Map<string, { parentContext: string; node: t.ObjectMethod }>();

    try {
        const ast = parser.parse(scriptContent, {
            sourceType: 'module',
            plugins: ['jsx'],
            errorRecovery: true,
        });        // 第一次遍历：收集所有变量和函数定义
        traverse(ast, {
            // 收集变量定义，用于后续解析mixins
            VariableDeclarator(path) {
                if (t.isIdentifier(path.node.id)) {
                    const name = path.node.id.name;
                    if (path.node.init) {
                        if (t.isObjectExpression(path.node.init)) {
                            variableDefinitions.set(name, path.node.init);
                        } else if (t.isFunctionExpression(path.node.init) || t.isArrowFunctionExpression(path.node.init)) {
                            variableDefinitions.set(name, path.node.init);
                        }
                    }
                }
            },

            // 收集函数定义，处理类似 function fanganMixin() {} 的情况
            FunctionDeclaration(path) {
                if (path.node.id && t.isIdentifier(path.node.id)) {
                    const name = path.node.id.name;

                    // 查找函数体中的return语句
                    let returnObj: t.ObjectExpression | undefined;
                    if (t.isBlockStatement(path.node.body)) {
                        for (const stmt of path.node.body.body) {
                            if (t.isReturnStatement(stmt) && t.isObjectExpression(stmt.argument)) {
                                // 找到函数的返回对象，尝试检查是否是mixin对象
                                returnObj = stmt.argument;

                                // 检查返回对象是否包含mixin相关的属性
                                const hasMixinProps = returnObj.properties.some(prop => {
                                    if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
                                        return ['data', 'methods', 'computed'].includes(prop.key.name);
                                    }
                                    if (t.isObjectMethod(prop) && t.isIdentifier(prop.key)) {
                                        return prop.key.name === 'data';
                                    }
                                    return false;
                                });
                                if (hasMixinProps) {
                                    // 这是一个mixin函数，处理它的return对象
                                    console.log(`[AST Parser] 发现mixin函数: ${name}`);
                                    functionReturns.set(name, returnObj);

                                    // 将返回的mixin对象添加到mixinObjects中，以便在第二阶段处理
                                    mixinObjects.push({
                                        type: 'function',
                                        name: name
                                    });

                                    // 立即处理mixin函数返回对象中的data方法
                                    for (const prop of returnObj.properties) {
                                        if (t.isObjectMethod(prop) && t.isIdentifier(prop.key) && prop.key.name === 'data') {
                                            // 处理ObjectMethod形式的data方法
                                            const dataReturnObj = findReturnObjectInObjectMethod(prop);
                                            if (dataReturnObj) {
                                                console.log(`[AST Parser] 处理mixin函数 ${name} 的data方法返回对象`);
                                                processDataReturnProperties(dataReturnObj, index, name);
                                            }
                                        } else if (t.isObjectProperty(prop) && t.isIdentifier(prop.key) && prop.key.name === 'data') {
                                            // 处理ObjectProperty形式的data方法
                                            if (t.isFunctionExpression(prop.value) || t.isArrowFunctionExpression(prop.value)) {
                                                const dataReturnObj = findReturnObjectInFunction(prop.value);
                                                if (dataReturnObj) {
                                                    console.log(`[AST Parser] 处理mixin函数 ${name} 的data属性返回对象`);
                                                    processDataReturnProperties(dataReturnObj, index, name);
                                                }
                                            }
                                        }
                                    }
                                }

                                break;
                            }
                        }
                    }
                }
            },

            // 收集函数返回值
            ReturnStatement(path) {
                if (t.isObjectExpression(path.node.argument) &&
                    path.findParent(p => p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression())) {

                    // 查找函数名
                    let funcPath = path.findParent(p => p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression());
                    let funcName = '';

                    if (funcPath && funcPath.isFunctionDeclaration() && funcPath.node.id) {
                        funcName = funcPath.node.id.name;
                    } else if (funcPath && funcPath.parentPath && funcPath.parentPath.isVariableDeclarator() && t.isIdentifier(funcPath.parentPath.node.id)) {
                        funcName = funcPath.parentPath.node.id.name;
                    } else if (funcPath && funcPath.parentPath && funcPath.parentPath.isAssignmentExpression() && t.isIdentifier(funcPath.parentPath.node.left)) {
                        funcName = funcPath.parentPath.node.left.name;
                    }

                    // 特殊处理：data方法中的返回值
                    let isDataMethod = false;
                    if (funcPath && funcPath.parentPath && funcPath.parentPath.isObjectProperty() &&
                        t.isIdentifier(funcPath.parentPath.node.key) && funcPath.parentPath.node.key.name === 'data') {
                        isDataMethod = true;
                        funcName = 'data_return';
                    } else if (funcPath && funcPath.isObjectMethod() && t.isIdentifier(funcPath.node.key) && funcPath.node.key.name === 'data') {
                        isDataMethod = true;
                        funcName = 'data_return';
                    } else {
                        // 检查函数返回值是否是一个mixin对象
                        const returnObj = path.node.argument;
                        const hasMixinProps = returnObj.properties.some(prop => {
                            if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
                                return ['data', 'methods', 'computed'].includes(prop.key.name);
                            }
                            if (t.isObjectMethod(prop) && t.isIdentifier(prop.key)) {
                                return prop.key.name === 'data';
                            }
                            return false;
                        });

                        if (hasMixinProps && funcName) {
                            // 这是一个mixin函数的返回值
                            console.log(`[AST Parser] 发现mixin函数返回值: ${funcName}`);
                            // 记录函数返回值是mixin对象
                            mixinObjects.push({
                                type: 'function',
                                name: funcName
                            });
                        }
                    }

                    if (funcName) {
                        functionReturns.set(funcName, path.node.argument);

                        // 如果是data方法返回，直接处理属性
                        if (isDataMethod) {
                            processDataReturnProperties(path.node.argument, index);
                        }
                    }
                }
            },

            // 收集对象方法，用于后续处理
            ObjectMethod(path) {
                if (t.isIdentifier(path.node.key)) {
                    const keyName = path.node.key.name;

                    // 特殊处理data方法
                    if (keyName === 'data') {
                        const parentContext = getVueContext(path) || 'unknown';
                        objectMethods.set(keyName, { parentContext, node: path.node });
                    }
                }
            },

            // 收集mixins定义
            ObjectProperty(path) {
                if (t.isIdentifier(path.node.key) && path.node.key.name === 'mixins' &&
                    t.isArrayExpression(path.node.value)) {

                    path.node.value.elements.forEach(element => {
                        // 处理变量引用
                        if (t.isIdentifier(element)) {
                            mixinVariables.add(element.name);
                            mixinObjects.push({
                                type: 'variable',
                                name: element.name
                            });
                        }
                        // 处理对象字面量
                        else if (t.isObjectExpression(element)) {
                            mixinObjects.push({
                                type: 'object',
                                node: element
                            });
                        }
                        // 处理函数调用
                        else if (t.isCallExpression(element) && t.isIdentifier(element.callee)) {
                            mixinObjects.push({
                                type: 'function',
                                name: element.callee.name
                            });
                        }
                    });
                }
            },

            // 收集所有基本定义
            enter(path) {
                // 函数声明
                if (path.isFunctionDeclaration() && path.node.id && t.isIdentifier(path.node.id)) {
                    const loc = path.node.loc;
                    if (loc) {
                        index.push({
                            name: path.node.id.name,
                            location: { line: loc.start.line - 1, column: loc.start.column },
                            type: 'function',
                            context: 'global'
                        });
                    }
                    return;
                }

                // 变量声明
                if (path.isVariableDeclarator() && t.isIdentifier(path.node.id)) {
                    const loc = path.node.loc;
                    if (loc) {
                        index.push({
                            name: path.node.id.name,
                            location: { line: loc.start.line - 1, column: loc.start.column },
                            type: 'variable',
                            context: 'global'
                        });
                    }
                }

                // Vue组件属性：methods, computed, data
                if (path.isObjectProperty() && t.isIdentifier(path.node.key)) {
                    const keyName = path.node.key.name;
                    const loc = path.node.loc;
                    if (!loc) return;

                    // 检查父级上下文
                    const parentContext = getVueContext(path);
                    if (parentContext) {
                        const itemType = getItemType(parentContext, path.node.value);
                        index.push({
                            name: keyName,
                            location: { line: loc.start.line - 1, column: loc.start.column },
                            type: itemType,
                            context: parentContext
                        });
                        return;
                    }

                    // 检查mixin定义
                    const mixinContext = getMixinContext(path, mixinVariables);
                    if (mixinContext) {
                        const itemType = getMixinItemType(mixinContext.type, path.node.value);
                        index.push({
                            name: keyName,
                            location: { line: loc.start.line - 1, column: loc.start.column },
                            type: itemType,
                            context: mixinContext.name
                        });
                    }
                }

                // Vue组件方法（ObjectMethod语法）
                if (path.isObjectMethod() && t.isIdentifier(path.node.key)) {
                    const keyName = path.node.key.name;
                    const loc = path.node.loc;
                    if (!loc) return;

                    const parentContext = getVueContext(path);
                    if (parentContext) {
                        index.push({
                            name: keyName,
                            location: { line: loc.start.line - 1, column: loc.start.column },
                            type: parentContext === 'computed' ? 'computed' : 'method',
                            context: 'vue'
                        });
                        return;
                    }

                    const mixinContext = getMixinContext(path, mixinVariables);
                    if (mixinContext) {
                        index.push({
                            name: keyName,
                            location: { line: loc.start.line - 1, column: loc.start.column },
                            type: mixinContext.type === 'computed' ? 'mixin-computed' : 'mixin-method',
                            context: mixinContext.name
                        });
                    }
                }
            }
        });

        // 第二次处理：解析mixins和函数返回值

        // 1. 处理mixins
        for (const mixinInfo of mixinObjects) {
            if (mixinInfo.type === 'variable' && mixinInfo.name) {
                // 查找变量定义
                const mixinDef = variableDefinitions.get(mixinInfo.name);
                if (mixinDef) {
                    if (t.isObjectExpression(mixinDef)) {
                        // 直接处理对象字面量
                        processMixinObjectExpression(mixinDef, mixinInfo.name, index);
                    } else if (t.isFunctionExpression(mixinDef) || t.isArrowFunctionExpression(mixinDef)) {
                        // 处理函数返回值
                        const returnObj = functionReturns.get(mixinInfo.name);
                        if (returnObj) {
                            processMixinObjectExpression(returnObj, mixinInfo.name, index);
                        }
                    }
                }
            } else if (mixinInfo.type === 'object' && mixinInfo.node) {
                // 直接处理对象字面量
                processMixinObjectExpression(mixinInfo.node, 'inlineMixin', index);
            } else if (mixinInfo.type === 'function' && mixinInfo.name) {
                // 查找函数返回值
                const returnObj = functionReturns.get(mixinInfo.name);
                if (returnObj) {
                    processMixinObjectExpression(returnObj, mixinInfo.name, index);
                }
            }
        }

        // 2. 处理data方法
        const dataReturn = functionReturns.get('data_return');
        if (dataReturn) {
            processDataReturnProperties(dataReturn, index);
        }

        // 缓存结果
        astIndexCache.set(cacheKey, index);
        return index;

        // 内部辅助函数：处理mixin对象
        function processMixinObjectExpression(objExpr: t.ObjectExpression, mixinName: string, indexArray: IndexItem[]): void {
            // 遍历对象属性
            for (const prop of objExpr.properties) {
                // 处理方法、计算属性和数据对象
                if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
                    const sectionName = prop.key.name;
                    if (sectionName === 'methods' && t.isObjectExpression(prop.value)) {
                        // 处理methods
                        processMixinSection(prop.value, 'methods', mixinName, indexArray);
                    } else if (sectionName === 'computed' && t.isObjectExpression(prop.value)) {
                        // 处理computed
                        processMixinSection(prop.value, 'computed', mixinName, indexArray);
                    } else if (sectionName === 'data' && (t.isFunctionExpression(prop.value) || t.isArrowFunctionExpression(prop.value))) {
                        // data函数，查找返回值
                        const dataReturnKey = `${mixinName}_data_return`;
                        const returnObj = functionReturns.get(dataReturnKey) || findReturnObjectInFunction(prop.value);
                        if (returnObj) {
                            // 处理data属性，确保它们被标记为mixin-data类型，并关联到正确的mixin上下文
                            processDataReturnProperties(returnObj, indexArray, mixinName);
                        }
                    }
                } else if (t.isObjectMethod(prop) && t.isIdentifier(prop.key)) {
                    const methodName = prop.key.name; if (methodName === 'data') {
                        // data方法，在函数体中查找return语句
                        const returnObj = findReturnObjectInObjectMethod(prop);
                        if (returnObj) {
                            // 处理data属性，确保它们被标记为mixin-data类型
                            processDataReturnProperties(returnObj, indexArray, mixinName);
                        }
                    }
                }
            }
        }

        // 内部辅助函数：处理mixin对象中的section
        function processMixinSection(objExpr: t.ObjectExpression, sectionType: string, mixinName: string, indexArray: IndexItem[]): void {
            for (const prop of objExpr.properties) {
                if ((t.isObjectProperty(prop) || t.isObjectMethod(prop)) && t.isIdentifier(prop.key)) {
                    const propName = prop.key.name;
                    const loc = prop.loc;

                    if (loc) {
                        let type: IndexItem['type'];
                        switch (sectionType) {
                            case 'methods':
                                type = 'mixin-method';
                                break;
                            case 'computed':
                                type = 'mixin-computed';
                                break;
                            case 'data':
                                type = 'mixin-data';
                                break;
                            default:
                                type = 'mixin-method';
                        }

                        indexArray.push({
                            name: propName,
                            location: { line: loc.start.line - 1, column: loc.start.column },
                            type,
                            context: mixinName
                        });
                    }
                }
            }
        }
        // 内部辅助函数：处理data返回对象中的属性
        function processDataReturnProperties(objExpr: t.ObjectExpression, indexArray: IndexItem[], context: string = 'vue'): void {
            if (!objExpr || !objExpr.properties) return;

            for (const prop of objExpr.properties) {
                if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
                    const propName = prop.key.name;
                    const loc = prop.loc;

                    if (loc) {
                        // 确保数据属性被正确标记为Vue组件数据或mixin数据
                        const type = context === 'vue' ? 'data' : 'mixin-data';
                        indexArray.push({
                            name: propName,
                            location: { line: loc.start.line - 1, column: loc.start.column },
                            type: type,
                            context: context
                        });

                        console.log(`[AST Parser] 添加${type}属性: ${propName}, 上下文: ${context}`);
                    }
                }
            }
        }
    } catch (error) {
        console.error('[AST Parser] Error building index:', error);
        return [];
    }
}

/**
 * 获取Vue组件上下文
 */
function getVueContext(path: any): string | null {
    let current = path.parentPath;
    while (current) {
        if (current.isObjectProperty() && t.isIdentifier(current.node.key)) {
            const sectionName = current.node.key.name;
            if (['methods', 'computed', 'data'].includes(sectionName)) {
                return sectionName;
            }
        }

        // 检查data函数的返回对象
        if (current.isReturnStatement()) {
            let funcPath = current.parentPath;
            while (funcPath && !funcPath.isFunctionExpression() && !funcPath.isArrowFunctionExpression()) {
                funcPath = funcPath.parentPath;
            }
            if (funcPath?.parentPath?.isObjectProperty() &&
                t.isIdentifier(funcPath.parentPath.node.key) &&
                funcPath.parentPath.node.key.name === 'data') {
                return 'data';
            }
        }

        current = current.parentPath;
    }
    return null;
}

/**
 * 获取mixin上下文
 */
function getMixinContext(path: any, mixinVariables: Set<string>): { name: string; type: string } | null {
    let current = path.parentPath;
    while (current) {
        // 检查是否在mixin的methods/computed/data中
        if (current.isObjectProperty() && t.isIdentifier(current.node.key)) {
            const sectionName = current.node.key.name;
            if (['methods', 'computed', 'data'].includes(sectionName)) {
                // 继续向上查找mixin变量声明
                let mixinPath = current.parentPath;
                while (mixinPath) {
                    if (mixinPath.isVariableDeclarator() &&
                        t.isIdentifier(mixinPath.node.id) &&
                        mixinVariables.has(mixinPath.node.id.name)) {
                        return { name: mixinPath.node.id.name, type: sectionName };
                    }
                    mixinPath = mixinPath.parentPath;
                }
            }
        }
        current = current.parentPath;
    }
    return null;
}

/**
 * 获取项目类型
 */
function getItemType(context: string, value: any): IndexItem['type'] {
    switch (context) {
        case 'methods':
            return 'method';
        case 'computed':
            return 'computed';
        case 'data':
            return 'data';
        default:
            return t.isFunctionExpression(value) || t.isArrowFunctionExpression(value) ? 'method' : 'data';
    }
}

/**
 * 获取mixin项目类型
 */
function getMixinItemType(context: string, value: any): IndexItem['type'] {
    switch (context) {
        case 'methods':
            return 'mixin-method';
        case 'computed':
            return 'mixin-computed';
        case 'data':
            return 'mixin-data';
        default:
            return t.isFunctionExpression(value) || t.isArrowFunctionExpression(value) ? 'mixin-method' : 'mixin-data';
    }
}

/**
 * 解析搜索词
 */
function parseSearchWord(searchWord: string): { targetName: string; isThisCall: boolean; subProperty: string } {
    // 移除括号
    const cleanWord = searchWord.includes('(') ? searchWord.split('(')[0] : searchWord;

    // 处理this.xxx, that.xxx
    if (cleanWord.startsWith('this.') || cleanWord.startsWith('that.')) {
        const parts = cleanWord.substring(5).split('.');
        return {
            targetName: parts[0],
            isThisCall: true,
            subProperty: parts.slice(1).join('.')
        };
    }

    return {
        targetName: cleanWord,
        isThisCall: false,
        subProperty: ''
    };
}

/**
 * 高效查找定义 - 直接从索引查找，利用Map加速查找
 */
export function parseAST(scriptContent: string, searchWord: string, isThisCall: boolean): { line: number; column: number } | null {
    console.time('[AST Parser] 查找定义耗时');
    try {
        const { targetName, isThisCall: parsedIsThisCall, subProperty } = parseSearchWord(searchWord);
        const shouldUseThisCall = isThisCall || parsedIsThisCall;

        console.log(`[AST Parser] 快速查找: ${targetName}, isThisCall: ${shouldUseThisCall}, 子属性: ${subProperty}`);

        // 构建索引
        const index = buildASTIndex(scriptContent);

        // 创建名称到索引项的映射，加速查找
        const nameToItems = new Map<string, IndexItem[]>();
        for (const item of index) {
            if (!nameToItems.has(item.name)) {
                nameToItems.set(item.name, []);
            }
            nameToItems.get(item.name)!.push(item);
        }

        // 直接从Map中获取匹配项
        const matchItems = nameToItems.get(targetName);
        if (matchItems && matchItems.length > 0) {
            // 根据调用类型优先级排序
            const sortedItems = sortItemsByPriority(matchItems, shouldUseThisCall);

            // 取优先级最高的项
            const bestMatch = sortedItems[0];
            console.log(`[AST Parser] 找到最佳匹配: ${bestMatch.name} (${bestMatch.type}) 在 ${bestMatch.context}`);
            console.timeEnd('[AST Parser] 查找定义耗时');
            return bestMatch.location;
        }

        console.log(`[AST Parser] 未找到匹配项: ${targetName}`);
        console.timeEnd('[AST Parser] 查找定义耗时');
        return null;
    } catch (error) {
        console.error('[AST Parser] Error in parseAST:', error);
        console.timeEnd('[AST Parser] 查找定义耗时');
        return null;
    }
}

/**
 * 按优先级对找到的项目排序
 */
function sortItemsByPriority(items: IndexItem[], isThisCall: boolean): IndexItem[] {
    return items.slice().sort((a, b) => {
        // 如果是this调用，优先Vue相关项
        if (isThisCall) {
            const aIsVue = ['method', 'computed', 'data', 'mixin-method', 'mixin-computed', 'mixin-data'].includes(a.type);
            const bIsVue = ['method', 'computed', 'data', 'mixin-method', 'mixin-computed', 'mixin-data'].includes(b.type);

            if (aIsVue && !bIsVue) return -1;
            if (!aIsVue && bIsVue) return 1;

            // Vue组件内部优先级: method > computed > data
            if (aIsVue && bIsVue) {
                const typeOrder: Record<string, number> = {
                    'method': 1,
                    'computed': 2,
                    'data': 3,
                    'mixin-method': 4,
                    'mixin-computed': 5,
                    'mixin-data': 6
                };
                return typeOrder[a.type] - typeOrder[b.type];
            }
        }

        // 普通调用，优先函数和方法
        const aIsFunc = ['function', 'method', 'mixin-method'].includes(a.type);
        const bIsFunc = ['function', 'method', 'mixin-method'].includes(b.type);

        if (aIsFunc && !bIsFunc) return -1;
        if (!aIsFunc && bIsFunc) return 1;

        return 0;
    });
}

/**
 * 高效解析文档，提取变量和方法 - 完全重写版
 * 直接利用缓存的索引，不再重复遍历AST
 */
export async function parseDocument(document: vscode.TextDocument): Promise<ParseResult | null> {
    const text = document.getText();
    const filename = document.fileName;
    console.time('[AST Parser] 解析文档耗时'); try {
        // 使用已经构建的索引，一次构建多次使用
        const index = buildASTIndex(text);

        // 初始化结果
        const variables: vscode.CompletionItem[] = [];
        const methods: vscode.CompletionItem[] = [];
        const thisReferences = new Map<string, vscode.CompletionItem>();

        // 从索引直接转换为补全项，不再重复遍历AST
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
        console.error(`[AST Parser] Error parsing ${filename}:`, error);
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
