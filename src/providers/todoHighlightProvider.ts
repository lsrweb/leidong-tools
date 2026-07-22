import * as vscode from 'vscode';

type HighlightMode = 'prefix' | 'text' | 'line';

interface TodoHighlightRule {
    prefix: string;
    color?: string;
    backgroundColor?: string;
    fontWeight?: string;
    fontStyle?: string;
    textDecoration?: string;
    borderRadius?: string;
    overviewRulerColor?: string;
    highlightMode?: HighlightMode;
    caseSensitive?: boolean;
}

interface ActiveRule {
    config: TodoHighlightRule;
    decoration: vscode.TextEditorDecorationType;
    expression: RegExp;
}

const CONFIG_SECTION = 'leidong-tools';
const SUPPORTED_SCHEMES = new Set(['file', 'untitled', 'vscode-remote']);

export class TodoHighlightProvider implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private rules: ActiveRule[] = [];
    private enabled = true;

    constructor() {
        this.reloadConfiguration();
        this.disposables.push(
            vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(editor => this.schedule(editor, 0))),
            vscode.workspace.onDidChangeTextDocument(event => {
                for (const editor of vscode.window.visibleTextEditors) {
                    if (editor.document === event.document) { this.schedule(editor); }
                }
            }),
            vscode.workspace.onDidCloseTextDocument(document => this.clearTimer(document.uri.toString())),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration(`${CONFIG_SECTION}.todoHighlightEnabled`) || event.affectsConfiguration(`${CONFIG_SECTION}.todoHighlightRules`)) {
                    this.reloadConfiguration();
                }
            })
        );
        vscode.window.visibleTextEditors.forEach(editor => this.schedule(editor, 0));
    }

    dispose(): void {
        for (const timer of this.timers.values()) { clearTimeout(timer); }
        this.timers.clear();
        this.disposeRules();
        this.disposables.forEach(disposable => disposable.dispose());
    }

    private reloadConfiguration(): void {
        this.disposeRules();
        const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
        this.enabled = configuration.get<boolean>('todoHighlightEnabled', true);
        const configuredRules = configuration.get<TodoHighlightRule[]>('todoHighlightRules', []);
        if (this.enabled) {
            this.rules = configuredRules
                .filter(rule => typeof rule?.prefix === 'string' && rule.prefix.length > 0)
                .map(rule => this.createRule(rule));
        }
        for (const editor of vscode.window.visibleTextEditors) { this.update(editor); }
    }

    private createRule(config: TodoHighlightRule): ActiveRule {
        const decoration = vscode.window.createTextEditorDecorationType({
            color: config.color,
            backgroundColor: config.backgroundColor,
            fontWeight: config.fontWeight,
            fontStyle: config.fontStyle,
            textDecoration: config.textDecoration,
            borderRadius: config.borderRadius || '3px',
            overviewRulerColor: config.overviewRulerColor || config.backgroundColor,
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        });
        return {
            config,
            decoration,
            expression: new RegExp(this.escapeRegExp(config.prefix), config.caseSensitive ? 'g' : 'gi'),
        };
    }

    private schedule(editor: vscode.TextEditor, delay = 80): void {
        const key = editor.document.uri.toString();
        this.clearTimer(key);
        this.timers.set(key, setTimeout(() => {
            this.timers.delete(key);
            if (vscode.window.visibleTextEditors.includes(editor)) { this.update(editor); }
        }, delay));
    }

    private update(editor: vscode.TextEditor): void {
        if (!SUPPORTED_SCHEMES.has(editor.document.uri.scheme)) {
            this.rules.forEach(rule => editor.setDecorations(rule.decoration, []));
            return;
        }
        if (!this.enabled) { return; }
        const document = editor.document;
        const text = document.getText();
        for (const rule of this.rules) {
            const ranges: vscode.Range[] = [];
            const highlightedLines = new Set<number>();
            rule.expression.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = rule.expression.exec(text)) !== null) {
                const start = document.positionAt(match.index);
                const line = document.lineAt(start.line);
                const mode = rule.config.highlightMode || 'prefix';
                if (mode === 'line') {
                    if (!highlightedLines.has(start.line)) { ranges.push(line.range); highlightedLines.add(start.line); }
                } else {
                    const end = mode === 'text' ? line.range.end : document.positionAt(match.index + match[0].length);
                    ranges.push(new vscode.Range(start, end));
                }
                if (match[0].length === 0) { rule.expression.lastIndex++; }
            }
            editor.setDecorations(rule.decoration, ranges);
        }
    }

    private disposeRules(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            for (const rule of this.rules) { editor.setDecorations(rule.decoration, []); }
        }
        this.rules.forEach(rule => rule.decoration.dispose());
        this.rules = [];
    }

    private clearTimer(key: string): void {
        const timer = this.timers.get(key);
        if (timer) { clearTimeout(timer); this.timers.delete(key); }
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
