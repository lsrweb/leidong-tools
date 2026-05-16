import * as vscode from 'vscode';
import type { Options as PrettierOptions } from 'prettier';

import { XTemplateBlock, scanXTemplateBlocks } from '../parsers/xTemplateParser';

type PrettierApi = {
    format: (source: string, options: PrettierOptions) => Promise<string> | string;
    resolveConfig?: (
        filePath: string,
        options?: { editorconfig?: boolean }
    ) => Promise<PrettierOptions | null> | PrettierOptions | null;
};

async function loadPrettier(): Promise<PrettierApi> {
    const imported = await import('prettier');
    const candidate = imported as unknown as PrettierApi & { default?: PrettierApi };
    const prettier = typeof candidate.format === 'function' ? candidate : candidate.default;

    if (!prettier || typeof prettier.format !== 'function') {
        throw new Error('Prettier API 加载失败：未找到 format 方法');
    }

    return prettier;
}

function getContainingXTemplateBlock(document: vscode.TextDocument, range: vscode.Range): XTemplateBlock | null {
    const text = document.getText();
    const rangeStart = document.offsetAt(range.start);
    const rangeEnd = document.offsetAt(range.end);

    return scanXTemplateBlocks(text).find(block => {
        return rangeStart >= block.openEnd && rangeEnd <= block.closeStart;
    }) ?? null;
}

function expandRangeToFullLines(document: vscode.TextDocument, range: vscode.Range): vscode.Range {
    const startLine = range.start.line;
    const endLine = range.end.character === 0 && range.end.line > range.start.line
        ? range.end.line - 1
        : range.end.line;
    const endLineText = document.lineAt(endLine).text;

    return new vscode.Range(
        new vscode.Position(startLine, 0),
        new vscode.Position(endLine, endLineText.length)
    );
}

function getEditorFallbackOptions(options: vscode.FormattingOptions): Pick<PrettierOptions, 'tabWidth' | 'useTabs'> {
    return {
        tabWidth: options.tabSize,
        useTabs: !options.insertSpaces
    };
}

function getDefaultPrettierOptions(): PrettierOptions {
    return {
        printWidth: 160,
        singleAttributePerLine: false
    };
}

function getConfiguredExtensionPrettierOptions(resource: vscode.Uri): PrettierOptions {
    const inspectedOptions = vscode.workspace
        .getConfiguration('leidong-tools', resource)
        .inspect<Record<string, unknown>>('xTemplatePrettierOptions');

    return {
        ...(inspectedOptions?.globalValue ?? {}),
        ...(inspectedOptions?.workspaceValue ?? {}),
        ...(inspectedOptions?.workspaceFolderValue ?? {})
    } as PrettierOptions;
}

function normalizePrettierOutput(templateText: string, formattedText: string): string {
    let normalized = formattedText;

    if (!templateText.endsWith('\n') && normalized.endsWith('\n')) {
        normalized = normalized.slice(0, -1);
    }

    return normalized;
}

function getLeadingWhitespace(text: string): string {
    return /^[ \t]*/.exec(text)?.[0] ?? '';
}

function getCommonIndent(text: string): string {
    const indents = text
        .split(/\r?\n/)
        .filter(line => line.trim().length > 0)
        .map(getLeadingWhitespace);

    if (indents.length === 0) {
        return '';
    }

    return indents.reduce((commonIndent, indent) => {
        let index = 0;
        while (index < commonIndent.length && index < indent.length && commonIndent[index] === indent[index]) {
            index++;
        }

        return commonIndent.slice(0, index);
    });
}

function stripCommonIndent(text: string, indent: string): string {
    if (!indent) {
        return text;
    }

    return text
        .split(/\r?\n/)
        .map(line => line.startsWith(indent) ? line.slice(indent.length) : line)
        .join('\n');
}

function restoreCommonIndent(text: string, indent: string): string {
    if (!indent) {
        return text;
    }

    return text
        .split(/\r?\n/)
        .map(line => line.trim().length > 0 ? `${indent}${line}` : line)
        .join('\n');
}

