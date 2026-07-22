import * as vscode from 'vscode';
import { getXTemplateIdAtPosition } from '../helpers/templateContext';

const TAGS = [
    'div', 'span', 'p', 'a', 'button', 'input', 'textarea', 'select', 'option',
    'form', 'label', 'img', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td',
    'section', 'header', 'footer', 'main', 'article', 'aside', 'nav', 'template', 'slot',
];

const ATTRIBUTES: Array<{ label: string; insertText?: string; detail: string }> = [
    { label: 'class', insertText: 'class="$1"', detail: 'HTML class' },
    { label: 'style', insertText: 'style="$1"', detail: 'Inline CSS' },
    { label: 'id', insertText: 'id="$1"', detail: 'HTML id' },
    { label: 'title', insertText: 'title="$1"', detail: 'HTML title' },
    { label: 'v-if', insertText: 'v-if="$1"', detail: 'Vue conditional' },
    { label: 'v-else-if', insertText: 'v-else-if="$1"', detail: 'Vue conditional' },
    { label: 'v-else', detail: 'Vue conditional' },
    { label: 'v-for', insertText: 'v-for="item in $1"', detail: 'Vue loop' },
    { label: 'v-show', insertText: 'v-show="$1"', detail: 'Vue visibility' },
    { label: 'v-model', insertText: 'v-model="$1"', detail: 'Vue binding' },
    { label: ':class', insertText: ':class="$1"', detail: 'Vue class binding' },
    { label: ':style', insertText: ':style="$1"', detail: 'Vue style binding' },
    { label: '@click', insertText: '@click="$1"', detail: 'Vue click event' },
    { label: '@change', insertText: '@change="$1"', detail: 'Vue change event' },
    { label: '@input', insertText: '@input="$1"', detail: 'Vue input event' },
    { label: 'ref', insertText: 'ref="$1"', detail: 'Vue ref' },
    { label: 'key', insertText: ':key="$1"', detail: 'Vue key binding' },
];

/** HTML fallback completion for script[type=text/x-template] embedded scopes. */
export class XTemplateHtmlCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.CompletionItem[]> {
        if (document.languageId !== 'html' || !getXTemplateIdAtPosition(document, position)) {
            return [];
        }
        const tagText = getOpenTagText(document, position);
        if (!tagText) { return []; }

        const tagMatch = /<([\w-]*)$/.exec(tagText);
        if (tagMatch) {
            return TAGS.filter(tag => tag.startsWith(tagMatch[1])).map((tag, index) => {
                const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Keyword);
                item.insertText = new vscode.SnippetString(`${tag}>$0</${tag}>`);
                item.detail = 'HTML tag · text/x-template';
                item.sortText = `0000${index.toString().padStart(3, '0')}`;
                return item;
            });
        }

        const attributeMatch = /(?:^|\s)([:@#\w-]*)$/.exec(tagText);
        if (!attributeMatch || /["']/.test(attributeMatch[1])) { return []; }
        const prefix = attributeMatch[1];
        return ATTRIBUTES.filter(attribute => attribute.label.startsWith(prefix)).map((attribute, index) => {
            const item = new vscode.CompletionItem(attribute.label, vscode.CompletionItemKind.Property);
            item.insertText = attribute.insertText ? new vscode.SnippetString(attribute.insertText) : attribute.label;
            item.detail = `${attribute.detail} · text/x-template`;
            item.sortText = `0000${index.toString().padStart(3, '0')}`;
            return item;
        });
    }
}

function getOpenTagText(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    const offset = document.offsetAt(position);
    const text = document.getText(new vscode.Range(document.positionAt(Math.max(0, offset - 16000)), position));
    const open = text.lastIndexOf('<');
    if (open < 0 || text.lastIndexOf('>') > open) { return undefined; }
    return text.slice(open);
}
