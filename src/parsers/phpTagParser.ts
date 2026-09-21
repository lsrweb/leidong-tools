export interface PhpTag {
    start: number;
    end: number;
    openMarkerStart: number;
    openMarkerEnd: number;
    codeStart: number;
    codeEnd: number;
    closeMarkerStart: number;
}

export interface PhpToken {
    text: string;
    offset: number;
    line: number;
}

export interface PhpAltSyntaxPair {
    kind: string;
    open: PhpToken;
    close: PhpToken;
}

export interface PhpFoldingRange {
    start: number;
    end: number;
}

export interface PhpTagDocumentInfo {
    tags: PhpTag[];
    bracketPairs: Map<number, number>;
    altPairs: PhpAltSyntaxPair[];
    foldingRanges: PhpFoldingRange[];
}

const OPEN_BRACKETS = new Map<string, string>([
    ['(', ')'],
    ['[', ']'],
    ['{', '}']
]);

const CLOSE_BRACKETS = new Map<string, string>([
    [')', '('],
    [']', '['],
    ['}', '{']
]);

const ALT_OPENERS = new Set(['if', 'while', 'for', 'foreach', 'switch', 'declare']);
const ALT_CONTINUATIONS = new Set(['else', 'elseif', 'case', 'default']);
const ALT_CLOSER_KIND = new Map<string, string>([
    ['endif', 'if'],
    ['endwhile', 'while'],
    ['endfor', 'for'],
    ['endforeach', 'foreach'],
    ['endswitch', 'switch'],
    ['enddeclare', 'declare']
]);
const PHP_KEYWORDS = new Set<string>([
    ...ALT_OPENERS,
    ...ALT_CONTINUATIONS,
    ...ALT_CLOSER_KIND.keys()
]);

export function buildPhpLineOffsets(text: string): number[] {
    const lineOffsets = [0];

    for (let index = 0; index < text.length; index++) {
        if (text[index] === '\n') {
            lineOffsets.push(index + 1);
        }
    }

    return lineOffsets;
}

export function getPhpLineAtOffset(lineOffsets: number[], offset: number): number {
    let low = 0;
    let high = lineOffsets.length - 1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const lineOffset = lineOffsets[mid];
        const nextLineOffset = mid + 1 < lineOffsets.length ? lineOffsets[mid + 1] : Number.MAX_SAFE_INTEGER;

        if (offset < lineOffset) {
            high = mid - 1;
            continue;
        }

        if (offset >= nextLineOffset) {
            low = mid + 1;
            continue;
        }

        return mid;
    }

    return 0;
}

function isPhpIdentifierChar(char: string | undefined): boolean {
    return Boolean(char) && /[A-Za-z0-9_]/.test(char as string);
}

function isPhpIdentifierStartChar(char: string | undefined): boolean {
    return Boolean(char) && /[A-Za-z_]/.test(char as string);
}

function skipPhpString(text: string, start: number, to: number): number {
    const quote = text[start];
    let index = start + 1;

    while (index < to) {
        const char = text[index];
        if (char === '\\') {
            index += 2;
            continue;
        }
        if (char === quote) {
            return index + 1;
        }
        index++;
    }

    return to;
}

// PHP 语义：行注释内的 ?> 同样会终止 PHP 模式，因此扫描时不能跳过 ?>
function skipPhpLineComment(text: string, from: number, to: number): number {
    let index = from;

    while (index < to) {
        const char = text[index];
        if (char === '\n') {
            return index + 1;
        }
        if (char === '?' && text[index + 1] === '>') {
            return index;
        }
        index++;
    }

    return to;
}

function skipPhpBlockComment(text: string, from: number, to: number): number {
    let index = from;

    while (index < to) {
        const char = text[index];
        if (char === '?' && text[index + 1] === '>') {
            return index;
        }
        if (char === '*' && text[index + 1] === '/') {
            return index + 2;
        }
        index++;
    }

    return to;
}

function trySkipPhpHeredoc(text: string, start: number, to: number): number {
    let index = start + 3;

    while (index < to && (text[index] === ' ' || text[index] === '\t')) {
        index++;
    }

    let quote = '';
    if (text[index] === '\'' || text[index] === '"') {
        quote = text[index];
        index++;
    }

    const labelStart = index;
    if (!isPhpIdentifierStartChar(text[index])) {
        return -1;
    }
    while (index < to && isPhpIdentifierChar(text[index])) {
        index++;
    }
    const label = text.slice(labelStart, index);

    if (quote) {
        if (text[index] !== quote) {
            return -1;
        }
        index++;
    }

    while (index < to && (text[index] === ' ' || text[index] === '\t')) {
        index++;
    }
    if (text[index] === '\r') {
        index++;
    }
    if (text[index] !== '\n') {
        return -1;
    }
    index++;

    while (index < to) {
        const lineEnd = text.indexOf('\n', index);
        const lineStop = lineEnd < 0 || lineEnd > to ? to : lineEnd;
        const line = text.slice(index, lineStop);
        const trimmed = line.replace(/^[ \t]+/, '');

        if (trimmed.startsWith(label) && !isPhpIdentifierChar(trimmed[label.length])) {
            const indent = line.length - trimmed.length;
            return Math.min(index + indent + label.length, to);
        }

        if (lineEnd < 0 || lineEnd >= to) {
            return to;
        }
        index = lineEnd + 1;
    }

    return to;
}

