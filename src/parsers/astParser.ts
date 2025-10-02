/**
 * @file astParser.ts
 * @description 轻量级、专注的AST解析器，用于从JS代码中查找Vue定义
 */
import * as vscode from 'vscode';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { ScriptSource } from '../finders/scriptFinder';
import { safeExecute, ErrorType } from '../errors/errorHandler';
import { astIndexCache } from '../cache/cacheManager';
import { performanceMonitor, monitor } from '../monitoring/performanceMonitor';

/**
 * 定义信息接口，包含名称、位置和类型
 */
interface DefinitionInfo {
    name: string;
    location: vscode.Location;
    type: 'data' | 'method';
}

export class AstParser {
    /**
     * 查找定义的主函数
     * @param scriptSource 脚本源对象
     * @param variableName 要查找的变量名
     */
    // 使用性能监控装饰器
    @monitor('findDefinitionInAst')
    public async findDefinition(
        scriptSource: ScriptSource,
        variableName: string
    ): Promise<vscode.Location | null> {
        
        const definitions = await this.parseScriptForDefinitions(scriptSource);
        if (!definitions) {
            return null;
        }

        // 查找完全匹配的定义
        const definition = definitions.find(def => def.name === variableName);

        return definition ? definition.location : null;
    }

    /**
     * 解析脚本以提取所有 data 和 methods 定义。
     * 利用缓存机制避免重复解析。
     * @param scriptSource 
     */
    private async parseScriptForDefinitions(scriptSource: ScriptSource): Promise<DefinitionInfo[] | null> {
        const cacheKey = scriptSource.content;
        const cachedDefinitions = astIndexCache.getIndex(cacheKey);

        if (cachedDefinitions) {
            performanceMonitor.recordCacheHit();
            return cachedDefinitions as DefinitionInfo[];
        }
        performanceMonitor.recordCacheMiss();
        
        return safeExecute(() => {
            const cleanContent = this.cleanupPhpAndOtherTemplates(scriptSource.content);
            const ast = parser.parse(cleanContent, {
                sourceType: 'module',
                plugins: ['jsx'], // 保持对JSX的支持
                errorRecovery: true, // 对混合代码容错至关重要
            });

            const definitions: DefinitionInfo[] = [];

            traverse(ast, {
                // new Vue({ data: ..., methods: ... })
                ObjectProperty: (path) => {
                    const key = path.node.key;
                    if (t.isIdentifier(key)) {
                        if (key.name === 'data') {
                            this.extractDataDefinitions(path.node.value, scriptSource, definitions);
                        } else if (key.name === 'methods') {
                            this.extractMethodsDefinitions(path.node.value, scriptSource, definitions);
                        }
                    }
                },
                // export default { data(){...}, methods:{...} }
                ObjectMethod: (path) => {
                    const key = path.node.key;
                    if(t.isIdentifier(key) && key.name === 'data') {
                        traverse(path.node.body, {
                            ReturnStatement: (returnPath) => {
                                this.extractDataDefinitions(returnPath.node.argument, scriptSource, definitions);
                                returnPath.stop(); // 找到即停
                            }
                        }, path.scope, path);
                    }
                }
            });

            astIndexCache.setIndex(cacheKey, definitions);
            console.log(`[parser] AST解析完成, 找到 ${definitions.length} 个定义。`);
            return definitions;

        }, ErrorType.PARSE_ERROR, { file: scriptSource.uri.fsPath });
    }

    /**
     * 从 data 属性节点中提取所有变量定义
     */
    private extractDataDefinitions(dataNode: t.Node | null | undefined, scriptSource: ScriptSource, definitions: DefinitionInfo[]) {
        let objectToParse: t.Node | null | undefined = dataNode;

        // 处理 data: function() { return { ... } } 或 data: () => ({...})
        if (t.isFunctionExpression(dataNode) || t.isArrowFunctionExpression(dataNode)) {
             if(t.isBlockStatement(dataNode.body)) {
                let returnStatementFound = false;
                traverse(dataNode.body, {
                    ReturnStatement: (path) => {
                        objectToParse = path.node.argument;
                        returnStatementFound = true;
                        path.stop();
                    }
                });
        if(!returnStatementFound) { objectToParse = null; }
             } else if (t.isObjectExpression(dataNode.body)) { // 箭头函数简写
                 objectToParse = dataNode.body;
             }
        }
        
    if (!objectToParse || !t.isObjectExpression(objectToParse)) { return; }

        objectToParse.properties.forEach(prop => {
            if (t.isObjectProperty(prop) && t.isIdentifier(prop.key) && prop.loc) {
                const location = new vscode.Location(
                    scriptSource.uri,
                    new vscode.Position(
                        scriptSource.startLine + prop.loc.start.line - 1, // 加上内联脚本的起始行
                        prop.loc.start.column
                    )
                );
                definitions.push({ name: prop.key.name, location, type: 'data' });
            }
        });
    }

    /**
     * 从 methods 属性节点中提取所有方法定义
     */
    private extractMethodsDefinitions(methodsNode: t.Node | null | undefined, scriptSource: ScriptSource, definitions: DefinitionInfo[]) {
    if (!methodsNode || !t.isObjectExpression(methodsNode)) { return; }

        methodsNode.properties.forEach(prop => {
            // 支持 { myMethod() {} } 和 { myMethod: function() {} }
            if ((t.isObjectMethod(prop) || t.isObjectProperty(prop)) && t.isIdentifier(prop.key) && prop.loc) {
                 const location = new vscode.Location(
                    scriptSource.uri,
                    new vscode.Position(
                        scriptSource.startLine + prop.loc.start.line - 1, // 加上内联脚本的起始行
                        prop.loc.start.column
                    )
                );
                definitions.push({ name: prop.key.name, location, type: 'method' });
            }
        });
    }

    /**
     * 清理JS代码中的PHP和Layui模板标记
     */
    private cleanupPhpAndOtherTemplates(content: string): string {
        return content
            // 移除 <?php ... ?> 和 <?= ... ?>
            .replace(/<\?(=|php)?([\s\S]*?)\?>/g, (match) => ' '.repeat(match.length))
            // 移除 Layui 的 {{ ... }} 风格模板
            .replace(/\{\{([\s\S]*?)\}\}/g, (match) => `''/*${' '.repeat(match.length-5)}*/`);
    }
}

/**
 * 简化版 parseAST 函数 (兼容旧代码引用)
 * 返回首次匹配到标识符的大致行列位置（零基）
 */
export async function parseAST(scriptContent: string, searchWord: string, _isThisCall: boolean): Promise<{ line: number; column: number } | null> {
    try {
    if (!searchWord) { return null; }
        const escaped = searchWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, 'g');
        const match = regex.exec(scriptContent);
    if (!match) { return null; }
        const index = match.index;
        const pre = scriptContent.slice(0, index);
        const lines = pre.split(/\r?\n/);
        const line = lines.length - 1;
        const column = lines[lines.length - 1].length;
        return { line, column };
    } catch (e) {
        console.error('[parseAST] Error:', e);
        return null;
    }
}
