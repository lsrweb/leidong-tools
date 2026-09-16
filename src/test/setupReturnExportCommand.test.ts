import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * 「导出到 setup return」命令集成测试：真实编辑器 + WorkspaceEdit 端到端。
 */
suite('Export To Setup Return Command', () => {
    test('命令把光标处符号按声明顺序导出到 return 块', async () => {
        const fixture = [
            'const alpha = 1; // A',
            'const beta = 2; // B',
            'const gamma = 3; // C',
            'createApp({',
            '  setup() {',
            '    return {',
            '      alpha,',
            '      gamma,',
            '    };',
            '  },',
            '});',
        ].join('\n');
        const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: fixture });
        const editor = await vscode.window.showTextDocument(document);
        // 光标放到 beta 声明中间
        editor.selection = new vscode.Selection(1, 8, 1, 8);
        await vscode.commands.executeCommand('leidong-tools.exportToSetupReturn');
        assert.deepStrictEqual(document.getText().split('\n').slice(5, 10), [
            '    return {',
            '      alpha,',
            '      beta,',
            '      gamma,',
            '    };',
        ]);
    });

    test('已导出的符号重复调用给出提示且不改动文档', async () => {
        const fixture = [
            'const alpha = 1;',
            'createApp({',
            '  setup() {',
            '    return {',
            '      alpha,',
            '    };',
            '  },',
            '});',
        ].join('\n');
        const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: fixture });
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(0, 8, 0, 8);
        await vscode.commands.executeCommand('leidong-tools.exportToSetupReturn');
        assert.strictEqual(document.getText(), fixture, '已导出时不应产生修改');
    });
});
