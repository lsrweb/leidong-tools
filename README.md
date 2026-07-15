<p align="center">
  <img src="logo.png" width="128" height="128" alt="logo">
</p>

<h1 align="center">雷动三千 VSCode 工具集</h1>


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



## 远程资源管理器（SFTP / FTP / FTPS）

### 远程终端

在 VS Code 的“新建终端”下拉菜单中选择“雷动远程终端”，即可选择已有的 SFTP/SSH 配置并打开交互式 SSH Shell。只有一个 SSH/SFTP 配置时会直接连接；打开后会自动进入该配置的 `remotePath`。FTP 与 FTPS 只支持文件传输，不能提供交互式终端。

远程终端会以灰色幽灵文本提示常用命令；在 `cd`、`ls`、`cat`、`vim`、`rm` 等命令后输入路径时，会读取当前远程目录并提示文件或子目录。按 <kbd>Tab</kbd> 接受当前建议；继续输入、退格、回车、移动光标或收到远端输出时会自动隐藏提示，灰色建议不会在接受前发送到服务器。

终端会按连接保存最近 100 条命令。可通过命令面板执行“在远程终端执行收藏/历史命令”；收藏命令使用 `leidong-tools.remoteTerminalFavoriteCommands` 配置。

### Copilot Chat 自定义端点（DeepSeek / MiMo）

需要 VS Code 1.116 或更高版本及 GitHub Copilot Chat。安装后，从命令面板运行“设置 MiMo API Key”或“设置 DeepSeek API Key”，密钥会保存在 VS Code 安全存储，不会写入项目的设置文件。随后在 Copilot Chat 的模型选择器中选择 `MiMo V2.5 Pro`、`MiMo V2.5` 或 DeepSeek V4 模型即可使用。

MiMo 默认使用 **TokenPlan 中国区** OpenAI 兼容地址 `https://token-plan-cn.xiaomimimo.com/v1`。先运行“设置 MiMo TokenPlan API Key”保存以 `tp-` 开头的专属密钥；设置 `leidong-tools.copilot.mimoTokenPlanRegion` 可改为 `sgp`（新加坡）或 `ams`（欧洲）。如需按量计费，将 `leidong-tools.copilot.mimoAccessMode` 改为 `payAsYouGo`，然后保存 `sk-` 密钥。两类密钥独立，不能混用。代理或新模型名称可通过 `mimoModelIdOverrides` 覆盖，例如：

```json
{
  "leidong-tools.copilot.mimoModelIdOverrides": {
    "mimo-v2.5-pro": "mimo-v2.5-pro"
  }
}
```

CSS class 补全会在提示详情中显示该 class 的来源及 CSS 声明内容；同名 class 存在多处定义时会展示多个来源，便于确认样式实际内容。本地 `<link rel="stylesheet">` 外部 CSS 默认不索引，开启 `leidong-tools.cssIndexLinkCssEnabled` 后才会读取；单个 CSS 默认超过 2000 行会跳过并在右下角提示，可通过 `leidong-tools.cssIndexMaxFileLines` 调整阈值。索引会在打开或切换文件时后台预热，并只在相关文件变更时失效重建。

本地文件右键提供“比较本地与远程文件”和“同步当前文件（比较后选择）”：前者可打开 VS Code 原生差异编辑器，后者先显示大小与修改时间，再由你明确选择上传覆盖或下载覆盖。远端不存在时会提示可直接上传。

默认 `.vscode/sftp.json` 带有字段补全和校验；多连接可通过命令面板“测试全部远程连接”批量诊断。

扩展侧边栏提供 **远程资源** 视图，支持远程目录浏览、文件预览、上传、下载、新建目录、重命名和删除。默认读取当前工作区的 `.vscode/sftp.json`，配置既可以是单个对象，也可以是多个配置组成的数组：

远程资源按“工作区 → 连接 → 目录/文件”分组。文本文件可直接在编辑器中修改并保存回原服务器；图片和二进制文件使用 VS Code 原生预览。右键菜单提供连接测试、断开、刷新、上传、下载、新建目录、重命名、删除和复制远程路径等完整操作。

```json
[
    {
        "name": "ku",
        "host": "xxxx",
        "protocol": "sftp",
        "port": 22,
        "username": "xxxxx",
        "password": "xxxxx",
        "remotePath": "/Data",
        "uploadOnSave": true
    }
]
```

需要读取多个 JSON 文件时，在工作区设置中配置 `leidong-tools.remoteConfigFiles`。保存文件时，本地相对工作区的路径会映射到 `remotePath`；多个配置启用 `uploadOnSave` 时，可在连接节点上选择“选择保存自动上传目标”。

