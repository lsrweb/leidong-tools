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
    matchWholeToken?: boolean;
}

interface ActiveRule {
    config: TodoHighlightRule;
    decoration: vscode.TextEditorDecorationType;
    expression: RegExp;
}

interface DocumentHighlightCache {
    lineCount: number;
    rangesByRule: Array<Map<number, vscode.Range[]>>;
}

interface PendingUpdate {
    full: boolean;
    lines: Set<number>;
}

const CONFIG_SECTION = 'leidong-tools';
const SUPPORTED_SCHEMES = new Set(['file', 'untitled', 'vscode-remote']);

export class TodoHighlightProvider implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly pendingUpdates = new Map<string, PendingUpdate>();
    private readonly documentCaches = new Map<string, DocumentHighlightCache>();
    private rules: ActiveRule[] = [];
    private enabled = true;

    constructor() {
        this.reloadConfiguration();
        this.disposables.push(
            vscode.window.onDidChangeVisibleTextEditors(editors => {
                const visible = new Set(editors.map(editor => editor.document.uri.toString()));
                for (const key of this.documentCaches.keys()) {
                    if (!visible.has(key)) { this.documentCaches.delete(key); }
                }
                editors.forEach(editor => {
                    const cached = this.documentCaches.has(editor.document.uri.toString());
                    if (cached) { this.update(editor, new Set<number>()); } else { this.schedule(editor, 0); }
                });
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                const changedLines = this.incrementalLines(event);
                for (const editor of vscode.window.visibleTextEditors) {
                    if (editor.document === event.document) { this.schedule(editor, 120, changedLines); }
                }
            }),
            vscode.workspace.onDidCloseTextDocument(document => this.clearDocument(document.uri.toString())),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration(`${CONFIG_SECTION}.todoHighlightEnabled`) || event.affectsConfiguration(`${CONFIG_SECTION}.todoHighlightRules`)) {
                    this.reloadConfiguration();
                }
            })
        );
    }

    dispose(): void {
        for (const timer of this.timers.values()) { clearTimeout(timer); }
        this.timers.clear();
        this.pendingUpdates.clear();
        this.documentCaches.clear();
        this.disposeRules();
        this.disposables.forEach(disposable => disposable.dispose());
    }

    private reloadConfiguration(): void {
        for (const timer of this.timers.values()) { clearTimeout(timer); }
        this.timers.clear();
        this.disposeRules();
        this.documentCaches.clear();
        this.pendingUpdates.clear();
        const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
        this.enabled = configuration.get<boolean>('todoHighlightEnabled', true);
        const configuredRules = configuration.get<TodoHighlightRule[]>('todoHighlightRules', []);
        if (this.enabled) {
            this.rules = configuredRules
                .filter(rule => typeof rule?.prefix === 'string' && rule.prefix.length > 0 && !/[\r\n]/.test(rule.prefix))
                .map(rule => this.createRule(rule));
        }
        for (const editor of vscode.window.visibleTextEditors) {
            const cached = this.documentCaches.has(editor.document.uri.toString());
            this.update(editor, cached ? new Set<number>() : undefined);
        }
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
            rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
        });
        return {
            config,
            decoration,
            expression: this.createExpression(config),
        };
    }

    private schedule(editor: vscode.TextEditor, delay = 120, changedLines?: Set<number>): void {
        const key = editor.document.uri.toString();
        this.clearTimer(key);
        let pending = this.pendingUpdates.get(key);
        if (!pending) {
            pending = { full: !changedLines || !this.documentCaches.has(key), lines: new Set<number>() };
            this.pendingUpdates.set(key, pending);
        }
        if (!changedLines || !this.documentCaches.has(key)) {
            pending.full = true;
            pending.lines.clear();
        } else if (!pending.full) {
            changedLines.forEach(line => pending!.lines.add(line));
        }
        this.timers.set(key, setTimeout(() => {
            this.timers.delete(key);
            const update = this.pendingUpdates.get(key);
            this.pendingUpdates.delete(key);
            const editors = vscode.window.visibleTextEditors.filter(item => item.document.uri.toString() === key);
            if (!editors.length) { return; }
            this.update(editors[0], update?.full ? undefined : update?.lines);
            const cache = this.documentCaches.get(key);
            if (cache) { editors.slice(1).forEach(item => this.applyDecorations(item, cache!)); }
        }, delay));
    }

    private update(editor: vscode.TextEditor, changedLines?: Set<number>): void {
        const key = editor.document.uri.toString();
        if (!SUPPORTED_SCHEMES.has(editor.document.uri.scheme)) {
            this.rules.forEach(rule => editor.setDecorations(rule.decoration, []));
            this.documentCaches.delete(key);
            return;
        }
        if (!this.enabled) { return; }
        const document = editor.document;
        let cache = this.documentCaches.get(key);
        const requiresFullScan = !cache || cache.lineCount !== document.lineCount || !changedLines;
        if (requiresFullScan) {
            cache = { lineCount: document.lineCount, rangesByRule: this.rules.map(() => new Map<number, vscode.Range[]>()) };
            for (let line = 0; line < document.lineCount; line++) {
                this.rules.forEach((rule, index) => this.setLineRanges(cache!.rangesByRule[index], rule, document, line));
            }
            this.documentCaches.set(key, cache);
        } else {
            for (const line of changedLines) {
                if (line < 0 || line >= document.lineCount) { continue; }
                this.rules.forEach((rule, index) => this.setLineRanges(cache!.rangesByRule[index], rule, document, line));
            }
        }
        this.applyDecorations(editor, cache!);
    }

    private applyDecorations(editor: vscode.TextEditor, cache: DocumentHighlightCache): void {
        this.rules.forEach((rule, index) => {
            const ranges = [...cache.rangesByRule[index].values()].flat();
            editor.setDecorations(rule.decoration, ranges);
        });
    }

    private setLineRanges(target: Map<number, vscode.Range[]>, rule: ActiveRule, document: vscode.TextDocument, lineNumber: number): void {
        const line = document.lineAt(lineNumber);
        const ranges: vscode.Range[] = [];
        rule.expression.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = rule.expression.exec(line.text)) !== null) {
            const mode = rule.config.highlightMode || 'prefix';
            if (mode === 'line') {
                ranges.push(line.range);
                break;
            }
            const start = new vscode.Position(lineNumber, match.index);
            const end = mode === 'text' ? line.range.end : new vscode.Position(lineNumber, match.index + match[0].length);
            ranges.push(new vscode.Range(start, end));
            if (match[0].length === 0) { rule.expression.lastIndex++; }
        }
        if (ranges.length) { target.set(lineNumber, ranges); } else { target.delete(lineNumber); }
    }

    private incrementalLines(event: vscode.TextDocumentChangeEvent): Set<number> | undefined {
        if (!event.contentChanges.length || event.contentChanges.some(change =>
            change.range.start.line !== change.range.end.line || /[\r\n]/.test(change.text))) {
            return undefined;
        }
        return new Set(event.contentChanges.map(change => change.range.start.line));
    }

    private clearDocument(key: string): void {
        this.clearTimer(key);
        this.pendingUpdates.delete(key);
        this.documentCaches.delete(key);
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

    private createExpression(config: TodoHighlightRule): RegExp {
        const escaped = this.escapeRegExp(config.prefix);
        const wholeToken = config.matchWholeToken !== false;
        const startsWithWord = /^[A-Za-z0-9_]/.test(config.prefix);
        const endsWithWord = /[A-Za-z0-9_]$/.test(config.prefix);
        const before = wholeToken && startsWithWord ? '(?<![A-Za-z0-9_])' : '';
        const after = wholeToken && endsWithWord ? '(?![A-Za-z0-9_])' : '';
        return new RegExp(`${before}${escaped}${after}`, config.caseSensitive === false ? 'gi' : 'g');
    }
}
