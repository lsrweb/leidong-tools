export type LaytplTagKind = 'comment' | 'ignore' | 'output' | 'raw-output' | 'scriptlet';

export interface LaytplTag {
    kind: LaytplTagKind;
    code: string;
    start: number;
    end: number;
    codeStart: number;
    codeEnd: number;
}

interface LaytplBracketToken {
    char: '(' | ')' | '[' | ']' | '{' | '}';
    offset: number;
    line: number;
}

interface ClassifiedLaytplTag {
    kind: LaytplTagKind;
    code: string;
    codeStartDelta: number;
    codeEndDelta: number;
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

const LEGACY_SCRIPTLET_START = /^(?:if\b|else\b|for\b|while\b|switch\b|try\b|catch\b|finally\b|var\b|let\b|const\b|return\b|break\b|continue\b|do\b|function\b|case\b|default\b|\}|\)|\]|[A-Za-z_$][\w$.]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*(?:\(|=|\.|\[)|;)/;
const GENERIC_SCRIPTLET_START = /^(?:if\b|else\b|for\b|while\b|switch\b|try\b|catch\b|finally\b|var\b|let\b|const\b|return\b|break\b|continue\b|do\b|function\b|case\b|default\b|\}|\)|\]|[A-Za-z_$][\w$.]*\s*(?:\(|=))/;

export function buildLaytplLineOffsets(text: string): number[] {
    const lineOffsets = [0];

    for (let index = 0; index < text.length; index++) {
        if (text[index] === '\n') {
            lineOffsets.push(index + 1);
        }
    }

    return lineOffsets;
}