底部状态栏会显示连接、上传和下载进度；点击状态项可打开“远程资源”输出面板，查看连接、上传下载及错误日志。默认不输出 SSH 数据包等底层噪声；排查协议问题时可临时启用 `leidong-tools.remoteVerboseProtocolLogging`。FTP 的 `PASS` 密码会在详细日志中自动隐藏。

同一配置会复用已建立的连接，操作按顺序排队，不会每次保存都重新握手。连接默认空闲 60 秒后关闭，可通过 `leidong-tools.remoteConnectionIdleTimeout` 调整；连接异常时会释放，并在下次操作自动重连。

状态栏按“空闲 → Loading → 成功 → 1 秒后空闲”切换。连续保存会进行 300ms 防抖；上传期间再次保存时，只追加最后一次变更，不堆积重复版本。

远程目录按需读取并使用固定行高虚拟滚动，只渲染可视区域；目录结果进入容量受限的 LRU 缓存，折叠后再次展开无需重复请求。

存在多个 `uploadOnSave: true` 配置时，执行“选择保存自动上传目标”可多选一个或多个服务器；全选即可保存后同时上传到全部配置，清空选择则关闭该工作区的自动上传。

- `protocol`: 支持 `sftp`、`ssh`、`ftp`、`ftps`。
- SFTP/SSH 支持 `privateKey`（相对工作区或绝对路径）和可选的 `passphrase`。
- FTPS 默认使用显式 TLS；设置 `secure: "implicit"` 使用隐式 TLS（默认端口 990）。自签名证书可设置 `rejectUnauthorized: false`。
- FTP/FTPS 使用被动模式，普通 FTP 不加密用户名、密码和文件内容，公网连接建议使用 SFTP 或 FTPS。

远程资源目录支持右键分别选择“上传文件”或“上传文件夹”；VS Code 本地资源管理器也会根据右键目标显示对应上传命令。

本地编辑器和资源管理器中的文件右键菜单同时提供“下载文件”“上传文件”“备份并上传文件”。备份并上传会先把远端目标文件改名为 `xxx.dis`，再上传当前本地文件到原路径；如果 `.dis` 已存在，会自动使用带时间戳的 `.dis` 备份名，避免覆盖旧备份。

上传过滤设置：

- `leidong-tools.remoteUploadExcludedExtensions`：按扩展名排除，例如 `map`、`log`、`tmp`。
- `leidong-tools.remoteUploadExcludeRegex`：使用正则匹配工作区相对路径，例如 `(^|/)node_modules/`、`\\.min\\.js$`。规则同时作用于手动上传、文件夹递归上传和保存自动上传。
- `leidong-tools.remoteUploadOnSaveEnabled`：保存自动上传总开关。也可在远程资源面板顶部直接切换。

<p align="center">
  <strong>专为 Vue 2 CDN / 非工程化项目打造的智能开发体验</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=KuCai.leidong-sanqian-vscode-tools"><img src="https://img.shields.io/badge/VS%20Code-Marketplace-007ACC?logo=visual-studio-code&logoColor=white" alt="Marketplace"></a>
  <img src="https://img.shields.io/badge/version-2.6.4-5c63d8.svg?style=flat" alt="Version">
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
| `indexLogging` | `false` | 索引调试日志，默认关闭以降低 Extension Host 开销 |
| `indexBuildMode` | `"manual"` | Vue 索引构建时机：手动 / 保存 / 定时 |
| `indexBuildIntervalMinutes` | `10` | 定时构建模式下的间隔分钟数 |
| `rebuildOnSave` | `false` | 旧配置，建议改用 `indexBuildMode` |
| `maxIndexEntries` | `200` | Vue 索引 LRU 缓存上限 |
| `maxTemplateIndexEntries` | `300` | 模板索引 LRU 缓存上限 |
| `cssIndexLinkCssEnabled` | `false` | CSS 快速索引是否读取当前 HTML 中 link 引入的本地 CSS；默认关闭 |
| `cssIndexMaxFileLines` | `2000` | CSS 自动索引单文件行数上限；超过时跳过并提示，`0` 表示不限制 |
| `cssIndexExtraPaths` | `[]` | 额外参与 CSS 索引的文件、目录或 glob，支持绝对路径、工作区相对路径、`${workspaceFolder}`、`${fileDir}` |
| `cssIndexExcludePatterns` | `[]` | CSS 索引排除规则，支持路径/文件名片段或正则，例如 `layui\\.css$` |
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
  // CSS 快速索引：默认无需配置即可读取当前 HTML 的 <style>
  "leidong-tools.cssIndexLinkCssEnabled": false,
  "leidong-tools.cssIndexMaxFileLines": 2000,
  "leidong-tools.cssIndexExtraPaths": [
    "${workspaceFolder}/common/css",
    "theme/**/*.css"
  ],
  "leidong-tools.cssIndexExcludePatterns": [
    "layui\\.css$",
    "(^|/)vendor/"
  ],
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
