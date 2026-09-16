import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Vue3 页面（.dev.js）框架快捷代码块：输入 `v3` 前缀快速生成项目标准结构。
 * 仅在 .dev.js 文件中生效（CDN 写法：Vue3.createApp + EPS.ElementPlus）。
 */
export class Vue3SnippetCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.CompletionItem[] {
        if (token.isCancellationRequested) { return []; }
        if (!path.basename(document.uri.fsPath).toLowerCase().endsWith('.dev.js')) { return []; }
        const textBefore = document.lineAt(position).text.substring(0, position.character);
        const match = /(?:^|[^A-Za-z0-9_$])(v3[a-z]*)$/.exec(textBefore);
        if (!match) { return []; }
        const range = new vscode.Range(position.translate(0, -match[1].length), position);
        const make = (label: string, prefix: string, detail: string, body: string[], sort: string): vscode.CompletionItem => {
            const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
            item.detail = `雷动三千 · ${detail}`;
            item.insertText = new vscode.SnippetString(body.join('\n'));
            item.filterText = prefix;
            item.sortText = sort;
            item.range = range;
            return item;
        };
        return [
            make('Vue3 页面完整框架 (v3page)', 'v3page', 'Vue3 页面框架（依赖引入 + createApp + 挂载）', [
                'const computed = Vue3.computed;',
                'const createApp = Vue3.createApp;',
                'const onMounted = Vue3.onMounted;',
                'const nextTick = Vue3.nextTick;',
                'const reactive = Vue3.reactive;',
                'const ref = Vue3.ref;',
                'const watch = Vue3.watch;',
                'const ElMessage = EPS.ElMessage;',
                'const ElMessageBox = EPS.ElMessageBox;',
                '',
                'const app = createApp({',
                '\tsetup: function () {',
                '\t\t${1}',
                '\t\treturn {',
                '\t\t};',
                '\t},',
                '});',
                '',
                'app.use(ElementPlus);',
                'if (!app.component("ElpQuery")) app.component("ElpQuery", EPS.ElQuery);',
                'if (!app.component("ElpQueryItem")) app.component("ElpQueryItem", EPS.ElQueryItem);',
                'app.component("comm-tips", window.CommTipsVue3);',
                'app.mount("#${2:app-id}");',
            ], '0001'),
            make('Vue3 createApp + setup (v3setup)', 'v3setup', 'Vue3 createApp/setup 骨架', [
                'const app = createApp({',
                '\tsetup: function () {',
                '\t\t$0',
                '\t\treturn {',
                '\t\t};',
                '\t},',
                '});',
            ], '0002'),
            make('ref 变量 (v3ref)', 'v3ref', 'ref 变量声明', [
                'const ${1:name} = ref(${2:null}); // ${3:说明}',
            ], '0003'),
            make('reactive 变量 (v3reactive)', 'v3reactive', 'reactive 对象声明', [
                'const ${1:name} = reactive({',
                '\t${2:field}: ${3:""}, $0',
                '}); // ${4:说明}',
            ], '0004'),
            make('computed 计算属性 (v3computed)', 'v3computed', 'computed 计算属性', [
                'const ${1:name} = computed(() => {',
                '\t$0',
                '}); // ${2:说明}',
            ], '0005'),
            make('方法 (v3fn)', 'v3fn', '函数/方法声明', [
                'const ${1:name} = (${2:params}) => {',
                '\t$0',
                '}; // ${3:说明}',
            ], '0006'),
        ];
    }
}
