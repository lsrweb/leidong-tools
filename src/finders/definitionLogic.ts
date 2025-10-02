/**
 * 新版定义查找逻辑
 * 需求点：
 * 1. 优先匹配 同目录 js/ 同名 .dev.js (允许递归 js 子目录)
 * 2. 否则解析 HTML 内联 <script> new Vue({...})
 * 3. 支持 mixins / this.xxx / that.xxx / 普通标识符
 * 4. 允许 HTML 模板 {{ var }} 与属性里 v-bind / : / @ / v-on 及纯文本中的变量
 * 5. 性能：内容 hash + 缓存；只在调用时解析
 */
import * as vscode from 'vscode';
import { monitor } from '../monitoring/performanceMonitor';
import { resolveVueIndexForHtml, getOrCreateVueIndexFromContent, findDefinitionInIndex, findChainedRootDefinition } from '../parsers/parseDocument';
import { findTemplateVar, getTemplateIndex } from './templateIndexer';
import * as path from 'path';

interface DocIndexCache { version: number; hash: string; }
const jsDocIndexCache = new Map<string, DocIndexCache>();

const HTML_ATTR_BLACKLIST = new Set([
    'class','id','style','src','href','alt','title','width','height','type','value','name','placeholder','rel','for','aria-label'
]);

export class DefinitionLogic {
    @monitor('provideDefinition')
    public async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location | null> {
        try {
            const rawWordInfo = this.extractWord(document, position);
            if (!rawWordInfo) { return null; }
            const { word, contextType, fullChain } = rawWordInfo;
            if (!word) { return null; }

            // JS / TS 文件：直接解析自身
            if (document.languageId === 'javascript' || document.languageId === 'typescript') {
                const content = document.getText();
                const index = getOrCreateVueIndexFromContent(content, document.uri, 0);
                console.log(`[jump][js] word=${word} chain=${fullChain || ''}`);
                let target = findDefinitionInIndex(word, index);
                if (!target && fullChain) { target = findChainedRootDefinition(fullChain, index); }
                if (target) { console.log(`[jump][js][hit] ${word} -> ${target.uri.fsPath}:${target.range.start.line + 1}`); return target; }
                console.log(`[jump][js][miss] ${word}`);
                return null;
            }

            // HTML 文件：尝试外部 js/***.dev.js 或内联脚本
            if (document.languageId === 'html') {
                const index = resolveVueIndexForHtml(document);
                if (!index) { return null; }
                // 先尝试模板局部变量 (包括 v-for / slot-scope) root token
                const templateHit = findTemplateVar(document, position, word);
                if (templateHit) { if (this.shouldLog()) { console.log(`[jump][html][template-hit] ${word} -> ${templateHit.uri.fsPath}:${templateHit.range.start.line + 1}`); } return templateHit; }
                console.log(`[jump][html] word=${word} chain=${fullChain || ''}`);
                let target = findDefinitionInIndex(word, index);
                if (!target && fullChain) { target = findChainedRootDefinition(fullChain, index); }
                if (target) { console.log(`[jump][html][hit] ${word} -> ${target.uri.fsPath}:${target.range.start.line + 1}`); return target; }
                console.log(`[jump][html][miss] ${word}`);
            }
            return null;
        } catch (e) {
            console.error('[jump][fatal]', e);
            return null;
        }
    }

    /** 提取光标下的词 + 上下文类型 */
    private extractWord(document: vscode.TextDocument, position: vscode.Position): { word: string; contextType: 'this' | 'that' | 'plain' | 'alias'; fullChain?: string } | null {
        const lineText = document.lineAt(position.line).text;
        const beforeCursor = lineText.substring(0, position.character);

        // 1. 捕获任意链式访问 (含 this/that/别名) 如 vm.child_type_index / this.a.b / ctx.foo
        const chainMatch = /([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)$/.exec(beforeCursor);
        if (chainMatch) {
            const full = chainMatch[1];
            const parts = full.split('.');
            if (parts.length >= 2) {
                const root = parts[0];
                const prop = parts[parts.length - 1];
                if (root === 'this' || root === 'that') {
                    return { word: prop, contextType: root === 'this' ? 'this' : 'that', fullChain: full };
                }
                // 检测是否为 this 的别名 (在当前文件中 root = this 的赋值)
                if (this.isThisAlias(document, position, root)) {
                    return { word: prop, contextType: 'alias', fullChain: full };
                }
            }
        }

        // 2. 单词匹配 (普通场景)
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_$][\w$]*/);
        if (!wordRange) { return null; }
        const w = document.getText(wordRange);

        if (document.languageId === 'html') {
            const attrNameMatch = /([a-zA-Z0-9_-]+)\s*=/.exec(lineText);
            if (attrNameMatch && attrNameMatch[1] === w && HTML_ATTR_BLACKLIST.has(w)) {
                return null;
            }
        }
        return { word: w, contextType: 'plain', fullChain: w };
    }

    // 判断某标识符是否在当前位置之前被赋值为 this (别名)
    private isThisAlias(document: vscode.TextDocument, position: vscode.Position, alias: string): boolean {
        const maxScan = 400;
        const startLine = Math.max(0, position.line - maxScan);
        const aliasPattern = new RegExp(`\\b(?:const|let|var)?\\s*${alias}\\s*=\\s*this\\b`);
        for (let line = position.line; line >= startLine; line--) {
            const text = document.lineAt(line).text;
            if (aliasPattern.test(text)) { return true; }
        }
        return false;
    }

    private shouldLog(): boolean {
        try { return vscode.workspace.getConfiguration('leidong-tools').get<boolean>('indexLogging', true) === true; } catch { return true; }
    }
}
