/**
 * @file resilientParse.ts
 * @description 容错式 Babel 解析器
 *
 * @babel/parser 的 errorRecovery 选项只处理 **parser 级别** 的结构错误，
 * 不处理 **tokenizer 级别** 的致命错误（如未终止的字符串、正则、模板字面量等）。
 *
 * 本模块通过迭代修复策略处理 tokenizer 级别错误：
 * 1. 首次尝试：正常解析（errorRecovery: true）
 * 2. 若因 tokenizer 错误失败：mask 错误所在行 → 重试（最多 N 次）
 * 3. 所有重试均失败后抛出最后一个错误
 *
 * 这样即使部分行不可解析，其余代码仍能产出有效 AST。
 */
import * as parser from '@babel/parser';
import type { ParserOptions } from '@babel/parser';
import type { File } from '@babel/types';

/** 最大修复重试次数（每次修复一行） */
const MAX_FIX_RETRIES = 15;

/**
 * 容错式 Babel 解析
 *
 * 用法与 parser.parse() 相同，但遇到 tokenizer 级别错误时
 * 会自动 mask 出错行并重试。
 *
 * @param content  待解析的 JS/TS 源码
 * @param options  传递给 @babel/parser 的选项（errorRecovery 会被强制打开）
 * @returns        解析后的 AST（File 节点）
 */
export function resilientParse(
    content: string,
    options?: Partial<ParserOptions>
): File {
    const parseOptions: ParserOptions = {
        sourceType: 'module',
        plugins: [
            'jsx', 
            'typescript', 
            'decorators-legacy', 
            'classProperties', 
            'classPrivateProperties', 
            'classPrivateMethods',
            'topLevelAwait',
            'asyncGenerators',
            'dynamicImport',
            'objectRestSpread'
        ],
        ...options,
        errorRecovery: true, // 始终开启
    };

    let currentContent = content;
    const maskedLines = new Set<number>();

    for (let attempt = 0; attempt <= MAX_FIX_RETRIES; attempt++) {
        try {
            return parser.parse(currentContent, parseOptions);
        } catch (error: any) {
            const lineNum = extractErrorLine(error);

            // 无法定位 or 该行已 mask 过 → 无法继续修复
            if (lineNum === null || maskedLines.has(lineNum)) {
                throw error;
            }

            maskedLines.add(lineNum);

            // 仅前几次打印日志，避免刷屏
            if (maskedLines.size <= 5) {
                const snippet = (error.message || '').substring(0, 80);
                console.log(`[resilientParse] 修复第 ${lineNum} 行 (attempt ${attempt + 1}): ${snippet}`);
            }

            currentContent = maskLineInContent(currentContent, lineNum);
        }
    }

    // fallback：不应到达此处（循环内最后一次迭代会 throw）
    throw new Error(`[resilientParse] 超过最大修复次数 (${MAX_FIX_RETRIES})`);
}

// ─── helpers ───────────────────────────────────────────────

/**
 * 从 babel SyntaxError 中提取出错行号（1-based）
 */
function extractErrorLine(error: any): number | null {
    // babel 错误通常挂 .loc.line
    if (error?.loc?.line && typeof error.loc.line === 'number') {
        return error.loc.line;
    }
    // 降级：从 message 里匹配 "(line:column)"
    const match = error?.message?.match(/\((\d+):\d+\)/);
    return match ? parseInt(match[1], 10) : null;
}

/**
 * 将指定行（1-based）替换为等长空格，保留换行符以维持行号对应关系
 */
function maskLineInContent(content: string, line: number): string {
    const lines = content.split('\n');
    const idx = line - 1;
    if (idx >= 0 && idx < lines.length) {
        lines[idx] = ' '.repeat(lines[idx].length);
    }
    return lines.join('\n');
}
