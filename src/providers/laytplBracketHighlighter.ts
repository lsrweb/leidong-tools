import * as vscode from 'vscode';

import { getLaytplBracketPairs } from '../parsers/laytplParser';

const BRACKET_CHARS = new Set(['(', ')', '[', ']', '{', '}']);

const laytplBracketMatchDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editorBracketMatch.background'),
    borderRadius: '2px'
});

let lastDecoratedEditor: vscode.TextEditor | undefined;

const pairCache = new Map<string, { version: number; pairs: Map<number, number> }>();
const MAX_PAIR_CACHE_ENTRIES = 20;

function isBracketChar(char: string | undefined): boolean {
    return Boolean(char && BRACKET_CHARS.has(char));
}

function getBracketPairs(document: vscode.TextDocument): Map<number, number> {
    const cacheKey = document.uri.toString();
    const cached = pairCache.get(cacheKey);

    if (cached && cached.version === document.version) {
        return cached.pairs;
    }

    const pairs = getLaytplBracketPairs(document.getText());
    pairCache.delete(cacheKey);
    pairCache.set(cacheKey, { version: document.version, pairs });
    while (pairCache.size > MAX_PAIR_CACHE_ENTRIES) {
        const oldest = pairCache.keys().next().value as string | undefined;
        if (!oldest) { break; }
        pairCache.delete(oldest);
    }
    return pairs;
}

function createRangeFromOffset(document: vscode.TextDocument, offset: number): vscode.Range {
    const start = document.positionAt(offset);
    const end = document.positionAt(offset + 1);
    return new vscode.Range(start, end);
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

function isInsideLaytplTag(document: vscode.TextDocument, offset: number): boolean {
    const windowStart = Math.max(0, offset - 16384);
    const prefix = document.getText(new vscode.Range(document.positionAt(windowStart), document.positionAt(offset + 1)));
    return prefix.lastIndexOf('{{') > prefix.lastIndexOf('}}');
}

export function clearLaytplBracketHighlights(editor: vscode.TextEditor | undefined): void {
    if (editor) {
        editor.setDecorations(laytplBracketMatchDecorationType, []);
    }
}

export function updateLaytplBracketHighlights(editor: vscode.TextEditor | undefined): void {
    if (lastDecoratedEditor && lastDecoratedEditor !== editor) {
        clearLaytplBracketHighlights(lastDecoratedEditor);
    }

    if (!editor || editor.document.languageId !== 'html') {
        clearLaytplBracketHighlights(editor);
        lastDecoratedEditor = editor;
        return;
    }

    if (editor.selections.length !== 1 || !editor.selection.isEmpty) {
        clearLaytplBracketHighlights(editor);
        lastDecoratedEditor = editor;
        return;
    }

    const candidates = findCandidateBracketOffsets(editor.document, editor.selection.active)
        .filter(offset => isInsideLaytplTag(editor.document, offset));
    if (!candidates.length) {
        clearLaytplBracketHighlights(editor);
        lastDecoratedEditor = editor;
        return;
    }
    const pairs = getBracketPairs(editor.document);

    for (const sourceOffset of candidates) {
        const targetOffset = pairs.get(sourceOffset);
        if (targetOffset === undefined) {
            continue;
        }

        editor.setDecorations(laytplBracketMatchDecorationType, [
            { range: createRangeFromOffset(editor.document, sourceOffset) },
            { range: createRangeFromOffset(editor.document, targetOffset) }
        ]);
        lastDecoratedEditor = editor;
        return;
    }

    clearLaytplBracketHighlights(editor);
    lastDecoratedEditor = editor;
}

export function clearLaytplBracketCache(document: vscode.TextDocument): void {
    pairCache.delete(document.uri.toString());
}
