import * as assert from 'assert';
import * as vscode from 'vscode';
import { EmbeddedLanguageProvider, isEmbeddedVueExpression } from '../providers/embeddedLanguageProvider';
import { JavaScriptCompletionProvider } from '../providers/completionProvider';
import { getTemplateLiteralAtPosition } from '../helpers/templateLiteralHelper';
import { parseEmbeddedTemplates, getEmbeddedTemplates, getEmbeddedTemplateAtPosition, maskTemplateHoles, MAX_EMBEDDED_DOCUMENT_LENGTH } from '../parsers/embeddedTemplateParser';

suite('内嵌 HTML/CSS 语言服务', () => {
    const provider = new EmbeddedLanguageProvider();
    const tokens = new vscode.CancellationTokenSource();
    const marker = '|CURSOR|';
    const open = async (source: string, language = 'javascript') => {
        const offset = source.indexOf(marker);
        assert.ok(offset >= 0, '测试必须指定光标');
        const text = source.replace(marker, '');
        const document = await vscode.workspace.openTextDocument({ language, content: text });
        return { document, position: document.positionAt(offset), text };
    };
    const complete = async (source: string, language = 'javascript') => {
        const data = await open(source, language);
        const items = provider.provideCompletionItems(data.document, data.position, tokens.token)?.items || [];
        return { ...data, items };
    };
    const label = (item: vscode.CompletionItem) => typeof item.label === 'string' ? item.label : item.label.label;
    const expectItem = (items: vscode.CompletionItem[], name: string) => {
        const item = items.find(item => label(item) === name);
        assert.ok(item, `缺少 ${name}，候选：${items.map(label).slice(0, 30).join(', ')}`);
        return item!;
    };
    suiteTeardown(() => tokens.dispose());

    test('任意变量名、多行 HTML，基础标签来自完整语言服务', async () => {
        const { items } = await complete('const anything = `\n  <dial|CURSOR|\n`;');
        expectItem(items, 'dialog');
    });

    test('CSS 多行样式和标签选择器，不依赖 STYLE/CSS 名称', async () => {
        const { items } = await complete('consume(`\n/* 组件 */\nbody {\n  grid-template-col|CURSOR|\n}\n`);');
        const item = expectItem(items, 'grid-template-columns');
        assert.ok(item.documentation, 'CSS 属性应有文档');
        assert.ok(item.insertText instanceof vscode.SnippetString);
    });

    test('CSS 复合、多行选择器支持子代组合符', async () => {
        const { items } = await complete('const x = `.a > span,\n.b:hover { dis|CURSOR| }`;');
        expectItem(items, 'display');
    });

    test('CSS 属性值、伪类、@ 规则补全', async () => {
        expectItem((await complete('const x = `.a { display: gr|CURSOR| }`;')).items, 'grid');
        assert.ok((await complete('const x = `a:ho|CURSOR| { color: red; }`;')).items.some(item => label(item).includes('hover')));
        assert.ok((await complete('const x = /* css */ `@med|CURSOR|`;')).items.some(item => label(item).includes('@media')));
    });

    test('HTML 按标签提供属性和属性值，支持跨行属性', async () => {
        expectItem((await complete('const x = `<input\n  place|CURSOR|>`;')).items, 'placeholder');
        expectItem((await complete('const x = `<input type="check|CURSOR|">`;')).items, 'checkbox');
        expectItem((await complete('const x = `<div v-i|CURSOR|></div>`;')).items, 'v-if');
    });

    test('HTML 行内 style 使用 CSS 服务，编辑范围不吞掉引号和标签', async () => {
        const { document, items, text } = await complete('const x = `<div\n style="display: gr|CURSOR|" title="保留"></div>`;');
        const item = expectItem(items, 'grid');
        assert.ok(item.range instanceof vscode.Range);
        assert.strictEqual(document.getText(item.range as vscode.Range), 'gr');
        const range = item.range as vscode.Range;
        const insert = item.insertText instanceof vscode.SnippetString ? item.insertText.value : item.insertText;
        const applied = text.slice(0, document.offsetAt(range.start)) + insert + text.slice(document.offsetAt(range.end));
        assert.ok(applied.includes('display: grid" title="保留"'));
        assert.ok(applied.endsWith('</div>`;'));
    });

    test('HTML style 标签中的 CSS 补全和悬停', async () => {
        expectItem((await complete('const x = `<style>.a { dis|CURSOR| }</style><div></div>`;')).items, 'display');
        const { document, position } = await open('const x = `<style>.a { dis|CURSOR|play: grid; }</style>`;');
        const hover = provider.provideHover(document, position, tokens.token);
        assert.ok(hover && hover.contents.length);
        assert.strictEqual(document.getText(hover!.range), 'display: grid');
    });

    test('不把 SCSS 或 script 内容当 HTML/CSS 补全', async () => {
        assert.deepStrictEqual((await complete('const x = `<style lang="scss">$foo: red; dis|CURSOR|</style>`;')).items, []);
        assert.deepStrictEqual((await complete('const x = `<script>const value = doc|CURSOR|</script>`;')).items, []);
    });

    test('HTML 标签和 CSS 属性悬停携带正确的源文件范围', async () => {
        for (const source of ['const x = `\n<but|CURSOR|ton>确定</button>`;', 'const x = `\n.a { col|CURSOR|or: red; }`;']) {
            const { document, position } = await open(source);
            const hover = provider.provideHover(document, position, tokens.token);
            assert.ok(hover?.contents.length);
            assert.ok(hover?.range?.contains(position));
            assert.ok(!document.getText(hover!.range).includes('`'));
        }
    });

    test('未闭合模板仍提供补全（AST 失败时的词法回退）', async () => {
        expectItem((await complete('const x = `\n<div><inp|CURSOR|')).items, 'input');
        expectItem((await complete('const x = `\n.a { dis|CURSOR|')).items, 'display');
    });

    test('前置无关 JS 语法错误不影响模板补全', async () => {
        expectItem((await complete('const broken = ;\nconsume(`<but|CURSOR|`);')).items, 'button');
    });

    test('CRLF、中文、Emoji 和中间光标的替换范围正确', async () => {
        const { document, items } = await complete('const 中文 = "😀";\r\nconsume(`\r\n  <div style="dis|CURSOR|play: grid"></div>\r\n`);');
        const item = expectItem(items, 'display');
        const range = item.range instanceof vscode.Range ? item.range : item.range!.replacing;
        assert.strictEqual(document.getText(range), 'display');
    });

    test('三元表达式、返回值、匿名参数、标签模板均按内容识别', () => {
        const regions = parseEmbeddedTemplates('const x = flag ? `<div></div>` : `<span></span>`; function f(){ return `.a { color: red; }`; } render(`<input>`); unknownTag`<button>`;');
        assert.strictEqual(regions.length, 5);
        assert.strictEqual(regions.filter(region => region.language === 'css').length, 1);
    });

    test('TypeScript、JSX、TSX 的模板串', async () => {
        for (const language of ['typescript', 'javascriptreact', 'typescriptreact']) {
            const prefix = language === 'typescript' ? 'const n: number = 1;' : 'const node = <div data-x="a">text</div>;';
            expectItem((await complete(prefix + '\nconst x = `<sect|CURSOR|>`;', language)).items, 'section');
        }
    });

    test('排除注释、普通字符串、正则和普通文本中的伪模板', () => {
        const source = '// const x = `<div>`;\n/* `.a { color:red }` */\nconst a = "`<span>`";\nconst b = /`<div>`/;\nconst c = `hello`;\nconst d = `<= 5`;\nconst e = `# 标题\n普通内容`;';
        assert.deepStrictEqual(parseEmbeddedTemplates(source), []);
    });

    test('不接管普通 JS 位置和 ${...} 表达式', async () => {
        for (const source of ['const x = doc|CURSOR|;', 'const x = `<div>${value.pro|CURSOR|p}</div>`;', 'const x = `.a { color: ${colors.re|CURSOR|d}; }`;']) {
            const { document, position, items } = await complete(source);
            assert.deepStrictEqual(items, []);
            assert.strictEqual(provider.provideHover(document, position, tokens.token), undefined);
        }
    });

    test('JS 插值中的对象、字符串、正则和嵌套模板边界准确', async () => {
        const source = 'const x = `<div>${({ a: "}", b: /}/, c: `<input type="te|CURSOR|">` }).c}</div>`;';
        const { document, position, items } = await complete(source);
        expectItem(items, 'text');
        const regions = getEmbeddedTemplates(document);
        assert.strictEqual(regions.length, 2);
        const outer = regions.find(region => region.content.startsWith('<div>'))!;
        assert.strictEqual(outer.holes.length, 1);
        const holeText = document.getText(new vscode.Range(document.positionAt(outer.holes[0].start), document.positionAt(outer.holes[0].end)));
        assert.ok(holeText.startsWith('${') && holeText.endsWith('}'));
        assert.ok(getEmbeddedTemplateAtPosition(document, position)!.content.startsWith('<input'));
        assert.strictEqual(maskTemplateHoles(outer.content, outer.start, outer.holes).length, outer.content.length);
    });

    test('插值之后静态 HTML/CSS 继续补全', async () => {
        expectItem((await complete('const x = `<div>${title}</div>\n<but|CURSOR|>`;')).items, 'button');
        expectItem((await complete('const x = `.a { color: ${color}; dis|CURSOR| }`;')).items, 'display');
    });

    test('跨行 Vue 绑定和插值由原 Vue 提示链路负责', async () => {
        for (const source of ['const x = `<div\n :title="\nval|CURSOR|ue"></div>`;', 'const x = `<div>{{ val|CURSOR|ue }}</div>`;']) {
            const { document, position, items } = await complete(source);
            assert.deepStrictEqual(items, []);
            assert.ok(isEmbeddedVueExpression(document, position));
        }
    });

    test('Vue 插值中的比较符和 HTML 字符串不参与 HTML 词法诊断', async () => {
        const { document, items } = await complete('const x = `<div>{{ a < b ? "<b>" : "" }}</div><inp|CURSOR|>`;');
        expectItem(items, 'input');
        assert.deepStrictEqual(provider.provideDiagnostics(document), []);
    });

    test('新的服务不会和旧的硬编码标签/CSS 词表重复返回', async () => {
        const { document, position } = await open('const x = `<input place|CURSOR|>`;');
        const legacy = new JavaScriptCompletionProvider();
        const items = await legacy.provideCompletionItems(document, position, tokens.token, { triggerKind: vscode.CompletionTriggerKind.Invoke, triggerCharacter: undefined });
        assert.deepStrictEqual(items, []);
        assert.ok(getTemplateLiteralAtPosition(document, position));
    });

    test('静态 CSS 属性和 HTML 重复属性错误映射回模板', async () => {
        const { document } = await open('const x = `.a { colr: red; }`;\nconst y = `<input id="a" id="b">`;|CURSOR|');
        const diagnostics = provider.provideDiagnostics(document);
        assert.ok(diagnostics.some(item => item.source === '雷动内嵌 CSS' && document.getText(item.range) === 'colr'));
        assert.ok(diagnostics.some(item => item.source === '雷动内嵌 HTML' && document.getText(item.range) === 'id'));
    });

    test('HTML 词法错误和 style 属性内 CSS 诊断', async () => {
        const { document } = await open('const x = `<div id="x"" style="colr: red"></div>`;|CURSOR|');
        const diagnostics = provider.provideDiagnostics(document);
        assert.ok(diagnostics.some(item => item.source === '雷动内嵌 HTML'));
        assert.ok(diagnostics.some(item => document.getText(item.range) === 'colr'));
    });

    test('合法 Vue、自定义标签不误报；含插值和未闭合模板保守跳过诊断', async () => {
        const { document } = await open('const x = `<elp-input v-model="query" :disabled="busy" @change="reload" />`;\nconst y = `.a { colr: ${color}; }`;\nconst z = `.b { colr: red; |CURSOR|');
        assert.deepStrictEqual(provider.provideDiagnostics(document), []);
    });

    test('文档版本缓存复用，编辑后重新识别', async () => {
        const { document } = await open('const x = `<div>|CURSOR|</div>`;');
        const before = getEmbeddedTemplates(document);
        assert.strictEqual(getEmbeddedTemplates(document), before);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), 'const x = `.a { color:red }`;');
        await vscode.workspace.applyEdit(edit);
        assert.notStrictEqual(getEmbeddedTemplates(document), before);
        assert.strictEqual(getEmbeddedTemplates(document)[0].language, 'css');
    });

    test('超大文件快速跳过；取消请求不提供结果', async () => {
        assert.deepStrictEqual(parseEmbeddedTemplates(' '.repeat(MAX_EMBEDDED_DOCUMENT_LENGTH) + '`<div>`'), []);
        const { document, position } = await open('const x = `<di|CURSOR|>`;');
        const cancelled = new vscode.CancellationTokenSource();
        cancelled.cancel();
        try {
            assert.strictEqual(provider.provideCompletionItems(document, position, cancelled.token), undefined);
            assert.strictEqual(provider.provideHover(document, position, cancelled.token), undefined);
        } finally { cancelled.dispose(); }
    });

    test('实际注册的补全与悬停命令可在 JS 模板串使用', async function () {
        this.timeout(15000);
        await vscode.extensions.getExtension('KuCai.leidong-sanqian-vscode-tools')?.activate();
        const { document, position } = await open('const x = `.a { grid-template-col|CURSOR| }`;');
        const result = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, position);
        assert.ok(result.items.some(item => label(item) === 'grid-template-columns' && item.detail?.includes('雷动内嵌语言')));
        const hoverData = await open('const x = `.a { dis|CURSOR|play: grid; }`;');
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', hoverData.document.uri, hoverData.position);
        assert.ok(hovers.length > 0);
    });

    test('配置开关即时生效且与 Vue 开关独立', async function () {
        this.timeout(10000);
        const config = vscode.workspace.getConfiguration('leidong-tools');
        const previousFeature = config.inspect<boolean>('embeddedLanguageFeatures')?.globalValue;
        const previousDiagnostics = config.inspect<boolean>('embeddedLanguageDiagnostics')?.globalValue;
        const { document, position } = await open('const x = `.a { colr: red; dis|CURSOR| }`;');
        try {
            await config.update('embeddedLanguageDiagnostics', false, vscode.ConfigurationTarget.Global);
            assert.deepStrictEqual(provider.provideDiagnostics(document), []);
            expectItem(provider.provideCompletionItems(document, position, tokens.token)!.items, 'display');
            await config.update('embeddedLanguageFeatures', false, vscode.ConfigurationTarget.Global);
            assert.strictEqual(provider.provideCompletionItems(document, position, tokens.token), undefined);
            assert.strictEqual(provider.provideHover(document, position, tokens.token), undefined);
        } finally {
            await config.update('embeddedLanguageFeatures', previousFeature, vscode.ConfigurationTarget.Global);
            await config.update('embeddedLanguageDiagnostics', previousDiagnostics, vscode.ConfigurationTarget.Global);
        }
    });

    test('注册诊断在编辑修复后清除，防抖后不会重新出现', async function () {
        this.timeout(10000);
        const { document } = await open('const x = `.a { colr: red; }`;|CURSOR|');
        const ownDiagnostics = () => vscode.languages.getDiagnostics(document.uri).filter(item => item.source?.startsWith('雷动内嵌'));
        const waitUntil = async (condition: () => boolean) => {
            const deadline = Date.now() + 5000;
            while (!condition() && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); }
            assert.ok(condition(), '诊断状态未及时更新');
        };
        await waitUntil(() => ownDiagnostics().length > 0);
        const edit = new vscode.WorkspaceEdit();
        const start = document.getText().indexOf('colr');
        edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + 4)), 'color');
        await vscode.workspace.applyEdit(edit);
        await waitUntil(() => ownDiagnostics().length === 0);
        await new Promise(resolve => setTimeout(resolve, 450));
        assert.deepStrictEqual(ownDiagnostics(), []);
    });
});
