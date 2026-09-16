/**
 * Vue3 setup `return { ... }` 块扫描（Inlay Hint 幽灵文本 + 快捷导出共用的纯文本分析）。
 *
 * 不依赖 Babel/索引缓存：
 * - 定位 `return { ... }` 块（花括号配平）与块内顶层 return 项；
 * - 声明注释：行尾注释优先（含多行声明的结尾行），其次紧邻上方的连续 // 注释块；
 * - 快捷导出：按声明顺序计算插入位置，插入行始终带逗号、必要时自动补齐上一行逗号，避免语法错误。
 */

export interface SetupReturnHint {
    /** return 项所在行（0-based） */
    line: number;
    /** 幽灵文本插入列（该行去尾部空白后的长度，即行尾） */
    character: number;
    /** 声明处注释文本 */
    doc: string;
}

/** `return { ... }` 块范围（0-based 行号） */
export interface SetupReturnBlock {
    /** `return {` 所在行 */
    start: number;
    /** 块结束行（闭合 `}` 所在行） */
    end: number;
}

/** return 项：shorthand（`name,`）或 `key: value` */
export interface SetupReturnItem {
    name: string;
    line: number;
}

export type SetupReturnExportPlan =
    | { kind: 'insert'; line: number; character: number; text: string; commaFixLine?: number }
    | { kind: 'exists'; line: number }
    | { kind: 'not-declared' }
    | { kind: 'no-return-block' };

const MAX_LEADING_COMMENT_LINES = 5;
const MAX_STATEMENT_LINES = 300;

/** 提取行内 `//` 注释（跳过字符串/模板串；与 parseDocument 的行尾注释语义一致）。 */
export function inlineCommentOf(line: string, startIndex = 0): string | undefined {
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let escaped = false;
    for (let i = 0; i < line.length - 1; i++) {
        const ch = line[i];
        const next = line[i + 1];
        if (escaped) { escaped = false; continue; }
        if (inSingle) { if (ch === '\\') { escaped = true; } else if (ch === '\'') { inSingle = false; } continue; }
        if (inDouble) { if (ch === '\\') { escaped = true; } else if (ch === '"') { inDouble = false; } continue; }
        if (inTemplate) { if (ch === '\\') { escaped = true; } else if (ch === '`') { inTemplate = false; } continue; }
        if (ch === '\'') { inSingle = true; continue; }
        if (ch === '"') { inDouble = true; continue; }
        if (ch === '`') { inTemplate = true; continue; }
        if (ch === '/' && next === '/' && i >= startIndex) {
            return line.slice(i + 2).trim() || undefined;
        }
    }
    return undefined;
}

/** 行首缩进宽度（用于区分嵌套函数内的同名局部声明）。 */
function indentOf(line: string): number {
    const match = /^[ \t]*/.exec(line);
    return match ? match[0].length : 0;
}

/** 花括号增量（块内为扁平列表，直接计数即可；注释行由调用方跳过）。 */
function braceDelta(line: string): number {
    let delta = 0;
    for (const ch of line) {
        if (ch === '{') { delta++; }
        else if (ch === '}') { delta--; }
    }
    return delta;
}

