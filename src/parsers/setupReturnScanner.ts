/**
 * Vue3 setup `return { ... }` 块注释扫描（Inlay Hint 幽灵文本数据源）。
 *
 * 纯文本扫描、不依赖 Babel/索引缓存，保证索引未构建时幽灵文本依然可用：
 * - 定位 `return { ... }` 块（花括号配平，仅收集顶层单行 shorthand 项，如 `subCount,`）；
 * - 按最接近的 `const/let/var` 或 `function` 声明找注释：行尾注释优先，其次紧邻上方的连续 // 注释块。
 */

export interface SetupReturnHint {
    /** return 项所在行（0-based） */
    line: number;
    /** 幽灵文本插入列（该行去尾部空白后的长度，即行尾） */
    character: number;
    /** 声明处注释文本 */
    doc: string;
}

const MAX_LEADING_COMMENT_LINES = 5;

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

/** 声明处注释：行尾注释优先；无行尾注释时向上收集紧邻的连续 // 注释块（跳过 #region/#endregion 标记）。 */
export function commentForDeclarationLine(lines: string[], lineIndex: number): string | undefined {
    const inline = inlineCommentOf(lines[lineIndex] || '');
    if (inline) { return inline; }
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

/** 行首缩进宽度（用于区分嵌套函数内的同名局部声明）。 */
function indentOf(line: string): number {
    const match = /^[ \t]*/.exec(line);
    return match ? match[0].length : 0;
}

/**
 * 定位声明行：只接受比 return 项更外层（缩进更浅）的声明，避免被函数体内的同名局部变量抢先；
 * 同层取最接近的，优先向上查找、找不到再向下。
 */
function findDeclarationLine(lines: string[], name: string, itemLine: number): number {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^\\s*(?:(?:const|let|var)\\s+${escaped}\\b|(?:async\\s+)?function\\s+${escaped}\\b)`);
    const itemIndent = indentOf(lines[itemLine]);
    let best = -1;
    let bestIndent = Number.MAX_SAFE_INTEGER;
    for (let i = itemLine - 1; i >= 0; i--) {
        if (!pattern.test(lines[i])) { continue; }
        const indent = indentOf(lines[i]);
        if (indent >= itemIndent) { continue; }
        if (indent < bestIndent) { bestIndent = indent; best = i; }
    }
    if (best >= 0) { return best; }
    for (let i = itemLine + 1; i < lines.length; i++) {
        if (pattern.test(lines[i]) && indentOf(lines[i]) < itemIndent) { return i; }
    }
    return -1;
}

/** 花括号增量（return 块为扁平标识符列表，直接计数即可；注释行由调用方跳过）。 */
function braceDelta(line: string): number {
    let delta = 0;
    for (const ch of line) {
        if (ch === '{') { delta++; }
        else if (ch === '}') { delta--; }
    }
    return delta;
}

/**
 * 扫描全部 `return { ... }` 块，为顶层单行 shorthand 项生成幽灵文本注释。
 * 仅返回“声明处存在注释”的项；return 项行内已有注释时不重复生成。
 */
export function scanSetupReturnHints(text: string): SetupReturnHint[] {
    const lines = text.split(/\r?\n/);
    const hints: SetupReturnHint[] = [];
    let line = 0;
    while (line < lines.length) {
        if (!/^\s*return\s*\{/.test(lines[line])) { line++; continue; }
        // 花括号配平求块尾（纯注释行不参与配平）
        let depth = 0;
        let end = line;
        for (let i = line; i < lines.length; i++) {
            if (i !== line && /^\s*\/\//.test(lines[i])) { continue; }
            depth += braceDelta(lines[i]);
            if (depth <= 0) { end = i; break; }
        }
        // 仅收集 depth 恰为 1 的顶层单行 shorthand 项
        depth = braceDelta(lines[line]);
        for (let i = line + 1; i < end; i++) {
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
        line = end + 1;
    }
    return hints;
}
