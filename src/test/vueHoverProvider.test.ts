import * as assert from 'assert';
import * as vscode from 'vscode';
import { VueHoverProvider } from '../providers/hoverProvider';

/**
 * Vue 悬停 Provider 集成测试：return 块内变量悬停显示注释（缺缓存时按需构建索引）。
 */
suite('Vue Hover Provider', () => {
    test('悬停 return 块内变量：按需构建索引并显示注释与类型', async () => {
        const fixture = [
            'const app = createApp({',
            '  setup() {',
            '    const subCount = ref(0); // 子账号可见素材数量',
            '    // 切换选中',
            '    const toggleSelection = (rows) => { rows; };',
            '    return {',
            '      subCount,',
            '      toggleSelection,',
            '    };',
            '  },',
            '});',
        ].join('\n');
        const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: fixture });
        const line = fixture.split('\n').findIndex(text => text.includes('subCount,'));
        const character = document.lineAt(line).text.indexOf('subCount') + 3;
        const provider = new VueHoverProvider();
        const tokenSource = new vscode.CancellationTokenSource();
        const hover = await provider.provideHover(document, new vscode.Position(line, character), tokenSource.token);
        tokenSource.dispose();
        assert.ok(hover, '悬停结果不应为空');
        const markdown = (hover!.contents[0] as vscode.MarkdownString).value;
        assert.ok(markdown.includes('Vue Data'), `悬停应包含 Vue Data 标签，实际: ${markdown}`);
        assert.ok(markdown.includes('子账号可见素材数量'), `悬停应包含注释，实际: ${markdown}`);

        // 函数项：显示上方注释
        const methodLine = fixture.split('\n').findIndex(text => text.includes('toggleSelection,'));
        const methodCharacter = document.lineAt(methodLine).text.indexOf('toggleSelection') + 3;
        const methodToken = new vscode.CancellationTokenSource();
        const methodHover = await provider.provideHover(document, new vscode.Position(methodLine, methodCharacter), methodToken.token);
        methodToken.dispose();
        assert.ok(methodHover, '函数悬停结果不应为空');
        const methodMarkdown = (methodHover!.contents[0] as vscode.MarkdownString).value;
        assert.ok(methodMarkdown.includes('Vue Method'), `函数悬停应包含 Vue Method 标签，实际: ${methodMarkdown}`);
        assert.ok(methodMarkdown.includes('切换选中'), `函数悬停应包含上方注释，实际: ${methodMarkdown}`);
    });
});
