import * as vscode from 'vscode';
import { resolveVueIndexForHtml, findDefinitionInIndex } from '../parsers/parseDocument';
import { getXTemplateIdAtPosition } from '../helpers/templateContext';

function findLineCommentIndex(text: string): number {
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let escaped = false;

    for (let i = 0; i < text.length - 1; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (inSingle) {
            if (ch === '\\') {
                escaped = true;
            } else if (ch === '\'') {
                inSingle = false;
            }
            continue;
        }

        if (inDouble) {
            if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inDouble = false;
            }
            continue;
        }

        if (inTemplate) {
            if (ch === '\\') {
                escaped = true;
            } else if (ch === '`') {
                inTemplate = false;
            }
            continue;
        }

        if (ch === '\'') {
            inSingle = true;
            continue;
        }
        if (ch === '"') {
            inDouble = true;
            continue;
        }
        if (ch === '`') {
            inTemplate = true;
            continue;
        }
        if (ch === '/' && next === '/') {
            return i;
        }
    }

    return -1;
}

export async function addVariableComment(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('No active editor found');
        return;
    }

    const document = editor.document;
    const selection = editor.selection;
    const wordRange: vscode.Range | undefined = document.getWordRangeAtPosition(selection.active);
    const selectedText = selection.isEmpty ? '' : document.getText(selection).trim();
    const isPlainWord = /^[A-Za-z_$][\w$]*$/.test(selectedText);
    const variableName = isPlainWord ? selectedText : (wordRange ? document.getText(wordRange) : '');
    const sourceRange: vscode.Range | undefined = isPlainWord
        ? new vscode.Range(selection.start, selection.end)
        : wordRange;

    if (!variableName || !sourceRange) {
        vscode.window.showInformationMessage('Select a variable or place the cursor on one');
        return;
    }

    if (sourceRange.start.line !== sourceRange.end.line) {
        vscode.window.showInformationMessage('Only single-line selections are supported');
        return;
    }

    const commentText = await vscode.window.showInputBox({
        prompt: 'Enter a comment for the variable',
        placeHolder: 'e.g. group id',
        ignoreFocusOut: true
    });

    if (commentText === undefined) {
        return;
    }

    const trimmed = commentText.trim();
    if (!trimmed) {
        vscode.window.showInformationMessage('Comment text cannot be empty');
        return;
    }

    let targetUri = document.uri;
    let targetLine = sourceRange.start.line;

    if (document.languageId === 'html') {
        let vueIndex = resolveVueIndexForHtml(document);
        const templateId = getXTemplateIdAtPosition(document, selection.active);
        if (templateId && vueIndex?.componentsByTemplateId?.has(templateId)) {
            vueIndex = vueIndex.componentsByTemplateId.get(templateId) || null;
        }
        if (!vueIndex) {
            vscode.window.showInformationMessage('No Vue index found for this HTML file');
            return;
        }
        const dataLoc = vueIndex.data.get(variableName) || null;
        const def = dataLoc || findDefinitionInIndex(variableName, vueIndex);
        if (!def) {
            vscode.window.showInformationMessage('No matching definition found in Vue index');
            return;
        }
        targetUri = def.uri;
        targetLine = def.range.start.line;
    }

    const targetDoc = await vscode.workspace.openTextDocument(targetUri);
    const line = targetDoc.lineAt(targetLine);
    const lineText = line.text;
    const commentIndex = findLineCommentIndex(lineText);
    const baseText = commentIndex >= 0 ? lineText.slice(0, commentIndex).replace(/\s+$/, '') : lineText.replace(/\s+$/, '');
    const newLineText = `${baseText} // ${trimmed}`;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(targetUri, line.range, newLineText);
    await vscode.workspace.applyEdit(edit);
}
