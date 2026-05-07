import * as vscode from 'vscode';

import { findLaytplFoldingRanges as collectLaytplFoldingRanges } from '../parsers/laytplParser';

export { findLaytplFoldingRanges } from '../parsers/laytplParser';

export class LaytplFoldingRangeProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(
        document: vscode.TextDocument,
        _context: vscode.FoldingContext,
        _token: vscode.CancellationToken
    ): vscode.FoldingRange[] {
        return collectLaytplFoldingRanges(document.getText()).map(
            range => new vscode.FoldingRange(range.start, range.end, vscode.FoldingRangeKind.Region)
        );
    }
}