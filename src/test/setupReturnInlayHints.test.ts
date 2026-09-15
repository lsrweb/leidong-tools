import * as assert from 'assert';
import * as vscode from 'vscode';
import { SetupReturnInlayHintsProvider } from '../providers/setupReturnInlayHints';

/**
 * setup return 幽灵文本 Provider 集成测试（真实 VS Code API 下构造文档与 InlayHint）。
 */
suite('Setup Return Inlay Hints Provider', () => {
    const fixture = [
        'const subCount = 0; // 子账号可见素材数量',
        '// 切换选中',
        'const toggleSelection = (rows) => { rows; };',
        'const plain = 1;',
        'createApp({',
        '  setup() {',
        '    return {',
        '      subCount,',
        '      toggleSelection,',
        '      plain,',
        '    };',
        '  },',
        '});',
    ].join('\n');

    test('为 return 项生成幽灵文本，无注释项不生成，范围过滤与缓存重复调用一致', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: fixture });
        const provider = new SetupReturnInlayHintsProvider();
        const tokenSource = new vscode.CancellationTokenSource();
        const fullRange = new vscode.Range(0, 0, document.lineCount - 1, 0);

        const hints = provider.provideInlayHints(document, fullRange, tokenSource.token);
        assert.strictEqual(hints.length, 2, '应为 subCount 与 toggleSelection 生成幽灵文本');
        assert.strictEqual(hints[0].label, '子账号可见素材数量');
        assert.strictEqual(hints[0].position.line, 7);
        assert.strictEqual(hints[1].label, '切换选中');
        assert.strictEqual(hints[1].position.line, 8);

        // 范围过滤：仅返回可见行区间内的提示
        const narrowed = provider.provideInlayHints(document, new vscode.Range(8, 0, 8, 0), tokenSource.token);
        assert.strictEqual(narrowed.length, 1);
        assert.strictEqual(narrowed[0].label, '切换选中');

        // 二次调用命中缓存，结果一致
        const again = provider.provideInlayHints(document, fullRange, tokenSource.token);
        assert.deepStrictEqual(again.map(hint => hint.label), ['子账号可见素材数量', '切换选中']);

        tokenSource.dispose();
    });
});
