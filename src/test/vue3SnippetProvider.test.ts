import * as assert from 'assert';
import * as vscode from 'vscode';
import { Vue3SnippetCompletionProvider } from '../providers/vue3SnippetProvider';

/**
 * Vue 快捷代码块 Provider 测试：组件模板全 JS 可用，页面模板仅 .dev.js。
 */
suite('Vue Snippet Provider', () => {
    const provide = async (text: string): Promise<vscode.CompletionItem[]> => {
        const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: text });
        const provider = new Vue3SnippetCompletionProvider();
        const position = new vscode.Position(0, text.split('\n')[0].length);
        const tokenSource = new vscode.CancellationTokenSource();
        try {
            return provider.provideCompletionItems(document, position, tokenSource.token);
        } finally {
            tokenSource.dispose();
        }
    };

    test('普通 JS 文件：v2/v3 提供组件模板、不提供页面模板', async () => {
        const v3Items = await provide('v3');
        const v3Prefixes = v3Items.map(item => item.filterText);
        assert.ok(v3Prefixes.includes('v3comp'), `应包含 v3comp，实际: ${v3Prefixes.join(',')}`);
        assert.ok(!v3Prefixes.includes('v3page'), '非 .dev.js 不应提供页面模板');
        const v2Prefixes = (await provide('v2')).map(item => item.filterText);
        assert.ok(v2Prefixes.includes('v2comp'), `应包含 v2comp，实际: ${v2Prefixes.join(',')}`);
    });

    test('组件模板包含标准结构（样式注入 + setup/data + template）', async () => {
        const items = await provide('v3');
        const component = items.find(item => item.filterText === 'v3comp');
        assert.ok(component, 'v3comp 缺失');
        const snippet = (component!.insertText as vscode.SnippetString).value;
        assert.ok(snippet.includes('STYLE_TEXT'), '应包含样式注入');
        assert.ok(snippet.includes('setup(props, { emit })'), '应包含 setup');
        assert.ok(snippet.includes('app.component'), '应包含注册用法说明');
        const vue2Items = await provide('v2');
        const vue2Component = vue2Items.find(item => item.filterText === 'v2comp');
        const vue2Snippet = (vue2Component!.insertText as vscode.SnippetString).value;
        assert.ok(vue2Snippet.includes('data()'), 'Vue2 模板应包含 data()');
        assert.ok(vue2Snippet.includes('beforeDestroy()'), 'Vue2 模板应包含 beforeDestroy');
    });

    test('非 v2/v3 前缀不触发', async () => {
        assert.strictEqual((await provide('const a = 1;')).length, 0);
        assert.strictEqual((await provide('v3x')).length > 0, true, 'v3 前缀可继续输入过滤');
    });
});
