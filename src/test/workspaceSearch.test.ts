import * as assert from 'assert';
import * as vscode from 'vscode';
import { WorkspaceReferenceProvider } from '../providers/workspaceReferenceProvider';
import { VueGlobalSymbolProvider } from '../providers/workspaceSymbolProvider';

/**
 * 工作区级搜索集成测试：跨文件引用（Shift+F12 数据源）与全局符号搜索（Ctrl+T 数据源）。
 * 通过工作区根目录的临时探针文件验证（测试结束即删除）。
 */
suite('Workspace Search Providers', () => {
    // 运行时生成唯一符号，保证只有探针文件包含它们（测试源码/编译产物里不会命中）
    const unique = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const probeSymbol = `__leidong_ws_probe_symbol_${unique}__`;
    const probeGlobal = `__leidong_ws_probe_global_${unique}__`;
    let probeUri: vscode.Uri;

    suiteSetup(async () => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(folder, '测试需要打开工作区');
        probeUri = vscode.Uri.joinPath(folder!.uri, '.tmp-ws-search-probe.js');
        const content = [
            `const ${probeSymbol} = 1; // 定义处`,
            `window.${probeGlobal} = { name: 'probe' };`,
            `function useProbe() { return ${probeSymbol} + 1; }`,
            `const pageRef = ${probeSymbol};`,
        ].join('\n');
        await vscode.workspace.fs.writeFile(probeUri, Buffer.from(content, 'utf8'));
    });

    suiteTeardown(async () => {
        try { await vscode.workspace.fs.delete(probeUri); } catch { /* ignore */ }
    });

    test('跨文件引用：在工作区文件中找到符号的全部出现', async () => {
        const document = await vscode.workspace.openTextDocument(probeUri);
        const provider = new WorkspaceReferenceProvider();
        const tokenSource = new vscode.CancellationTokenSource();
        try {
            const position = new vscode.Position(0, 'const '.length + 2);
            const locations = await provider.provideReferences(document, position, { includeDeclaration: true }, tokenSource.token);
            assert.ok(locations, '应返回引用结果');
            assert.ok(locations!.length >= 3, `应找到 >=3 处出现，实际 ${locations!.length}`);
            assert.ok(
                locations!.every(location => location.uri.fsPath.toLowerCase().endsWith('.tmp-ws-search-probe.js')),
                '命中应全部来自探测文件',
            );
        } finally {
            tokenSource.dispose();
        }
    });

    test('全局符号搜索：找到 window.* 全局定义', async () => {
        const provider = new VueGlobalSymbolProvider();
        const tokenSource = new vscode.CancellationTokenSource();
        try {
            const symbols = await provider.provideWorkspaceSymbols(probeGlobal, tokenSource.token);
            assert.ok(symbols.some(symbol => symbol.name === probeGlobal), `应找到全局符号 ${probeGlobal}`);
        } finally {
            tokenSource.dispose();
        }
        provider.dispose();
    });
});
