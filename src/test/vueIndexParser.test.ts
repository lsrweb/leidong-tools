import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildVueIndexForContent, looksLikeVueDocument } from '../parsers/parseDocument';

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

    test('Vue3 setup：上方 // 注释作为 return 项的 doc（遇到 #region 停止收集）', () => {
        const index = buildVueIndexForContent(
            `createApp({
  setup() {
    // 同步子账号选中项
    const handleAccountSelection = (rows) => { return rows }
    // #region 统计
    // 子账号可见素材数量
    const subCount = ref(0)
    const noDoc = ref(1)
    return { handleAccountSelection, subCount, noDoc }
  }
})`,
            uri,
            0,
        );
        assert.strictEqual(index.methodMeta.get('handleAccountSelection')?.doc, '同步子账号选中项', '函数上方注释缺失');
        assert.strictEqual(index.dataMeta.get('subCount')?.doc, '子账号可见素材数量', '常量上方注释应跳过 #region 标记');
        assert.strictEqual(index.dataMeta.get('noDoc')?.doc, undefined, '无注释不应产生 doc');
    });

    test('Vue3 setup：多行声明结尾行的行尾注释也能作为 doc', () => {
        const index = buildVueIndexForContent(
            `createApp({
  setup() {
    const fileTypeIcons = {
      xls: 'xls.png'
    }; // 文件后缀对应图标
    return { fileTypeIcons }
  }
})`,
            uri,
            0,
        );
        assert.strictEqual(index.dataMeta.get('fileTypeIcons')?.doc, '文件后缀对应图标', '多行声明结尾行注释缺失');
    });

    test('Vue2 data：属性上方的 // 注释作为 doc', () => {
        const index = buildVueIndexForContent(
            `new Vue({
  data() {
    return {
      // 标题文案
      title: 'hello',
      count: 0 // 计数
    }
  }
})`,
            uri,
            0,
        );
        assert.strictEqual(index.dataMeta.get('title')?.doc, '标题文案', 'data 属性上方注释缺失');
        assert.strictEqual(index.dataMeta.get('count')?.doc, '计数', 'data 属性行尾注释缺失');
    });

    test('Vue-like 组件对象（window.x = {...}）收录 data/methods/computed', () => {
        const index = buildVueIndexForContent(
            `(function (window, document) {
  window.iyunzk_message_dialog = {
    name: 'iyunzk_message_dialog',
    data() {
      return {
        dialog: false, // 弹窗开关
        title: '',
      }
    },
    computed: {
      // 当前类型配置
      popupType() { return {} }
    },
    methods: {
      // 打开弹窗
      openDialog(item) {},
      closeDialog() {},
    },
    template: \`<div class="message-popup"></div>\`,
  };
})(window, document);`,
            uri,
            0,
        );
        assert.ok(index.data.has('dialog'), '组件 data 应被收录');
        assert.strictEqual(index.dataMeta.get('dialog')?.doc, '弹窗开关', 'data 行尾注释缺失');
        assert.ok(index.methods.has('openDialog'), '组件 methods 应被收录');
        assert.ok(index.computed.has('popupType'), '组件 computed 应被收录');
    });

    test('looksLikeVueDocument：页面/组件识别与超大文件跳过', () => {
        assert.ok(looksLikeVueDocument('anything', 'E:/x/index.dev.js'), '.dev.js 应识别');
        assert.ok(looksLikeVueDocument('const app = createApp({});', 'E:/x/a.js'), 'createApp 应识别');
        assert.ok(looksLikeVueDocument('window.Vue.extend({})', 'E:/x/b.js'), 'Vue.extend 应识别');
        assert.ok(looksLikeVueDocument("window.x = { data() {}, methods: {}, template: '' }", 'E:/x/c.js'), 'Vue-like 组件对象应识别');
        assert.ok(looksLikeVueDocument('new Vue({})', 'E:/x/e.js'), 'new Vue 应识别');
        assert.ok(!looksLikeVueDocument('const a = 1; export default a;', 'E:/x/d.js'), '普通 JS 不应识别');
        assert.ok(!looksLikeVueDocument(`createApp(${'x'.repeat(600001)}`, 'E:/x/big.js'), '超大文件不应识别');
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
