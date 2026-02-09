/**
 * 模板字符串 / HTML 内嵌字符串检测器
 * 
 * 检测 JS 文件中模板字面量内的 HTML 内容，包括：
 * - template: `<div>...</div>`        (Vue 组件模板)
 * - var html = `<div>...</div>`       (普通变量赋值)
 * - var dom = '<div>...</div>'        (单引号字符串)
 * 
 * 当光标处于包含 HTML 的字符串内时，提供 Vue 模板上下文支持
 */
import * as vscode from 'vscode';

/**
 * 模板字符串信息
 */
export interface TemplateLiteralInfo {
    /** 模板字符串的 HTML 内容 */
    content: string;
    /** 模板字符串在文档中的起始行 */
    startLine: number;
    /** 模板字符串在文档中起始行的字符偏移 */
    startCharacter: number;
    /** 模板字符串在文档中的结束行 */
    endLine: number;
    /** 模板字符串在文档中的完整范围 */
    range: vscode.Range;
    /** 匹配到的模式类型 */
    kind: 'template-property' | 'backtick-html' | 'string-html';
}

// 将所有需要匹配的模式集中管理
const BACKTICK_PATTERNS: Array<{ regex: RegExp; kind: TemplateLiteralInfo['kind'] }> = [
    // template: `...`
    { regex: /template\s*:\s*`/g, kind: 'template-property' },
    // var/let/const xxx = `...<tag...`
    { regex: /(?:var|let|const)\s+\w+\s*=\s*`/g, kind: 'backtick-html' },
    // xxx = `...`  (赋值)
    { regex: /\w+\s*=\s*`/g, kind: 'backtick-html' },
];

/**
 * 检测光标是否位于包含 HTML 的模板字符串 / 字符串内
 * 
 * 支持的模式：
 * 1. template: `<div>...</div>`         (Vue 组件)
 * 2. var html = `<div>...</div>`        (模板字面量)
 * 3. var html = '<div>...</div>'        (普通字符串)
 * 
 * @returns 如果光标在模板字符串内且包含 HTML 标签则返回信息，否则返回 null
 */
export function getTemplateLiteralAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
): TemplateLiteralInfo | null {
    const text = document.getText();
    const offset = document.offsetAt(position);

    // 1. 检测反引号模板字符串
    for (const { regex, kind } of BACKTICK_PATTERNS) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(text)) !== null) {
            const backtickStart = match.index + match[0].length - 1;
            const backtickEnd = findMatchingBacktick(text, backtickStart);
            if (backtickEnd < 0) { continue; }

            const contentStart = backtickStart + 1;
            const contentEnd = backtickEnd;

            if (offset >= contentStart && offset <= contentEnd) {
                const content = text.substring(contentStart, contentEnd);

                // 对于非 template: 模式，验证内容是否包含 HTML
                if (kind !== 'template-property' && !containsHtmlTags(content)) {
                    continue;
                }

                const startPos = document.positionAt(contentStart);
                const endPos = document.positionAt(contentEnd);

                return {
                    content,
                    startLine: startPos.line,
                    startCharacter: startPos.character,
                    endLine: endPos.line,
                    range: new vscode.Range(startPos, endPos),
                    kind
                };
            }
        }
    }

    // 2. 检测单/双引号字符串（如 var html = '<div>...</div>';）
    const stringResult = checkQuotedStringAtOffset(text, offset, document);
    if (stringResult) {
        return stringResult;
    }

    return null;
}

/**
 * 找到匹配的结束反引号位置
 */
function findMatchingBacktick(text: string, backtickStart: number): number {
    let i = backtickStart + 1;
    let exprDepth = 0;

    while (i < text.length) {
        const ch = text[i];

        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === '$' && i + 1 < text.length && text[i + 1] === '{') {
            exprDepth++;
            i += 2;
            continue;
        }
        if (ch === '}' && exprDepth > 0) {
            exprDepth--;
            i++;
            continue;
        }
        if (ch === '`' && exprDepth === 0) {
            return i;
        }
        i++;
    }
    return -1;
}

/**
 * 检测光标是否在包含 HTML 的引号字符串内
 */
function checkQuotedStringAtOffset(
    text: string,
    offset: number,
    document: vscode.TextDocument
): TemplateLiteralInfo | null {
    // 向前找到行首
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const lineEnd = text.indexOf('\n', offset);
    const line = text.substring(lineStart, lineEnd > 0 ? lineEnd : text.length);
    const offsetInLine = offset - lineStart;

    // 匹配 var/let/const xxx = '...' 或 "..."
    const assignRegex = /(?:var|let|const)\s+\w+\s*=\s*(['"])/g;
    let m: RegExpExecArray | null;

    while ((m = assignRegex.exec(line)) !== null) {
        const quote = m[1];
        const strStart = m.index + m[0].length;

        // 找到匹配的结束引号
        let strEnd = -1;
        for (let i = strStart; i < line.length; i++) {
            if (line[i] === '\\') { i++; continue; }
            if (line[i] === quote) { strEnd = i; break; }
        }
        if (strEnd < 0) { continue; }

        if (offsetInLine >= strStart && offsetInLine <= strEnd) {
            const content = line.substring(strStart, strEnd);
            if (!containsHtmlTags(content)) { continue; }

            const absStart = lineStart + strStart;
            const absEnd = lineStart + strEnd;
            const startPos = document.positionAt(absStart);
            const endPos = document.positionAt(absEnd);

            return {
                content,
                startLine: startPos.line,
                startCharacter: startPos.character,
                endLine: endPos.line,
                range: new vscode.Range(startPos, endPos),
                kind: 'string-html'
            };
        }
    }

    return null;
}

/**
 * 快速检测字符串是否包含 HTML 标签
 */
function containsHtmlTags(str: string): boolean {
    return /<[a-zA-Z][a-zA-Z0-9-]*[\s>\/]/.test(str);
}

/**
 * 检测 JS 文件是否包含 template: `...` 模板字符串
 */
export function hasTemplateLiteral(document: vscode.TextDocument): boolean {
    const text = document.getText();
    return /template\s*:\s*`/.test(text);
}

/**
 * 检测 JS 文件是否包含 Vue 组件选项对象（含 template 属性）
 */
export function hasVueComponentOptions(document: vscode.TextDocument): boolean {
    const text = document.getText();
    return /template\s*:\s*[`'"]/.test(text) &&
        (/\bdata\s*[\(:]/.test(text) || /\bmethods\s*:/.test(text) || /\bcomputed\s*:/.test(text));
}

/**
 * 判断光标在模板字符串中是否处于 Vue 模板上下文
 * （即在 HTML 属性绑定、插值表达式或事件处理中）
 */
export function isVueTemplateContext(linePrefix: string): boolean {
    // {{ 插值表达式
    if (/\{\{[^}]*$/.test(linePrefix)) { return true; }

    // 检查是否在 HTML 标签内
    const inTag = linePrefix.lastIndexOf('<') > linePrefix.lastIndexOf('>');
    if (!inTag) { return false; }

    // Vue 指令上下文
    return /(v-bind:|:|v-on:|@|v-if|v-else-if|v-show|v-model|v-for|v-slot|slot-scope)\S*\s*=\s*["'][^"']*$/.test(linePrefix);
}
