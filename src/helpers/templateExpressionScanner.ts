import * as vscode from 'vscode';

export interface TemplateExpressionRange {
    expression: string;
    startOffset: number;
}

const IDENTIFIER_RE = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;

const TEMPLATE_ATTR_RE = /(?:^|[\s<])((?:v-[\w.-]+(?::[\w.-]+)?|[:@#][\w.-]+|slot-scope|scope|key|ref|\bon\w+|[\w-]+))\s*=\s*("([^"]*)"|'([^']*)')/gi;

const VUE_ATTR_NAME_RE = /^(?:v-|[:@#]|slot-scope$|scope$|key$|ref$|on\w+$)/i;

const HTML_LITERAL_ATTRS = new Set([
    'class', 'id', 'style', 'src', 'href', 'alt', 'title', 'width', 'height',
    'type', 'value', 'name', 'placeholder', 'rel', 'for', 'role'
]);

const KEYWORDS = new Set([
    'true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'new',
    'in', 'of', 'if', 'else', 'return', 'var', 'let', 'const', 'function',
    'this', 'that', 'self', 'vm', 'console', 'window', 'document', 'Math',
    'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date',
    'RegExp', 'Error', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'NaN', 'Infinity', 'arguments', 'await', 'async'
]);

function isTemplateExpressionAttribute(attrName: string, expression: string): boolean {
    const normalized = attrName.replace(/^\s+/, '');
    if (VUE_ATTR_NAME_RE.test(normalized)) { return true; }
    if (HTML_LITERAL_ATTRS.has(normalized.toLowerCase())) { return false; }
    return /[(){}[\]?:+*|&=!<>]|=>/.test(expression);
}

function maskStringsAndComments(expr: string): string {
    return expr
        .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
        .replace(/\/\/[^\n\r]*/g, m => ' '.repeat(m.length))
        .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, m => ' '.repeat(m.length))
        .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, m => ' '.repeat(m.length))
        .replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, m => ' '.repeat(m.length));
}

function maskArrowParams(expr: string): string {
    return expr
        .replace(/\([^)]*\)\s*=>/g, m => `${' '.repeat(Math.max(0, m.length - 2))}=>`)
        .replace(/\b[a-zA-Z_$][\w$]*\s*=>/g, m => `${' '.repeat(Math.max(0, m.length - 2))}=>`);
}

function maskExpression(expr: string): string {
    return maskArrowParams(maskStringsAndComments(expr));
}

export function extractVueTemplateExpressionRanges(text: string): TemplateExpressionRange[] {
    const ranges: TemplateExpressionRange[] = [];
    let match: RegExpExecArray | null;

    const mustacheRe = /\{\{([\s\S]*?)\}\}/g;
    while ((match = mustacheRe.exec(text)) !== null) {
        ranges.push({
            expression: match[1],
            startOffset: match.index + 2
        });
    }

    TEMPLATE_ATTR_RE.lastIndex = 0;
    while ((match = TEMPLATE_ATTR_RE.exec(text)) !== null) {
        const attrName = match[1];
        const expression = match[3] ?? match[4] ?? '';
        if (!expression || !isTemplateExpressionAttribute(attrName, expression)) { continue; }
        const quotedValue = match[2];
        const valueOffsetInMatch = match[0].lastIndexOf(quotedValue);
        const startOffset = match.index + valueOffsetInMatch + 1;
        ranges.push({ expression, startOffset });
    }

    return ranges;
}

export function extractIdentifiersFromVueTemplateExpressions(text: string): Set<string> {
    const identifiers = new Set<string>();
    for (const range of extractVueTemplateExpressionRanges(text)) {
        const masked = maskExpression(range.expression);
        let match: RegExpExecArray | null;
        IDENTIFIER_RE.lastIndex = 0;
        while ((match = IDENTIFIER_RE.exec(masked)) !== null) {
            const name = match[1];
            if (KEYWORDS.has(name)) { continue; }
            identifiers.add(name);
        }
    }
    return identifiers;
}

export function countVueTemplateIdentifierReferences(text: string, names: ReadonlySet<string>): Map<string, number> {
    const counts = new Map<string, number>();
    names.forEach(name => counts.set(name, 0));
    if (!text || names.size === 0) { return counts; }

    for (const range of extractVueTemplateExpressionRanges(text)) {
        const masked = maskExpression(range.expression);
        let match: RegExpExecArray | null;
        IDENTIFIER_RE.lastIndex = 0;
        while ((match = IDENTIFIER_RE.exec(masked)) !== null) {
            const current = counts.get(match[1]);
            if (current !== undefined) {
                counts.set(match[1], current + 1);
            }
        }
    }
    return counts;
}

export function findVueTemplateIdentifierReferences(text: string, identifier: string, uri: vscode.Uri): vscode.Location[] {
    const locations: vscode.Location[] = [];
    if (!identifier) { return locations; }
    const seen = new Set<string>();
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const identifierRe = new RegExp(`\\b${escaped}\\b`, 'g');

    for (const range of extractVueTemplateExpressionRanges(text)) {
        const masked = maskExpression(range.expression);
        let match: RegExpExecArray | null;
        identifierRe.lastIndex = 0;
        while ((match = identifierRe.exec(masked)) !== null) {
            const absoluteOffset = range.startOffset + match.index;
            const docPosition = positionAt(text, absoluteOffset);
            const key = `${docPosition.line}:${docPosition.character}`;
            if (seen.has(key)) { continue; }
            seen.add(key);
            locations.push(new vscode.Location(
                uri,
                new vscode.Range(docPosition, docPosition.translate(0, identifier.length))
            ));
        }
    }
    return locations;
}

function positionAt(text: string, offset: number): vscode.Position {
    const prefix = text.slice(0, offset);
    const lines = prefix.split(/\r?\n/);
    return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
}