// 遍历一段 PHP 代码：跳过字符串/注释/heredoc，emit 括号与控制关键字 token；
// 返回区间内 `?>` 的偏移（未找到返回 -1）。注释内的 ?> 视为终止（与 PHP 一致）。
function walkPhpCode(
    text: string,
    from: number,
    to: number,
    emit?: (token: PhpToken) => void,
    lineOffsets?: number[]
): number {
    let index = from;
    const lineAt = (offset: number): number =>
        lineOffsets ? getPhpLineAtOffset(lineOffsets, offset) : 0;

    while (index < to) {
        const char = text[index];
        const next = index + 1 < text.length ? text[index + 1] : '';

        if (char === '?') {
            if (next === '>') {
                return index;
            }
            index++;
            continue;
        }

        if (char === '\'' || char === '"') {
            index = skipPhpString(text, index, to);
            continue;
        }

        if (char === '/' && next === '/') {
            index = skipPhpLineComment(text, index + 2, to);
            continue;
        }

        if (char === '#') {
            if (next === '[') {
                index++;
                continue;
            }
            index = skipPhpLineComment(text, index + 1, to);
            continue;
        }

        if (char === '/' && next === '*') {
            index = skipPhpBlockComment(text, index + 2, to);
            continue;
        }

        if (char === '<' && next === '<' && text[index + 2] === '<') {
            const heredocEnd = trySkipPhpHeredoc(text, index, to);
            if (heredocEnd >= 0) {
                index = heredocEnd;
                continue;
            }
        }

        if (OPEN_BRACKETS.has(char) || CLOSE_BRACKETS.has(char)) {
            emit?.({ text: char, offset: index, line: lineAt(index) });
            index++;
            continue;
        }

        if (isPhpIdentifierStartChar(char)) {
            let end = index + 1;
            while (end < to && isPhpIdentifierChar(text[end])) {
                end++;
            }

            const word = text.slice(index, end);
            if (PHP_KEYWORDS.has(word) && !isPhpMemberAccess(text, index)) {
                emit?.({ text: word, offset: index, line: lineAt(index) });
            }
            index = end;
            continue;
        }

        index++;
    }

    return -1;
}

// `->prop` / `Foo::CONST` / `$var` 之后的标识符不是控制关键字
function isPhpMemberAccess(text: string, identifierStart: number): boolean {
    let index = identifierStart - 1;
    while (index >= 0 && (text[index] === ' ' || text[index] === '\t' || text[index] === '\r' || text[index] === '\n')) {
        index--;
    }

    const char = text[index];
    if (char === '$') {
        return true;
    }
    if (char === '>' && text[index - 1] === '-') {
        return true;
    }
    if (char === ':' && text[index - 1] === ':') {
        return true;
    }
    return false;
}

function isOpenPhpTag(text: string, at: number): number {
    const after = at + 2;
    const char = text[after];

    if (char === '=') {
        return after + 1;
    }
    if (char && /\s/.test(char)) {
        return after;
    }
    if (
        text.slice(after, after + 3).toLowerCase() === 'php' &&
        !isPhpIdentifierChar(text[after + 3])
    ) {
        return after + 3;
    }
    return -1;
}

export function scanPhpTags(text: string): PhpTag[] {
    const tags: PhpTag[] = [];
    let searchIndex = 0;

    while (searchIndex < text.length) {
        const startIndex = text.indexOf('<?', searchIndex);
        if (startIndex < 0) {
            break;
        }

        const openMarkerEnd = isOpenPhpTag(text, startIndex);
        if (openMarkerEnd < 0) {
            searchIndex = startIndex + 2;
            continue;
        }

        const codeStart = openMarkerEnd;
        const closeOffset = walkPhpCode(text, codeStart, text.length);
        const codeEnd = closeOffset >= 0 ? closeOffset : text.length;

        tags.push({
            start: startIndex,
            end: closeOffset >= 0 ? closeOffset + 2 : text.length,
            openMarkerStart: startIndex,
            openMarkerEnd,
            codeStart,
            codeEnd,
            closeMarkerStart: closeOffset
        });

        searchIndex = closeOffset >= 0 ? closeOffset + 2 : text.length;
    }

    return tags;
}

