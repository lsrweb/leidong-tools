export interface XTemplateBlock {
    id: string | null;
    openStart: number;
    openEnd: number;
    closeStart: number;
    closeEnd: number;
}

export interface XTemplateFoldingRange {
    start: number;
    end: number;
}

interface HtmlTagToken {
    name: string;
    kind: 'open' | 'close';
    selfClosing: boolean;
    start: number;
    end: number;
}

interface OpenHtmlTag {
    name: string;
    line: number;
}

const VOID_HTML_TAGS = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr'
]);

export function buildXTemplateLineOffsets(text: string): number[] {
    const lineOffsets = [0];

    for (let index = 0; index < text.length; index++) {
        if (text[index] === '\n') {
            lineOffsets.push(index + 1);
        }
    }

    return lineOffsets;
}

export function getXTemplateLineAtOffset(lineOffsets: number[], offset: number): number {
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

function isXTemplateScriptTag(tag: string): boolean {
    return /<script\b/i.test(tag) && /type\s*=\s*(?:"text\/x-template"|'text\/x-template'|text\/x-template)(?=\s|>|\/)/i.test(tag);
}

function extractIdFromTag(tag: string): string | null {
    const quoted = /id\s*=\s*(['"])([^'"]+)\1/i.exec(tag);
    if (quoted) {
        return quoted[2];
    }

    const unquoted = /id\s*=\s*([^\s>]+)/i.exec(tag);
    return unquoted ? unquoted[1] : null;
}

export function scanXTemplateBlocks(text: string): XTemplateBlock[] {
    const blocks: XTemplateBlock[] = [];
    const openScriptRegex = /<script\b[^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = openScriptRegex.exec(text)) !== null) {
        const openTag = match[0];
        if (!isXTemplateScriptTag(openTag)) {
            continue;
        }

        const openStart = match.index;
        const openEnd = openStart + openTag.length;
        const closeMatch = /<\/script\s*>/i.exec(text.slice(openEnd));
        if (!closeMatch) {
            break;
        }

        const closeStart = openEnd + closeMatch.index;
        const closeEnd = closeStart + closeMatch[0].length;
        blocks.push({
            id: extractIdFromTag(openTag),
            openStart,
            openEnd,
            closeStart,
            closeEnd
        });

        openScriptRegex.lastIndex = closeEnd;
    }

    return blocks;
}

function findTagEnd(text: string, start: number, limit: number): number {
    let quote: '"' | '\'' | null = null;

    for (let index = start; index < limit; index++) {
        const char = text[index];

        if (quote) {
            if (char === quote) {
                quote = null;
            }
            continue;
        }

        if (char === '"' || char === '\'') {
            quote = char;
            continue;
        }

        if (char === '>') {
            return index;
        }
    }

    return -1;
}

function readHtmlTagToken(text: string, start: number, limit: number): HtmlTagToken | null {
    if (text[start] !== '<') {
        return null;
    }

    const nextChar = text[start + 1];
    if (!nextChar || nextChar === '!' || nextChar === '?' || nextChar === '%') {
        return null;
    }

    let nameStart = start + 1;
    let kind: HtmlTagToken['kind'] = 'open';
    if (nextChar === '/') {
        kind = 'close';
        nameStart++;
    }

    while (nameStart < limit && /\s/.test(text[nameStart])) {
        nameStart++;
    }

    const nameMatch = /^[A-Za-z][\w:.-]*/.exec(text.slice(nameStart, limit));
    if (!nameMatch) {
        return null;
    }

    const name = nameMatch[0].toLowerCase();
    const end = findTagEnd(text, nameStart + name.length, limit);
    if (end < 0) {
        return null;
    }

    const beforeEnd = text.slice(nameStart + name.length, end).trimEnd();
    return {
        name,
        kind,
        selfClosing: kind === 'open' && (beforeEnd.endsWith('/') || VOID_HTML_TAGS.has(name)),
        start,
        end: end + 1
    };
}

function skipHtmlComment(text: string, start: number, limit: number): number | null {
    if (!text.startsWith('<!--', start)) {
        return null;
    }

    const commentEnd = text.indexOf('-->', start + 4);
    if (commentEnd < 0 || commentEnd >= limit) {
        return limit;
    }

    return commentEnd + 3;
}

function findHtmlTagFoldingRangesInBlock(
    text: string,
    block: XTemplateBlock,
    lineOffsets: number[]
): XTemplateFoldingRange[] {
    const ranges: XTemplateFoldingRange[] = [];
    const stack: OpenHtmlTag[] = [];
    let index = block.openEnd;

    while (index < block.closeStart) {
        const tagStart = text.indexOf('<', index);
        if (tagStart < 0 || tagStart >= block.closeStart) {
            break;
        }

        const commentEnd = skipHtmlComment(text, tagStart, block.closeStart);
        if (commentEnd !== null) {
            index = commentEnd;
            continue;
        }

        const token = readHtmlTagToken(text, tagStart, block.closeStart);
        if (!token) {
            index = tagStart + 1;
            continue;
        }

        if (token.kind === 'open' && !token.selfClosing) {
            stack.push({
                name: token.name,
                line: getXTemplateLineAtOffset(lineOffsets, token.start)
            });
            index = token.end;
            continue;
        }

        if (token.kind === 'close') {
            const matchingIndex = stack.map(item => item.name).lastIndexOf(token.name);
            if (matchingIndex >= 0) {
                const openTag = stack[matchingIndex];
                stack.length = matchingIndex;

                const closeLine = getXTemplateLineAtOffset(lineOffsets, token.start);
                const endLine = closeLine - 1;
                if (endLine > openTag.line) {
                    ranges.push({ start: openTag.line, end: endLine });
                }
            }
        }

        index = token.end;
    }

    return ranges;
}

export function findXTemplateFoldingRanges(text: string): XTemplateFoldingRange[] {
    const lineOffsets = buildXTemplateLineOffsets(text);
    const ranges: XTemplateFoldingRange[] = [];

    for (const block of scanXTemplateBlocks(text)) {
        const contentRanges = findHtmlTagFoldingRangesInBlock(text, block, lineOffsets);
        ranges.push(...contentRanges);

        const openLine = getXTemplateLineAtOffset(lineOffsets, block.openStart);
        const closeLine = getXTemplateLineAtOffset(lineOffsets, block.closeStart);
        if (closeLine - 1 > openLine) {
            ranges.push({ start: openLine, end: closeLine - 1 });
        }
    }

    return ranges;
}
