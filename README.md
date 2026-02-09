<p align="center">
  <img src="logo.png" width="128" height="128" alt="logo">
</p>

<h1 align="center">雷动三千 VSCode 工具集</h1>

<p align="center">
  <strong>专为 Vue 2 CDN / 非工程化项目打造的智能开发体验</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=KuCai.leidong-sanqian-vscode-tools"><img src="https://img.shields.io/badge/VS%20Code-Marketplace-007ACC?logo=visual-studio-code&logoColor=white" alt="Marketplace"></a>
  <img src="https://img.shields.io/badge/version-2.1.10-5c63d8.svg?style=flat" alt="Version">
  <img src="https://img.shields.io/badge/vue-2.x%20CDN-42b883.svg?logo=vue.js&logoColor=white" alt="Vue 2">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License">
</p>

<p align="center">
  <a href="#-核心亮点">核心亮点</a> ·
  <a href="#-功能速览">功能速览</a> ·
  <a href="#️-配置项">配置项</a> ·
  <a href="#-快捷键">快捷键</a> ·
  <a href="CHANGELOG.md">更新日志</a>
</p>

---

## 💡 解决什么问题？

在传统的 **CDN 引入 Vue 2** 项目中（搭配 PHP / Layui / 原生 HTML），你写的代码大概长这样：

```html
<script src="https://cdn.jsdelivr.net/npm/vue@2/dist/vue.js"></script>
<script>
new Vue({
  el: '#app',
  data: { userName: '' },
  methods: {
    handleClick() { /* 几千行之后... */ }
  }
})
</script>
```

**痛点**：没有 `.vue` 单文件组件 → 没有跳转 → 没有提示 → 没有高亮 → 只能全局搜索 😩

**这个插件就是为了解决这些问题。**

---

## ✨ 核心亮点

<table>
<tr>
<td width="50%">

### 🔍 定义跳转 (F12)
在 HTML 模板中按 <kbd>F12</kbd>，直接跳转到 JS 中 `data` / `methods` / `computed` / `props` / `mixins` 的定义位置。

支持 `this.xxx` · `that.xxx` · `v-for` 局部变量

</td>
<td width="50%">

### 📝 模板字符串增强
JS 文件中 `template: \`...\`` 内自动启用：
- ✅ HTML **语法高亮**
- ✅ **Emmet** 缩写补全
- ✅ Vue 变量 **智能提示**
- ✅ props / data / methods **跳转**

</td>
</tr>
<tr>
<td>

### ⚡ .log 极速日志
输入 `xxx.log` 自动展开为：
```
console.log('file.js:10 xxx:', xxx)
```
自带文件名 + 行号，还支持 `.err` `.warn` `.info` `.dbg`

</td>
<td>

### 📊 侧边栏大纲
在活动栏打开「雷动三千工具」面板：
- 📋 **变量索引** — Data / Methods / Computed / Props 分类展示，点击跳转
- 👁️ **监听服务** — 管理所有 HTML→JS 文件监听
- 🔧 **诊断面板** — 缓存状态 & 性能分析

</td>
</tr>
</table>

---

## 📦 功能速览

### 1. 🔍 Vue 2 智能跳转

> 从 HTML 模板中的变量名，一键跳到 JS 中的定义。

```html
<div @click="handleClick">{{ userName }}</div>
<!--         ↑ F12 跳转        ↑ F12 跳转     -->
```

| 能力 | 说明 |
|:-----|:-----|
| **data / methods / computed** | 完整支持 Options API 全部选项 |
| **props** | 数组 · 对象简写 · 含 type/default/required |
| **mixins** | 自动递归解析 mixin 内定义 |
| **v-for / slot-scope** | 模板内局部变量优先识别 |
| **this. / that.** | 智能识别 Vue 实例别名 |
| **悬停提示** | 显示类型标签（Prop / Data / Method…）及 JSDoc 注释 |
| **外部脚本** | 自动查找 `js/<name>.dev.js`，支持自定义路径模式 |
| **Vue-like 对象** | 自动识别 `const comp = { data(), methods: {} }` 形式 |

