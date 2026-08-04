const htmlVoidElements = new Set([
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

function findTagEnd(text: string, start: number): number {
    let quote = '';

    for (let index = start + 1; index < text.length; index++) {
        const character = text[index];
        if (quote) {
            if (character === quote) {
                quote = '';
            }
            continue;
        }

        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '>') {
            return index;
        }
    }

    return -1;
}

/**
 * Converts legacy end tags such as </br> to valid HTML before Prettier parses
 * the fragment. The scan works on complete tags so text inside comments and
 * quoted attributes is never rewritten accidentally.
 */
export function normalizeInvalidVoidEndTags(text: string): string {
    let result = '';
    let cursor = 0;

    while (cursor < text.length) {
        if (text.startsWith('<!--', cursor)) {
            const commentEnd = text.indexOf('-->', cursor + 4);
            const end = commentEnd < 0 ? text.length : commentEnd + 3;
            result += text.slice(cursor, end);
            cursor = end;
            continue;
        }

        if (text[cursor] !== '<') {
            result += text[cursor];
            cursor++;
            continue;
        }

        const tagEnd = findTagEnd(text, cursor);
        if (tagEnd < 0) {
            result += text.slice(cursor);
            break;
        }

        const tag = text.slice(cursor, tagEnd + 1);
        const endTagMatch = /^<\s*\/\s*([a-z][\w:-]*)\s*>$/i.exec(tag);
        const tagName = endTagMatch?.[1].toLowerCase();
        result += tagName && htmlVoidElements.has(tagName) ? `<${tagName} />` : tag;
        cursor = tagEnd + 1;
    }

    return result;
}
