import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildVueIndexForContent } from '../parsers/parseDocument';

/**
 * VueIndex 解析器测试：Vue2 Options API 与 Vue3 Composition API（CDN 场景）全覆盖。
 *
 * 门禁：发布前必须 `npm test` 通过（测试失败不允许发布）。
 */
suite('VueIndex Parser', () => {
    const uri = vscode.Uri.parse('file:///test/example.html');

    test('Vue2 Options API：data/methods/computed 索引', () => {
        const index = buildVueIndexForContent(
            `new Vue({
  data() { return { title: 'hello', count: 0 } },
  methods: { handleClick() {} },
  computed: { doubled() { return this.count * 2 } }
})`,
            uri,
            0,
        );
        assert.ok(index.data.has('title'), 'data.title 缺失');
        assert.ok(index.data.has('count'), 'data.count 缺失');
        assert.ok(index.methods.has('handleClick'), 'methods.handleClick 缺失');
        assert.ok(index.computed.has('doubled'), 'computed.doubled 缺失');
        assert.ok(index.all.has('title'), 'all 合并缺失 title');
    });

    test('Vue3 createApp setup：ref/reactive/computed/常量/函数全量收录', () => {
        const index = buildVueIndexForContent(
            `const { createApp, ref, reactive, computed, onMounted } = Vue3
const app = createApp({
  setup() {
    const isTipsExpand = ref(true) // 功能须知展开状态
    const searchForm = reactive({
      keyword: '', // 搜索关键词
      online: '' // 在线状态筛选
    })
    const tableData = ref([])
    const DEVICE_TYPE = 'rpa'
    const doubleCount = computed(() => 0)
    const handleSearch = () => {}
    function loadData() {}
    onMounted(() => {})
    return { isTipsExpand, searchForm, tableData, doubleCount, handleSearch, loadData }
  }
}).mount('#app')`,
            uri,
            0,
        );
        // 基础收录
        assert.ok(index.data.has('isTipsExpand'), 'ref 变量缺失');
        assert.ok(index.data.has('searchForm'), 'reactive 变量缺失');
        assert.ok(index.data.has('tableData'), 'ref([]) 缺失');
        assert.ok(index.data.has('DEVICE_TYPE'), '未 return 常量应进 data');
        assert.ok(index.methods.has('handleSearch'), '箭头函数应进 methods');
        assert.ok(index.methods.has('loadData'), 'function 声明应进 methods');
        assert.ok(index.computed.has('doubleCount'), 'computed 变量应进 computed');
        assert.ok(index.lifecycle.has('onMounted'), 'onMounted 生命周期缺失');
        // reactive 对象属性（完整链，模板 searchForm.online 跳转）
        assert.ok(index.data.has('searchForm.keyword'), 'reactive 属性 keyword 缺失');
        assert.ok(index.data.has('searchForm.online'), 'reactive 属性 online 缺失');
        // 注释 meta
        assert.strictEqual(index.dataMeta.get('isTipsExpand')?.doc, '功能须知展开状态', 'ref 行尾注释缺失');
        assert.strictEqual(index.dataMeta.get('searchForm.keyword')?.doc, '搜索关键词', 'reactive 属性注释缺失');
        // reactive 类型显示为对象
        assert.strictEqual(index.dataMeta.get('searchForm')?.initType, 'Object', 'reactive 应显示对象类型');
        // 跳转落点：isTipsExpand → const 声明行（相对脚本第 4 行）
        const loc = index.data.get('isTipsExpand');
        assert.ok(loc, 'isTipsExpand 位置缺失');
        assert.strictEqual(loc.range.start.line, 3, '跳转落点应为 const 声明行');
    });

    test('Vue3 setup 返回函数分类（不误入 data）', () => {
        const index = buildVueIndexForContent(
            `createApp({
  setup() {
    const openSingleScreenshot = (row) => { return row }
    const searchForm = reactive({ keyword: '', online: '' })
    return { openSingleScreenshot, searchForm }
  }
})`,
            uri,
            0,
        );
        assert.ok(index.methods.has('openSingleScreenshot'), '箭头函数应进 methods 而非 data');
        assert.ok(!index.data.has('openSingleScreenshot'), '函数不应出现在 data');
        assert.ok(index.data.has('searchForm'), 'reactive 对象应进 data');
    });

    test('Vue3 createApp 三种调用形式', () => {
        for (const prefix of ['createApp', 'Vue.createApp', 'Vue3.createApp']) {
            const index = buildVueIndexForContent(
                `${prefix}({
  setup() {
    const title = ref('x')
    return { title }
  }
})`,
                uri,
                0,
            );
            assert.ok(index.data.has('title'), `${prefix} 形式未识别`);
        }
    });

    test('Vue2 与 Vue3 混合页面（页面含旧组件与 createApp）', () => {
        const index = buildVueIndexForContent(
            `new Vue({
  data() { return { legacyTitle: 'old' } },
  methods: { legacyFn() {} }
})
const { createApp, ref } = Vue3
createApp({
  setup() {
    const modernCount = ref(0)
    return { modernCount }
  }
}).mount('#app')`,
            uri,
            0,
        );
        assert.ok(index.data.has('legacyTitle'), 'Vue2 data 缺失');
        assert.ok(index.methods.has('legacyFn'), 'Vue2 methods 缺失');
        assert.ok(index.data.has('modernCount'), 'Vue3 setup 变量缺失');
    });
});
