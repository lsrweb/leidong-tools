import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Vue 快捷代码块：
 * - 组件模板（v2comp / v3comp）：Vue2 / Vue3 标准 JS 组件（IIFE 自包含 + 样式注入 + data/setup + template），所有 JS/TS 文件可用；
 * - 页面模板（v3page / v3setup / v3ref / v3reactive / v3computed / v3fn）：仅 .dev.js 页面可用（CDN 写法：Vue3.createApp + EPS.ElementPlus）。
 * 触发方式：输入 v2 / v3 前缀（或 Ctrl+Space）。
 */
export class Vue3SnippetCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.CompletionItem[] {
        if (token.isCancellationRequested) { return []; }
        const textBefore = document.lineAt(position).text.substring(0, position.character);
        const match = /(?:^|[^A-Za-z0-9_$])(v[23][a-z]*)$/.exec(textBefore);
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
        const items: vscode.CompletionItem[] = [];
        // ---- 组件模板：所有 JS/TS 文件可用（assets/js 下的自包含组件，如 messageDialog.js） ----
        items.push(
            make('Vue2 JS 组件 (v2comp)', 'v2comp', 'Vue2 标准 JS 组件（样式注入 + data/methods/template）', [
                '/**',
                ' * 自定义组件 - ${1:说明}',
                ' * 兼容性：vue2 + element-ui',
                ' * 全局组件名：${2:name}',
                ' */',
                '(function (window, document) {',
                '\t\'use strict\';',
                '',
                '\t// ---------- 样式：脚本内注入，保证组件自包含（仅注入一次） ----------',
                '\tvar STYLE_ID = \'${2:name}-style\';',
                '\tvar STYLE_TEXT = `',
                '\t\t.${2:name} {',
                '\t\t}',
                '\t`;',
                '\tif (!document.getElementById(STYLE_ID)) {',
                '\t\tvar styleElement = document.createElement(\'style\');',
                '\t\tstyleElement.id = STYLE_ID;',
                '\t\tstyleElement.type = \'text/css\';',
                '\t\tstyleElement.textContent = STYLE_TEXT;',
                '\t\tdocument.head.appendChild(styleElement);',
                '\t}',
                '',
                '\twindow.${3:ComponentName} = {',
                '\t\tname: \'${2:name}\',',
                '\t\tdata() {',
                '\t\t\treturn {',
                '\t\t\t\t${4:visible}: false, // ${5:显示状态}',
                '\t\t\t};',
                '\t\t},',
                '\t\tcomputed: {',
                '\t\t\t// ${6:计算属性说明}',
                '\t\t\t${7:computedValue}() {',
                '\t\t\t\treturn this.${4:visible};',
                '\t\t\t},',
                '\t\t},',
                '\t\twatch: {},',
                '\t\tbeforeDestroy() {},',
                '\t\tmethods: {',
                '\t\t\t// 打开组件',
                '\t\t\topen() {',
                '\t\t\t\tthis.${4:visible} = true;',
                '\t\t\t},',
                '\t\t\t// 关闭组件',
                '\t\t\tclose() {',
                '\t\t\t\tthis.${4:visible} = false;',
                '\t\t\t},',
                '\t\t},',
                '\t\ttemplate: `',
                '\t\t\t<div class="${2:name}" v-if="${4:visible}"></div>',
                '\t\t`,',
                '\t};',
                '})(window, document);',
            ], '0010'),
            make('Vue3 JS 组件 (v3comp)', 'v3comp', 'Vue3 标准 JS 组件（setup + 样式注入 + template）', [
                '/**',
                ' * 自定义组件 - ${1:说明}',
                ' * 兼容性：vue3 (CDN)',
                ' * 用法：app.component(\'${2:name}\', window.${3:ComponentName})',
                ' */',
                '(function (window, document) {',
                '\t\'use strict\';',
                '',
                '\tconst ref = Vue3.ref;',
                '\tconst computed = Vue3.computed;',
                '',
                '\t// ---------- 样式：脚本内注入，保证组件自包含（仅注入一次） ----------',
                '\tconst STYLE_ID = \'${2:name}-style\';',
                '\tconst STYLE_TEXT = `',
                '\t\t.${2:name} {',
                '\t\t}',
                '\t`;',
                '\tif (!document.getElementById(STYLE_ID)) {',
                '\t\tconst styleElement = document.createElement(\'style\');',
                '\t\tstyleElement.id = STYLE_ID;',
                '\t\tstyleElement.type = \'text/css\';',
                '\t\tstyleElement.textContent = STYLE_TEXT;',
                '\t\tdocument.head.appendChild(styleElement);',
                '\t}',
                '',
                '\twindow.${3:ComponentName} = {',
                '\t\tname: \'${2:name}\',',
                '\t\tprops: {},',
                '\t\tsetup(props, { emit }) {',
                '\t\t\tconst ${4:visible} = ref(false); // ${5:显示状态}',
                '\t\t\tconst ${6:computedValue} = computed(() => ${4:visible}.value); // ${7:计算属性说明}',
                '\t\t\t// 打开组件',
                '\t\t\tconst open = () => {',
                '\t\t\t\t${4:visible}.value = true;',
                '\t\t\t};',
                '\t\t\t// 关闭组件',
                '\t\t\tconst close = () => {',
                '\t\t\t\t${4:visible}.value = false;',
                '\t\t\t};',
                '\t\t\treturn { ${4:visible}, ${6:computedValue}, open, close };',
                '\t\t},',
                '\t\ttemplate: `',
                '\t\t\t<div class="${2:name}" v-if="${4:visible}"></div>',
                '\t\t`,',
                '\t};',
                '})(window, document);',
            ], '0011'),
        );
        // ---- 页面模板：仅 .dev.js 页面可用 ----
        if (path.basename(document.uri.fsPath).toLowerCase().endsWith('.dev.js')) {
            items.push(
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
            );
        }
        return items;
    }
}