---

### 2. 📝 JS 模板字符串 HTML 增强

> 在 `template: \`...\`` 内写 HTML 就像在 `.html` 文件中一样。

```javascript
const myComponent = {
  props: { title: String },
  data() { return { count: 0 } },
  methods: { increment() { this.count++ } },
  template: `
    <div class="card">
      <!--  ↑ 完整 HTML 语法高亮 -->
      <h1>{{ title }}</h1>
      <!--       ↑ F12 跳转到 props -->
      <button @click="increment">{{ count }}</button>
      <!--           ↑ 自动补全 methods      ↑ F12 跳转到 data -->
    </div>
  `
}
```

- **语法高亮** — TextMate Grammar 注入，反引号内原生 HTML 着色
- **Emmet** — `div.card>h1+p` + <kbd>Tab</kbd> 直接展开
- **智能提示** — `v-if="` `@click="` `{{ }}` 内自动提示组件成员
- **定义跳转** — 模板内的 props / data / methods 变量直接 <kbd>F12</kbd>

---

### 3. ⚡ .log 智能日志补全

> 输入变量名 + `.log`，自动生成带文件名和行号的日志语句。

```javascript
userName.log    →  console.log('index.js:42 userName:', userName)
userName.err    →  console.error('index.js:42 userName:', userName)
userName.warn   →  console.warn('index.js:42 userName:', userName)
'hello'.log     →  console.log('hello')
```

