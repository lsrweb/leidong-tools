import * as vscode from 'vscode';

import { getLaytplBracketPairs } from '../parsers/laytplParser';

const BRACKET_CHARS = new Set(['(', ')', '[', ']', '{', '}']);

const laytplBracketMatchDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editorBracketMatch.background'),
    borderRadius: '2px'
});

let lastDecoratedEditor: vscode.TextEditor | undefined;

const pairCache = new Map<string, { version: number; pairs: Map<number, number> }>();

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
    pairCache.set(cacheKey, { version: document.version, pairs });
    return pairs;
}

function createRangeFromOffset(document: vscode.TextDocument, offset: number): vscode.Range {
    const start = document.positionAt(offset);
    const end = document.positionAt(offset + 1);
    return new vscode.Range(start, end);
}

function findCandidateBracketOffsets(document: vscode.TextDocument, position: vscode.Position): number[] {
    const text = document.getText();
    const currentOffset = document.offsetAt(position);
    const offsets: number[] = [];

    if (currentOffset < text.length && isBracketChar(text[currentOffset])) {
        offsets.push(currentOffset);
    }

    if (currentOffset > 0 && isBracketChar(text[currentOffset - 1])) {
        offsets.push(currentOffset - 1);
    }

    return offsets;
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

    const pairs = getBracketPairs(editor.document);
    const candidates = findCandidateBracketOffsets(editor.document, editor.selection.active);

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