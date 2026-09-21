import * as vscode from 'vscode';

import { findPhpTagFoldingRanges as collectPhpTagFoldingRanges } from '../parsers/phpTagParser';

export { findPhpTagFoldingRanges } from '../parsers/phpTagParser';

export class PhpTagFoldingRangeProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(
        document: vscode.TextDocument,
        _context: vscode.FoldingContext,
        _token: vscode.CancellationToken
    ): vscode.FoldingRange[] {
        const text = document.getText();
        if (!text.includes('<?')) {
            return [];
        }

        return collectPhpTagFoldingRanges(text).map(
            range => new vscode.FoldingRange(range.start, range.end, vscode.FoldingRangeKind.Region)
        );
    }
}