- 优先级高于内置补全，触发即预选
- 支持链式属性：`obj.prop.log`
- 支持字符串字面量：`'text'.log`
- 灵感来源：[jaluik/dot-log](https://github.com/jaluik/dot-log) (MIT)

---

### 4. 👁️ HTML → JS 文件监听

> 编辑 HTML 并保存，自动将内容同步到 JS 文件中的指定变量。

```
my-project/
  └── dev/
      ├── index.html   ← 编辑这个
      └── index.js     ← 自动更新 var html = '...'
```

- 右键文件夹 → 「启动 HTML→JS 文件监听」
- 变量名可配置（`html` / `dom` / 自定义正则）
- 支持多项目批量监听
- 侧边栏面板可视化管理（暂停 / 恢复 / 停止）
- 详细文档：[docs/file-watch-usage.md](docs/file-watch-usage.md)

---

### 5. 🗜️ 多行代码压缩

> 选中代码 → 右键 → 「Compress Multiple Lines」

支持 HTML / JS / CSS / JSON，自动移除注释和空行。

---

### 6. 🔧 更多小工具

| 功能 | 触发方式 | 说明 |
|:-----|:---------|:-----|
| Von 时间戳 | 输入 `von` | 插入 `YYYYMMDDHHMMSS` 格式时间 |
| Von UUID | 输入 `von` | 生成随机唯一标识符 |
| 变量注释 | <kbd>Ctrl+Alt+/</kbd> | 为光标处变量生成注释模板 |
| 性能报告 | 命令面板 | 查看各操作耗时统计 |

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
|:-------|:-----|
| <kbd>Ctrl+L</kbd> | 快速 console.log（光标处变量） |
| <kbd>Ctrl+E</kbd> | 快速 console.error（光标处变量） |
| <kbd>Ctrl+Shift+L</kbd> | 选中变量 → 下一行 console.log |
| <kbd>Ctrl+Alt+L</kbd> | 备选 console.log |
| <kbd>Ctrl+Alt+E</kbd> | 备选 console.error |
| <kbd>Ctrl+Alt+/</kbd> | 为变量添加注释 |

---

## ⚙️ 配置项

在 VSCode 设置中搜索 `leidong-tools`：

| 配置项 | 默认值 | 说明 |
|:-------|:-------|:-----|
| `enableDefinitionJump` | `true` | 启用 / 禁用定义跳转 |
| `indexLogging` | `true` | 索引调试日志 |
| `rebuildOnSave` | `true` | 保存时重建索引 |
| `maxIndexEntries` | `200` | Vue 索引 LRU 缓存上限 |
| `maxTemplateIndexEntries` | `300` | 模板索引 LRU 缓存上限 |
| `devScriptPatterns` | `[]` | 自定义 dev.js 路径模式，支持 `${dir}` `${base}` |
| `watchHtmlVariableName` | `"html"` | 文件监听替换的变量名 |
| `watchHtmlVariablePattern` | `""` | 自定义替换正则（高级） |
| `hoverDelay` | `300` | 悬停延迟（ms） |

<details>
<summary><b>📋 配置示例</b></summary>

```jsonc
{
  // 自定义脚本查找路径（多个模式会合并索引）
  "leidong-tools.devScriptPatterns": [
    "${dir}/js/${base}.dev.js",
    "${dir}/scripts/${base}.js"
  ],
  // 关闭调试日志（生产环境推荐）
  "leidong-tools.indexLogging": false,
  // 文件监听使用 dom 变量名
  "leidong-tools.watchHtmlVariableName": "dom"
}
```

</details>

---

## 🛠️ 命令面板

按 <kbd>Ctrl+Shift+P</kbd>，输入「雷动三千」或命令名称：

| 命令 | 说明 |
|:-----|:-----|
| Toggle Definition Jump | 开关跳转功能 |
| Toggle Index Logging | 开关调试日志 |
| Clear Vue Index Cache | 清除索引缓存 |
| Show Index Summary | 查看当前索引状态 |
| Show Performance Report | 性能报告 |
| 启动 HTML→JS 文件监听 | 右键文件夹或命令面板均可 |
| 查看/管理文件监听列表 | 管理所有监听服务 |

---

## 🏗️ 项目结构

```
src/
├── parsers/       # Babel AST 解析 · Vue 索引构建
├── finders/       # 定义查找 · 模板变量索引
├── providers/     # 跳转 / 悬停 / 补全 Provider
├── helpers/       # 模板字符串检测 · Vue 辅助
├── managers/      # 文件监听 · 索引生命周期
├── cache/         # LRU 缓存
├── monitoring/    # 性能监控 (@monitor 装饰器)
├── tools/         # 日志 · 压缩 · 注释
├── core/          # 命令注册 · Provider 注册 · 配置
└── errors/        # 统一错误处理
```

---

## 🔧 技术栈

| 技术 | 用途 |
|:-----|:-----|
| **TypeScript** | 类型安全 |
| **Babel** (`@babel/parser` + `@babel/traverse`) | AST 解析，`errorRecovery` 兼容 PHP/Layui 混合模板 |
| **TextMate Grammar** | 模板字符串 HTML 语法注入 |
| **Webpack** | 打包构建 |
| **LRU Cache** | 高性能索引缓存 |

---

## 📌 已知限制

- 仅支持 **Vue 2 Options API**（不支持 Composition API / Vue 3）
- 不支持 `.vue` 单文件组件的复杂场景
- PHP / Layui 混合模板中严重语法错误可能影响解析精度

---

## 🤝 致谢

- [jaluik/dot-log](https://github.com/jaluik/dot-log) — .log 补全灵感 (MIT)
- [Babel](https://babeljs.io/) — AST 解析
- [VSCode Extension API](https://code.visualstudio.com/api)

---

## 📄 License

[MIT](LICENSE) © 2025 雷动三千 (KuCai)

---

## 💬 反馈与交流

- 🐛 **Bug 反馈 / 功能建议**：[GitHub Issues](https://github.com/lsrweb/leidong-tools/issues)
- 📧 **邮件联系**：[siriforever.ltd@gmail.com](mailto:siriforever.ltd@gmail.com)
- 🌟 **本扩展还在持续维护更新中, 如果你有更好的建议，欢迎提 Issue 或 PR！**

---

<p align="center">
  <sub>如果对你有帮助，欢迎在 <a href="https://github.com/lsrweb/leidong-tools">GitHub</a> 点个 ⭐</sub>
</p>