function nextNonWhitespaceChar(text: string, from: number): string {
    let index = from;
    while (index < text.length && (text[index] === ' ' || text[index] === '\t' || text[index] === '\r' || text[index] === '\n')) {
        index++;
    }
    return text[index] ?? '';
}

interface PendingAltOpener {
    kind: string;
    token: PhpToken;
    seenOpenParen: boolean;
    parenBalance: number;
}

interface AltBlockState {
    kind: string;
    open: PhpToken;
    segmentStart: PhpToken;
}

export function getPhpTagInfo(text: string): PhpTagDocumentInfo {
    const tags = scanPhpTags(text);
    const bracketPairs = new Map<number, number>();
    const altPairs: PhpAltSyntaxPair[] = [];
    const foldingRanges: PhpFoldingRange[] = [];

    if (!tags.length) {
        return { tags, bracketPairs, altPairs, foldingRanges };
    }

    const lineOffsets = buildPhpLineOffsets(text);
    const tokens: PhpToken[] = [];
    for (const tag of tags) {
        walkPhpCode(text, tag.codeStart, tag.codeEnd, token => tokens.push(token), lineOffsets);
    }

    const pushFold = (startLine: number, endLine: number): void => {
        if (endLine > startLine) {
            foldingRanges.push({ start: startLine, end: endLine });
        }
    };

    const braceStack: PhpToken[] = [];
    const pairStacks = new Map<string, PhpToken[]>();
    const altStack: AltBlockState[] = [];
    let pending: PendingAltOpener | undefined;

    for (const token of tokens) {
        if (token.text.length === 1) {
            const char = token.text;

            const openBracket = OPEN_BRACKETS.get(char);
            if (openBracket) {
                const stack = pairStacks.get(char) ?? [];
                stack.push(token);
                pairStacks.set(char, stack);

                if (char === '{') {
                    braceStack.push(token);
                }

                if (pending && !pending.seenOpenParen) {
                    if (char === '(') {
                        pending.seenOpenParen = true;
                        pending.parenBalance = 1;
                    } else {
                        pending = undefined;
                    }
                } else if (pending && char === '(') {
                    pending.parenBalance++;
                }
                continue;
            }

            const closeBracket = CLOSE_BRACKETS.get(char);
            if (!closeBracket) {
                continue;
            }

            const stack = pairStacks.get(closeBracket);
            const openToken = stack?.pop();
            if (openToken) {
                bracketPairs.set(openToken.offset, token.offset);
                bracketPairs.set(token.offset, openToken.offset);

                if (char === '}') {
                    pushFold(openToken.line, token.line - 1);
                }
            }

            if (pending && pending.seenOpenParen && char === ')') {
                pending.parenBalance--;
                if (pending.parenBalance === 0) {
                    // 替代语法要求冒号紧跟在 ) 之后，防止 `echo $a ? 1 : 0;` 的三元冒号误判
                    if (nextNonWhitespaceChar(text, token.offset + 1) === ':') {
                        altStack.push({ kind: pending.kind, open: pending.token, segmentStart: pending.token });
                    }
                    pending = undefined;
                }
            }
            continue;
        }

        if (pending && (!pending.seenOpenParen || pending.parenBalance > 0)) {
            if (!pending.seenOpenParen) {
                pending = undefined;
            } else {
                continue;
            }
        }

        if (ALT_OPENERS.has(token.text)) {
            pending = { kind: token.text, token, seenOpenParen: false, parenBalance: 0 };
            continue;
        }

        if (ALT_CONTINUATIONS.has(token.text)) {
            const top = altStack[altStack.length - 1];
            if (top) {
                pushFold(top.segmentStart.line, token.line - 1);
                top.segmentStart = token;
            }
            continue;
        }

        const closerKind = ALT_CLOSER_KIND.get(token.text);
        if (closerKind) {
            const top = altStack[altStack.length - 1];
            if (top && top.kind === closerKind) {
                altStack.pop();
                pushFold(top.segmentStart.line, token.line - 1);
                altPairs.push({ kind: closerKind, open: top.open, close: token });
            }
        }
    }

    for (const tag of tags) {
        const startLine = getPhpLineAtOffset(lineOffsets, tag.start);
        const lastLine = getPhpLineAtOffset(lineOffsets, Math.max(tag.start, tag.end - 1));
        pushFold(startLine, lastLine - 1);
    }

    foldingRanges.sort((a, b) => a.start - b.start || b.end - a.end);
    return { tags, bracketPairs, altPairs, foldingRanges };
}

export function getPhpBracketPairs(text: string): Map<number, number> {
    return getPhpTagInfo(text).bracketPairs;
}

export function findMatchingPhpBracket(text: string, offset: number): number | null {
    return getPhpTagInfo(text).bracketPairs.get(offset) ?? null;
}

export function findPhpTagFoldingRanges(text: string): PhpFoldingRange[] {
    return getPhpTagInfo(text).foldingRanges;
}
