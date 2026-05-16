import * as vscode from 'vscode';

import { findXTemplateFoldingRanges as collectXTemplateFoldingRanges } from '../parsers/xTemplateParser';

export { findXTemplateFoldingRanges } from '../parsers/xTemplateParser';

export class XTemplateFoldingRangeProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(
        document: vscode.TextDocument,
        _context: vscode.FoldingContext,
        _token: vscode.CancellationToken
    ): vscode.FoldingRange[] {
        return collectXTemplateFoldingRanges(document.getText()).map(
            range => new vscode.FoldingRange(range.start, range.end, vscode.FoldingRangeKind.Region)
        );
    }
}
