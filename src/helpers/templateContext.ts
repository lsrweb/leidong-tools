import * as vscode from 'vscode';

function isXTemplateScriptTag(tag: string): boolean {
    return /type\s*=\s*(["']?)text\/x-template\1/i.test(tag);
}

function isTemplateBlockTag(tag: string): boolean {
    return /<template\b/i.test(tag);
}

function extractIdFromTag(tag: string): string | null {
    const quoted = /id\s*=\s*(['"])([^'"]+)\1/i.exec(tag);
    if (quoted) { return quoted[2]; }
    const unquoted = /id\s*=\s*([^\s>]+)/i.exec(tag);
    return unquoted ? unquoted[1] : null;
}

export function getXTemplateIdAtPosition(document: vscode.TextDocument, position: vscode.Position): string | null {
    if (document.languageId !== 'html') { return null; }
    const text = document.getText();
    const offset = document.offsetAt(position);
    const blockOpenRegex = /<(script|template)\b[^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = blockOpenRegex.exec(text)) !== null) {
        const openStart = match.index;
        const openEnd = match.index + match[0].length;
        if (openStart > offset) { break; }
        const tag = match[0];
        const isScript = /<script\b/i.test(tag);
        const isTemplate = !isScript && isTemplateBlockTag(tag);
        if (!isScript && !isTemplate) { continue; }

        const templateId = extractIdFromTag(tag);
        if (!templateId) { continue; }
        if (isScript && !isXTemplateScriptTag(tag)) { continue; }

        const closeTag = isTemplate ? '</template>' : '</script>';
        const closeIndex = text.indexOf(closeTag, openEnd);
        if (closeIndex === -1) { continue; }
        if (offset >= openEnd && offset <= closeIndex) {
            return templateId;
        }
    }

    return null;
}
