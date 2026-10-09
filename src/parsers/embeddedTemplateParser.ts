import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { tokenizer } from 'acorn';
import type * as vscode from 'vscode';

export interface OffsetRange { start: number; end: number }
export interface EmbeddedTemplate extends OffsetRange {
    language: 'html' | 'css';
    content: string;
    holes: OffsetRange[];
    closed: boolean;
    declarations: boolean;
}

const cache = new WeakMap<vscode.TextDocument, { version: number; regions: EmbeddedTemplate[] }>();
const scriptLanguages = new Set(['javascript', 'typescript', 'javascriptreact', 'typescriptreact']);
export const MAX_EMBEDDED_DOCUMENT_LENGTH = 600 * 1024;

export function isEmbeddedScript(document: vscode.TextDocument): boolean {
    return scriptLanguages.has(document.languageId);
}

export function clearEmbeddedTemplateCache(document: vscode.TextDocument): void {
    cache.delete(document);
}

export function getEmbeddedTemplates(document: vscode.TextDocument): EmbeddedTemplate[] {
    if (!isEmbeddedScript(document)) { return []; }
    const hit = cache.get(document);
    if (hit?.version === document.version) { return hit.regions; }
    const regions = parseEmbeddedTemplates(document.getText(), document.languageId);
    cache.set(document, { version: document.version, regions });
    return regions;
}

export function getEmbeddedTemplateAtPosition(document: vscode.TextDocument, position: vscode.Position): EmbeddedTemplate | undefined {
    const offset = document.offsetAt(position);
    return getEmbeddedTemplates(document).find(region => offset >= region.start && offset <= region.end
        && !region.holes.some(hole => offset >= hole.start && offset < hole.end));
}

// 等长占位保留 CRLF 和 UTF-16 偏移，补全编辑绝不能覆盖插值内的 JS。
export function maskTemplateHoles(content: string, start: number, holes: OffsetRange[]): string {
    let result = '';
    let cursor = 0;
    for (const hole of holes) {
        const from = hole.start - start;
        const to = hole.end - start;
        result += content.slice(cursor, from) + content.slice(from, to).replace(/[^\r\n]/g, 'x');
        cursor = to;
    }
    return result + content.slice(cursor);
}

export function parseEmbeddedTemplates(text: string, languageId = 'javascript'): EmbeddedTemplate[] {
    if (text.length > MAX_EMBEDDED_DOCUMENT_LENGTH || !text.includes('`')) { return []; }
    const regions: EmbeddedTemplate[] = [];
    const add = (start: number, end: number, holes: OffsetRange[], closed: boolean): void => {
        const content = text.slice(start, end);
        const masked = maskTemplateHoles(content, start, holes);
        const kind = classifyTemplate(masked, text.slice(Math.max(0, start - 160), start - 1));
        if (kind) { regions.push({ start, end, content, holes, closed, ...kind }); }
    };
    try {
        // AST 负责准确排除注释、正则、普通字符串及 JSX 文本中的伪反引号。
        const ast = parse(text, {
            sourceType: 'unambiguous', errorRecovery: true,
            plugins: languageId === 'typescript' ? ['typescript'] : ['typescript', 'jsx']
        });
        traverse(ast, {
            TemplateLiteral(path) {
                const node = path.node;
                const holes = node.quasis.slice(0, -1).map((quasi, i) => ({
                    start: quasi.end!, end: node.quasis[i + 1].start!
                }));
                add(node.start! + 1, node.end! - 1, holes, true);
            }
        });
    } catch {
        regions.length = 0;
        // 编辑中的未闭合模板无法构建 AST；词法回退仍能跳过注释、字符串和正则。
        scanIncompleteTemplates(text, add);
    }
    // 内层模板优先，外层 ${...} 的排除范围不影响其内部独立的模板。
    return regions.sort((a, b) => b.start - a.start);
}

function classifyTemplate(content: string, prefix: string): Pick<EmbeddedTemplate, 'language' | 'declarations'> | undefined {
    const sample = content.replace(/^\s*(?:(?:\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->)\s*)*/, '').trimStart();
    if (/^<(?:[a-zA-Z][\w:-]*|\/|!|\?)/.test(sample) || sample === '<'
        || /<([a-zA-Z][\w:-]*)\b[^>]*>[\s\S]*<\/\1\s*>/.test(sample)) {
        return { language: 'html', declarations: false };
    }
    if (/^(?:[^<`{};]+\{)/.test(sample) && !/^\s*\$\{/.test(sample)
        || /^@(?:import|charset|namespace|layer)\b/.test(sample)) {
        // 选择器可以是标签、属性、多行选择器或 @ 规则，不限定变量命名。
        if (/^(?:[.#*:\[]|[a-zA-Z_-][\w-]*(?:\s|[.#:[>+~,{])|@)/.test(sample)) {
            return { language: 'css', declarations: false };
        }
    }
    // 无内容/输入尚不完整时，保留明确的语言标注和原有 Vue 属性语义。
    if (/\/\*\s*html\s*\*\/\s*$/i.test(prefix) || /(?:\bhtml|\btemplate\s*:)\s*$/.test(prefix)) {
        return { language: 'html', declarations: false };
    }
    if (/\/\*\s*css\s*\*\/\s*$/i.test(prefix) || /\bcss\s*$/.test(prefix)) {
        return { language: 'css', declarations: false };
    }
    if (/\bcssText\s*=\s*$/.test(prefix)) { return { language: 'css', declarations: true }; }
    return undefined;
}

function scanIncompleteTemplates(text: string, add: (start: number, end: number, holes: OffsetRange[], closed: boolean) => void): void {
    const stack: Array<{ start: number; holes: OffsetRange[]; expression?: number; depth: number }> = [];
    const scanner = tokenizer(text, { ecmaVersion: 'latest', sourceType: 'module' });
    try {
        while (true) {
            const token = scanner.getToken();
            const label = token.type.label;
            const frame = stack[stack.length - 1];
            if (label === 'eof') { break; }
            if (label === '`') {
                if (frame && frame.expression === undefined) {
                    add(frame.start, token.start, frame.holes, true);
                    stack.pop();
                } else {
                    stack.push({ start: token.end, holes: [], depth: 0 });
                }
            } else if (frame && label === '${') {
                frame.expression = token.start;
                frame.depth = 0;
            } else if (frame?.expression !== undefined) {
                if (label === '{') { frame.depth++; }
                if (label === '}') {
                    if (frame.depth > 0) { frame.depth--; }
                    else {
                        frame.holes.push({ start: frame.expression, end: token.end });
                        frame.expression = undefined;
                    }
                }
            }
        }
    } catch { /* 未闭合字符串/模板停在文件尾，不跨过未知边界继续猜测。 */ }
    for (const frame of stack) {
        if (frame.expression !== undefined) { frame.holes.push({ start: frame.expression, end: text.length }); }
        add(frame.start, text.length, frame.holes, false);
    }
}