/** 定位文件中所有 `return { ... }` 块（纯注释行不参与配平）。 */
export function findSetupReturnBlocks(lines: string[]): SetupReturnBlock[] {
    const blocks: SetupReturnBlock[] = [];
    let line = 0;
    while (line < lines.length) {
        if (!/^\s*return\s*\{/.test(lines[line])) { line++; continue; }
        let depth = 0;
        let end = line;
        for (let i = line; i < lines.length; i++) {
            if (i !== line && /^\s*\/\//.test(lines[i])) { continue; }
            depth += braceDelta(lines[i]);
            if (depth <= 0) { end = i; break; }
        }
        blocks.push({ start: line, end });
        line = end + 1;
    }
    return blocks;
}

/** 收集块内的 return 项（shorthand 与 key: value 都识别，用于“已导出”判断与按声明顺序插入）。 */
export function collectSetupReturnItems(lines: string[], block: SetupReturnBlock): SetupReturnItem[] {
    const items: SetupReturnItem[] = [];
    let depth = braceDelta(lines[block.start]);
    for (let i = block.start + 1; i < block.end; i++) {
        const delta = braceDelta(lines[i]);
        if (depth === 1 && delta === 0) {
            const match = /^([A-Za-z_$][\w$]*)\s*(?::[^,]*)?,?$/.exec(lines[i].trim());
            if (match) { items.push({ name: match[1], line: i }); }
        }
        depth += delta;
    }
    return items;
}

/** 多行声明的结尾行：从声明行起做括号/花括号/中括号配平，返回闭合行（单行声明返回自身）。 */
function findStatementEndLine(lines: string[], startLine: number): number {
    let depth = 0;
    for (let i = startLine; i < lines.length && i - startLine <= MAX_STATEMENT_LINES; i++) {
        for (const ch of lines[i]) {
            if (ch === '{' || ch === '(' || ch === '[') { depth++; }
            else if (ch === '}' || ch === ')' || ch === ']') { depth--; }
        }
        if (depth <= 0) { return i; }
    }
    return startLine;
}

/**
 * 声明处注释：行尾注释优先（多行声明取结尾行，如 `}; // 说明`）；
 * 其次向上收集紧邻的连续 // 注释块（跳过 #region/#endregion 标记）。
 */
export function commentForDeclarationLine(lines: string[], lineIndex: number): string | undefined {
    const inline = inlineCommentOf(lines[lineIndex] || '');
    if (inline) { return inline; }
    const endLine = findStatementEndLine(lines, lineIndex);
    if (endLine > lineIndex) {
        const endInline = inlineCommentOf(lines[endLine] || '');
        if (endInline) { return endInline; }
    }
    const collected: string[] = [];
    for (let i = lineIndex - 1; i >= 0 && collected.length < MAX_LEADING_COMMENT_LINES; i--) {
        const match = /^\/\/(.*)$/.exec((lines[i] || '').trim());
        if (!match) { break; }
        const content = match[1].trim();
        if (!content || /^#?\s*(?:end)?region\b/i.test(content)) { break; }
        collected.unshift(content);
    }
    return collected.length ? collected.join(' ') : undefined;
}

/**
 * 定位声明行：只接受比参照点更外层（缩进更浅）的声明，避免被函数体内的同名局部变量抢先；
 * 同层取最接近的；从 fromLine 起向上查找，找不到再向下。
 */
export function findDeclarationLine(lines: string[], name: string, fromLine: number, referenceIndent?: number): number {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^\\s*(?:(?:const|let|var)\\s+${escaped}\\b|(?:async\\s+)?function\\s+${escaped}\\b)`);
    const limit = referenceIndent ?? indentOf(lines[fromLine] || '');
    let best = -1;
    let bestIndent = Number.MAX_SAFE_INTEGER;
    for (let i = Math.min(fromLine, lines.length - 1); i >= 0; i--) {
        if (!pattern.test(lines[i])) { continue; }
        const indent = indentOf(lines[i]);
        if (indent >= limit) { continue; }
        if (indent < bestIndent) { bestIndent = indent; best = i; }
    }
    if (best >= 0) { return best; }
    for (let i = fromLine + 1; i < lines.length; i++) {
        if (pattern.test(lines[i]) && indentOf(lines[i]) < limit) { return i; }
    }
    return -1;
}

/**
 * 扫描全部 `return { ... }` 块，为顶层单行 shorthand 项生成幽灵文本注释。
 * 仅返回“声明处存在注释”的项；return 项行内已有注释时不重复生成。
 */
export function scanSetupReturnHints(text: string): SetupReturnHint[] {
    const lines = text.split(/\r?\n/);
    const hints: SetupReturnHint[] = [];
    for (const block of findSetupReturnBlocks(lines)) {
        let depth = braceDelta(lines[block.start]);
        for (let i = block.start + 1; i < block.end; i++) {
            const delta = braceDelta(lines[i]);
            if (depth === 1 && delta === 0) {
                const match = /^([A-Za-z_$][\w$]*)\s*,?$/.exec(lines[i].trim());
                if (match && !inlineCommentOf(lines[i])) {
                    const declarationLine = findDeclarationLine(lines, match[1], i);
                    const doc = declarationLine >= 0 ? commentForDeclarationLine(lines, declarationLine) : undefined;
                    if (doc) {
                        hints.push({ line: i, character: lines[i].trimEnd().length, doc });
                    }
                }
            }
            depth += delta;
        }
    }
    return hints;
}

/**
 * 计算“导出到 setup return”的插入计划（纯函数）。
 * - 目标块取文件中最后一个 `return { ... }`（.dev.js 约定：setup 的 return 位于文件末尾）；
 * - 已导出 → exists；未找到声明 → not-declared；无 return 块 → no-return-block；
 * - 插入按声明顺序（与 return 项顺序约定一致），插入行始终以逗号结尾；
 *   插入点上一行缺逗号时通过 commaFixLine 补上，避免语法错误；
 * - 单行块（`return { a, b };`）退化为行内插入。
 */
export function planSetupReturnExport(text: string, symbolName: string, cursorLine: number, eol = '\n'): SetupReturnExportPlan {
    const lines = text.split(/\r?\n/);
    const blocks = findSetupReturnBlocks(lines);
    const block = blocks.length ? blocks[blocks.length - 1] : undefined;
    if (!block) { return { kind: 'no-return-block' }; }

    const items = collectSetupReturnItems(lines, block);
    const itemIndent = items.length ? indentOf(lines[items[0].line]) : indentOf(lines[block.start] || '') + 1;
    const declarationLine = findDeclarationLine(lines, symbolName, cursorLine, itemIndent);
    if (declarationLine < 0) { return { kind: 'not-declared' }; }

    const existing = items.find(item => item.name === symbolName);
    if (existing) { return { kind: 'exists', line: existing.line }; }

    // 单行 return 块：在 `return` 后的 `{` 之后行内插入（已有项时带逗号，空块不带）
    if (block.end === block.start) {
        const source = lines[block.start] || '';
        const returnIndex = source.indexOf('return');
        const braceIndex = returnIndex >= 0 ? source.indexOf('{', returnIndex) : -1;
        if (braceIndex < 0) { return { kind: 'no-return-block' }; }
        const closeIndex = source.indexOf('}', braceIndex + 1);
        const inner = closeIndex > braceIndex ? source.slice(braceIndex + 1, closeIndex) : '';
        if (new RegExp(`(?:^|[{,])\\s*${symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?=[,}])`).test(inner)) {
            return { kind: 'exists', line: block.start };
        }
        return { kind: 'insert', line: block.start, character: braceIndex + 1, text: inner.trim().length > 0 ? ` ${symbolName},` : ` ${symbolName} ` };
    }

    const indent = items.length
        ? /^[ \t]*/.exec(lines[items[0].line])?.[0] ?? '\t'
        : `${/^[ \t]*/.exec(lines[block.start] || '')?.[0] ?? ''}\t`;
    // 按声明顺序：插到最后一个“声明位于新符号之前”的项之后；无法定位时插到列表最前
    let insertLine = items.length ? items[0].line : block.start + 1;
    for (const item of items) {
        const itemDeclaration = findDeclarationLine(lines, item.name, item.line, itemIndent);
        if (itemDeclaration >= 0 && itemDeclaration < declarationLine) { insertLine = item.line + 1; }
    }
    // 上一行缺逗号时补一个（如最后一项写作 `lastItem` 无逗号的风格）
    let commaFixLine: number | undefined;
    let previous = insertLine - 1;
    while (previous > block.start) {
        const trimmed = (lines[previous] || '').trim();
        if (!trimmed || trimmed.startsWith('//')) { previous--; continue; }
        break;
    }
    if (previous > block.start) {
        const trimmed = (lines[previous] || '').trimEnd();
        if (trimmed && !trimmed.endsWith(',')) { commaFixLine = previous; }
    }
    return { kind: 'insert', line: insertLine, character: 0, text: `${indent}${symbolName},${eol}`, commaFixLine };
}