export function getLaytplLineAtOffset(lineOffsets: number[], offset: number): number {
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

function looksLikeLegacyScriptlet(code: string): boolean {
    const trimmed = code.trim();
    if (!trimmed) {
        return false;
    }

    return LEGACY_SCRIPTLET_START.test(trimmed) || /[{};]/.test(trimmed);
}

function looksLikeGenericScriptlet(code: string): boolean {
    const trimmed = code.trim();
    if (!trimmed) {
        return false;
    }

    return GENERIC_SCRIPTLET_START.test(trimmed) || /[{};]/.test(trimmed);
}

function findFirstNonWhitespaceIndex(text: string, startIndex: number): number {
    let index = startIndex;

    while (index < text.length && /\s/.test(text[index])) {
        index++;
    }

    return index;
}

function trimTrailingWhitespaceIndex(text: string, endIndex: number): number {
    let index = endIndex;

    while (index > 0 && /\s/.test(text[index - 1])) {
        index--;
    }

    return index;
}

function classifyLaytplTag(rawInner: string): ClassifiedLaytplTag {
    const firstContentIndex = findFirstNonWhitespaceIndex(rawInner, 0);
    const contentEndIndex = trimTrailingWhitespaceIndex(rawInner, rawInner.length);

    if (firstContentIndex >= contentEndIndex) {
        return {
            kind: 'output',
            code: '',
            codeStartDelta: contentEndIndex,
            codeEndDelta: contentEndIndex
        };
    }

    const marker = rawInner[firstContentIndex];
    if (marker === '=' || marker === '-' || marker === '#') {
        const codeStartDelta = findFirstNonWhitespaceIndex(rawInner, firstContentIndex + 1);
        const code = rawInner.slice(codeStartDelta, contentEndIndex);

        if (marker === '=') {
            return { kind: 'output', code, codeStartDelta, codeEndDelta: contentEndIndex };
        }

        if (marker === '-') {
            return { kind: 'raw-output', code, codeStartDelta, codeEndDelta: contentEndIndex };
        }

        return {
            kind: looksLikeLegacyScriptlet(code) ? 'scriptlet' : 'comment',
            code,
            codeStartDelta,
            codeEndDelta: contentEndIndex
        };
    }

    const code = rawInner.slice(firstContentIndex, contentEndIndex);
    return {
        kind: looksLikeGenericScriptlet(code) ? 'scriptlet' : 'output',
        code,
        codeStartDelta: firstContentIndex,
        codeEndDelta: contentEndIndex
    };
}

export function scanLaytplTags(text: string): LaytplTag[] {
    const tags: LaytplTag[] = [];
    const openTag = '{{';
    let searchIndex = 0;

    while (searchIndex < text.length) {
        const startIndex = text.indexOf(openTag, searchIndex);
        if (startIndex < 0) {
            break;
        }

        const marker = text[startIndex + openTag.length];
        const isIgnoreTag = marker === '!';
        const contentStart = startIndex + openTag.length + (isIgnoreTag ? 1 : 0);
        const closeTag = isIgnoreTag ? '!}}' : '}}';

        // 找到关闭标签，处理 `}}}` 歧义：若 `}}` 紧跟着另一个 `}`（即 `}}}`），
        // 则第一个 `}` 属于脚本代码，应将 `}}` 向后推一位直至不再紧跟 `}`。
        let closeIndex = text.indexOf(closeTag, contentStart);
        if (!isIgnoreTag) {
            while (closeIndex >= 0 && closeIndex + closeTag.length < text.length && text[closeIndex + closeTag.length] === '}') {
                closeIndex = text.indexOf(closeTag, closeIndex + 1);
            }
        }

        if (closeIndex < 0) {
            break;
        }

        const rawInner = text.slice(contentStart, closeIndex);
        if (isIgnoreTag) {
            tags.push({
                kind: 'ignore',
                code: rawInner,
                start: startIndex,
                end: closeIndex + closeTag.length,
                codeStart: contentStart,
                codeEnd: closeIndex
            });
        } else {
            const classified = classifyLaytplTag(rawInner);
            tags.push({
                kind: classified.kind,
                code: classified.code,
                start: startIndex,
                end: closeIndex + closeTag.length,
                codeStart: contentStart + classified.codeStartDelta,
                codeEnd: contentStart + classified.codeEndDelta
            });
        }

        searchIndex = closeIndex + closeTag.length;
    }

    return tags;
}

function scanBracketTokens(code: string, codeStart: number, lineOffsets: number[]): LaytplBracketToken[] {
    const tokens: LaytplBracketToken[] = [];
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inTemplateString = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;

    for (let index = 0; index < code.length; index++) {
        const char = code[index];
        const nextChar = code[index + 1];
        const absoluteOffset = codeStart + index;

        if (inLineComment) {
            if (char === '\n') {
                inLineComment = false;
            }
            continue;
        }

        if (inBlockComment) {
            if (char === '*' && nextChar === '/') {
                inBlockComment = false;
                index++;
            }
            continue;
        }

        if (escaped) {
            escaped = false;
            continue;
        }

        if ((inSingleQuote || inDoubleQuote || inTemplateString) && char === '\\') {
            escaped = true;
            continue;
        }

        if (inSingleQuote) {
            if (char === '\'') {
                inSingleQuote = false;
            }
            continue;
        }

        if (inDoubleQuote) {
            if (char === '"') {
                inDoubleQuote = false;
            }
            continue;
        }

        if (inTemplateString) {
            if (char === '`') {
                inTemplateString = false;
            }
            continue;
        }

        if (char === '/' && nextChar === '/') {
            inLineComment = true;
            continue;
        }

        if (char === '/' && nextChar === '*') {
            inBlockComment = true;
            index++;
            continue;
        }

        if (char === '\'') {
            inSingleQuote = true;
            continue;
        }

        if (char === '"') {
            inDoubleQuote = true;
            continue;
        }

        if (char === '`') {
            inTemplateString = true;
            continue;
        }

        if (!OPEN_BRACKETS.has(char) && !CLOSE_BRACKETS.has(char)) {
            continue;
        }

        tokens.push({
            char: char as LaytplBracketToken['char'],
            offset: absoluteOffset,
            line: getLaytplLineAtOffset(lineOffsets, absoluteOffset)
        });
    }

    return tokens;
}

function matchBracketTokens(tokens: LaytplBracketToken[], pairs: Map<number, number>): void {
    const stacks = new Map<string, LaytplBracketToken[]>();

    for (const token of tokens) {
        if (OPEN_BRACKETS.has(token.char)) {
            const stack = stacks.get(token.char) ?? [];
            stack.push(token);
            stacks.set(token.char, stack);
            continue;
        }

        const openBracket = CLOSE_BRACKETS.get(token.char);
        if (!openBracket) {
            continue;
        }

        const stack = stacks.get(openBracket);
        const openToken = stack?.pop();
        if (!openToken) {
            continue;
        }

        pairs.set(openToken.offset, token.offset);
        pairs.set(token.offset, openToken.offset);
    }
}

export function getLaytplBracketPairs(text: string): Map<number, number> {
    const pairs = new Map<number, number>();
    const tags = scanLaytplTags(text);
    const lineOffsets = buildLaytplLineOffsets(text);
    const scriptletTokens: LaytplBracketToken[] = [];

    for (const tag of tags) {
        if (tag.kind === 'ignore' || tag.kind === 'comment') {
            continue;
        }

        const tokens = scanBracketTokens(tag.code, tag.codeStart, lineOffsets);
        if (tag.kind === 'scriptlet') {
            scriptletTokens.push(...tokens);
            continue;
        }

        matchBracketTokens(tokens, pairs);
    }

    matchBracketTokens(scriptletTokens, pairs);
    return pairs;
}

export function findMatchingLaytplBracket(text: string, offset: number): number | null {
    return getLaytplBracketPairs(text).get(offset) ?? null;
}

export function findLaytplFoldingRanges(text: string): Array<{ start: number; end: number }> {
    const tags = scanLaytplTags(text);
    const lineOffsets = buildLaytplLineOffsets(text);
    const ranges: Array<{ start: number; end: number }> = [];
    const stack: number[] = [];

    for (const tag of tags) {
        if (tag.kind !== 'scriptlet') {
            continue;
        }

        const tokens = scanBracketTokens(tag.code, tag.codeStart, lineOffsets)
            .filter(token => token.char === '{' || token.char === '}');

        for (const token of tokens) {
            if (token.char === '}') {
                const startLine = stack.pop();
                const endLine = token.line - 1;

                if (startLine !== undefined && endLine > startLine) {
                    ranges.push({ start: startLine, end: endLine });
                }
                continue;
            }

            stack.push(token.line);
        }
    }

    return ranges;
}