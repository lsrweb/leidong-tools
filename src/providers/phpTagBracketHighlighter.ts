import * as vscode from 'vscode';

import { getPhpTagInfo, PhpAltSyntaxPair, PhpTagDocumentInfo, PhpTag, PhpToken } from '../parsers/phpTagParser';

const BRACKET_CHARS = new Set(['(', ')', '[', ']', '{', '}']);

const phpTagMatchDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editorBracketMatch.background'),
    borderRadius: '2px'
});

let lastDecoratedEditor: vscode.TextEditor | undefined;

const infoCache = new Map<string, { version: number; info: PhpTagDocumentInfo }>();
const MAX_INFO_CACHE_ENTRIES = 20;

function isBracketChar(char: string | undefined): boolean {
    return Boolean(char && BRACKET_CHARS.has(char));
}

function isPhpDocument(document: vscode.TextDocument): boolean {
    return document.languageId === 'php' || document.languageId === 'html';
}

function getDocumentInfo(document: vscode.TextDocument): PhpTagDocumentInfo {
    const cacheKey = document.uri.toString();
    const cached = infoCache.get(cacheKey);

    if (cached && cached.version === document.version) {
        return cached.info;
    }

    const info = getPhpTagInfo(document.getText());
    infoCache.delete(cacheKey);
    infoCache.set(cacheKey, { version: document.version, info });
    while (infoCache.size > MAX_INFO_CACHE_ENTRIES) {
        const oldest = infoCache.keys().next().value as string | undefined;
        if (!oldest) { break; }
        infoCache.delete(oldest);
    }
    return info;
}

function createRangeFromOffsets(document: vscode.TextDocument, startOffset: number, endOffset: number): vscode.Range {
    return new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));
}

function findCandidateBracketOffsets(document: vscode.TextDocument, position: vscode.Position): number[] {
    const line = document.lineAt(position.line).text;
    const currentOffset = document.offsetAt(position);
    const offsets: number[] = [];

    if (isBracketChar(line[position.character])) {
        offsets.push(currentOffset);
    }

    if (position.character > 0 && isBracketChar(line[position.character - 1])) {
        offsets.push(currentOffset - 1);
    }

    return offsets;
}

function isWithinToken(offset: number, token: PhpToken): boolean {
    return offset >= token.offset && offset < token.offset + token.text.length;
}

function collectAltPairDecorations(
    document: vscode.TextDocument,
    pair: PhpAltSyntaxPair,
    offset: number
): vscode.DecorationOptions[] | undefined {
    if (!isWithinToken(offset, pair.open) && !isWithinToken(offset, pair.close)) {
        return undefined;
    }

    return [
        { range: createRangeFromOffsets(document, pair.open.offset, pair.open.offset + pair.open.text.length) },
        { range: createRangeFromOffsets(document, pair.close.offset, pair.close.offset + pair.close.text.length) }
    ];
}

function collectTagMarkerDecorations(
    document: vscode.TextDocument,
    tag: PhpTag,
    offset: number
): vscode.DecorationOptions[] | undefined {
    if (tag.closeMarkerStart < 0) {
        return undefined;
    }

    const onOpenMarker = offset >= tag.openMarkerStart && offset < tag.openMarkerEnd;
    const onCloseMarker = offset >= tag.closeMarkerStart && offset < tag.closeMarkerStart + 2;
    if (!onOpenMarker && !onCloseMarker) {
        return undefined;
    }

    return [
        { range: createRangeFromOffsets(document, tag.openMarkerStart, tag.openMarkerEnd) },
        { range: createRangeFromOffsets(document, tag.closeMarkerStart, tag.closeMarkerStart + 2) }
    ];
}

function collectMatchDecorations(
    document: vscode.TextDocument,
    info: PhpTagDocumentInfo,
    offset: number
): vscode.DecorationOptions[] {
    for (const candidate of findCandidateBracketOffsets(document, document.positionAt(offset))) {
        const target = info.bracketPairs.get(candidate);
        if (target === undefined) {
            continue;
        }

        return [
            { range: createRangeFromOffsets(document, candidate, candidate + 1) },
            { range: createRangeFromOffsets(document, target, target + 1) }
        ];
    }

    for (const pair of info.altPairs) {
        const decorations = collectAltPairDecorations(document, pair, offset);
        if (decorations) {
            return decorations;
        }
    }

    for (const tag of info.tags) {
        const decorations = collectTagMarkerDecorations(document, tag, offset);
        if (decorations) {
            return decorations;
        }
    }

    return [];
}

export function clearPhpTagBracketHighlights(editor: vscode.TextEditor | undefined): void {
    if (editor) {
        editor.setDecorations(phpTagMatchDecorationType, []);
    }
}

export function updatePhpTagBracketHighlights(editor: vscode.TextEditor | undefined): void {
    if (lastDecoratedEditor && lastDecoratedEditor !== editor) {
        clearPhpTagBracketHighlights(lastDecoratedEditor);
    }

    if (!editor || !isPhpDocument(editor.document)) {
        clearPhpTagBracketHighlights(editor);
        lastDecoratedEditor = editor;
        return;
    }

    if (editor.selections.length !== 1 || !editor.selection.isEmpty) {
        clearPhpTagBracketHighlights(editor);
        lastDecoratedEditor = editor;
        return;
    }

    const document = editor.document;
    if (!document.getText().includes('<?')) {
        clearPhpTagBracketHighlights(editor);
        lastDecoratedEditor = editor;
        return;
    }

    const offset = document.offsetAt(editor.selection.active);
    const decorations = collectMatchDecorations(document, getDocumentInfo(document), offset);
    editor.setDecorations(phpTagMatchDecorationType, decorations);
    lastDecoratedEditor = editor;
}

export function clearPhpTagInfoCache(document: vscode.TextDocument): void {
    infoCache.delete(document.uri.toString());
}