function createMinimalReplaceEdit(
    document: vscode.TextDocument,
    block: XTemplateBlock,
    originalText: string,
    formattedText: string
): vscode.TextEdit[] {
    if (originalText === formattedText) {
        return [];
    }

    let start = 0;
    while (
        start < originalText.length &&
        start < formattedText.length &&
        originalText[start] === formattedText[start]
    ) {
        start++;
    }

    let originalEnd = originalText.length;
    let formattedEnd = formattedText.length;
    while (
        originalEnd > start &&
        formattedEnd > start &&
        originalText[originalEnd - 1] === formattedText[formattedEnd - 1]
    ) {
        originalEnd--;
        formattedEnd--;
    }

    return [vscode.TextEdit.replace(
        new vscode.Range(
            document.positionAt(block.openEnd + start),
            document.positionAt(block.openEnd + originalEnd)
        ),
        formattedText.slice(start, formattedEnd)
    )];
}

async function resolvePrettierOptions(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions
): Promise<PrettierOptions> {
    const prettier = await loadPrettier();
    const config = await prettier.resolveConfig?.(document.uri.fsPath, {
        editorconfig: true
    });

    return {
        ...getEditorFallbackOptions(options),
        ...getDefaultPrettierOptions(),
        ...(config ?? {}),
        ...getConfiguredExtensionPrettierOptions(document.uri),
        filepath: document.uri.fsPath,
        parser: 'html'
    };
}

async function formatXTemplateSelectionWithPrettier(
    document: vscode.TextDocument,
    range: vscode.Range,
    block: XTemplateBlock,
    options: vscode.FormattingOptions
): Promise<vscode.TextEdit[]> {
    const prettier = await loadPrettier();
    const selectedText = document.getText(range);

    if (!selectedText.trim()) {
        return [];
    }

    const commonIndent = getCommonIndent(selectedText);
    const normalizedText = stripCommonIndent(selectedText, commonIndent);
    const prettierOptions = await resolvePrettierOptions(document, options);
    const formattedText = normalizePrettierOutput(
        normalizedText,
        await Promise.resolve(prettier.format(normalizedText, prettierOptions))
    );
    const restoredText = restoreCommonIndent(formattedText, commonIndent);

    return createMinimalReplaceEdit(document, {
        ...block,
        openEnd: document.offsetAt(range.start)
    }, selectedText, restoredText);
}

export async function getXTemplateRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions
): Promise<vscode.TextEdit[]> {
    if (document.languageId !== 'html' || range.isEmpty) {
        return [];
    }

    const block = getContainingXTemplateBlock(document, range);
    if (!block) {
        return [];
    }

    const fullLineRange = expandRangeToFullLines(document, range);
    const fullLineStart = document.offsetAt(fullLineRange.start);
    const fullLineEnd = document.offsetAt(fullLineRange.end);
    const clippedRange = new vscode.Range(
        document.positionAt(Math.max(fullLineStart, block.openEnd)),
        document.positionAt(Math.min(fullLineEnd, block.closeStart))
    );

    return formatXTemplateSelectionWithPrettier(document, clippedRange, block, options);
}

function getEditorFormattingOptions(editor: vscode.TextEditor): vscode.FormattingOptions {
    const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
    const insertSpaces = typeof editor.options.insertSpaces === 'boolean' ? editor.options.insertSpaces : true;

    return { tabSize, insertSpaces };
}

export async function formatXTemplateSelectionOrFallback(editor: vscode.TextEditor): Promise<void> {
    if (editor.selection.isEmpty) {
        await vscode.commands.executeCommand('editor.action.formatSelection');
        return;
    }

    let edits: vscode.TextEdit[];
    try {
        edits = await getXTemplateRangeFormattingEdits(
            editor.document,
            editor.selection,
            getEditorFormattingOptions(editor)
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`text/x-template Prettier 格式化失败：${message}`);
        return;
    }

    if (edits.length === 0) {
        if (!getContainingXTemplateBlock(editor.document, editor.selection)) {
            await vscode.commands.executeCommand('editor.action.formatSelection');
        }
        return;
    }

    await editor.edit(editBuilder => {
        for (const edit of edits) {
            editBuilder.replace(edit.range, edit.newText);
        }
    });
}

export class XTemplateRangeFormattingProvider implements vscode.DocumentRangeFormattingEditProvider {
    async provideDocumentRangeFormattingEdits(
        document: vscode.TextDocument,
        range: vscode.Range,
        options: vscode.FormattingOptions,
        _token: vscode.CancellationToken
    ): Promise<vscode.TextEdit[]> {
        try {
            return await getXTemplateRangeFormattingEdits(document, range, options);
        } catch (error) {
            console.error('[leidong-tools] text/x-template Prettier formatting failed:', error);
            return [];
        }
    }
}
