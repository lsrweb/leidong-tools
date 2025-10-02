# 更新日志 (Changelog)

所有重要的变更都将记录在此文件中。

## [2.1.0] - 2025-10-02 🎉 重大更新

### 🚀 重构：WebView 侧边栏

**解决性能问题**：
- 🎉 **采用 WebView 架构**：
- ⚡ **虚拟滚动技术**：只渲染可见区域，支持万级变量丝滑流畅
- 🔍 **实时搜索过滤**：瞬间定位目标变量
- 📂 **分类筛选**：快速切换 Data/Methods/全部
- 🎨 **现代化 UI**：VSCode 原生主题适配，视觉统一

**性能对比**：

| 变量数量 | 旧版 TreeView | 新版 WebView | 性能提升 |
|---------|--------------|--------------|----------|
| 100     | 即时         | 即时         | -        |
| 500     | 卡顿 2-3s    | **瞬间**     | ✅ 100%  |
| 1000    | 卡顿 5-8s    | **瞬间**     | ✅ 100%  |
| 10000   | 崩溃/无响应  | **流畅滚动** | ✅ 无限  |

**核心特性**：
- ✅ 虚拟滚动：只渲染可见的 10-20 个变量节点
- ✅ 搜索框：实时过滤，支持中英文模糊搜索
- ✅ 分类按钮：一键切换 Data/Methods/全部视图
- ✅ 保持顺序：严格按代码行号排序
- ✅ 一键跳转：点击变量立即跳转到定义位置
- ✅ 实时刷新：文件保存/切换自动更新
---

## [2.0.1] - 2025-10-02 ⚡

### ✨ 新增功能

**侧边栏面板**：
- 🎉 全新的侧边栏视图，提供更直观的功能访问
- 📊 **变量索引**：显示当前 HTML 文件的 Vue 实例索引
  - Data 属性列表
  - Methods 方法列表
  - Computed 计算属性列表
  - 点击即可跳转到定义
- 👁️ **监听服务**：显示所有运行中的 HTML→JS 文件监听
  - 实时显示监听项目
  - 点击可在资源管理器中定位
  - 无监听时友好提示

**使用方式**：
- 点击活动栏中的 "雷动三千工具" 图标
- 自动监听当前文件变化，实时更新索引
- 支持折叠/展开所有节点

### 🐛 Bug 修复

**内联脚本行号修复**：
- 🔧 修复 HTML 内联脚本（`<script>` 标签）跳转位置错误的问题
- 🎯 正确计算脚本在 HTML 中的起始行号
- ✅ 支持 PHP 混合模板和多个 script 标签
- 📍 点击侧边栏变量现在能准确跳转到 HTML 文件正确位置

**实现细节**：
- `extractInlineScript()` 返回 `{content, startLine}`
- `jsSymbolParser.parse()` 新增 `baseLine` 参数支持
- 所有符号位置自动应用行号偏移

### ⚡ 性能优化

**TreeView 优化**（解决变量卡顿问题）：
- ✅ **保持代码顺序**：变量按行号排序，与源代码一致（不再按字母排序）
- ✅ **轻量化渲染**：description 只显示 `:行号`，减少文本渲染开销
- ✅ **智能 tooltip**：鼠标悬停显示完整文件路径和行号
- ⚠️ **性能说明**：VSCode TreeView 不支持虚拟滚动，300+ 变量仍会有延迟

**优化效果**：

| 变量数量 | 优化前 | 优化后 | 说明 |
|---------|--------|--------|------|
| ≤100    | 即时   | 即时   | 无影响 |
| 300     | 轻微卡顿 | 流畅 | ✅ 减少描述文本 |
| 500+    | 卡顿 2-3s | **仍有卡顿** | ⚠️ TreeView API 限制 |

**性能建议**：
- 大文件（500+ 变量）建议拆分或使用 F12 跳转
- 如需处理超大文件，可参考 [outline-map](https://github.com/Gerrnperl/outline-map) 使用 WebView 实现虚拟滚动

**技术文档**：详见 `docs/performance-optimization.md`

---

## [2.0.0] - 2025-10-02 🚀

### 🎯 版本发布优化

**发布相关**：
- ✨ 添加自动发布脚本到 package.json
- 🔧 新增发布命令：`npm run publish`
- 🔧 支持语义化版本发布：`publish:patch`、`publish:minor`、`publish:major`
- 📦 优化打包流程，扩展体积进一步减小

**命令列表**：
```bash
npm run vsix              # 创建 .vsix 安装包
npm run publish           # 发布到扩展市场
npm run publish:patch     # 发布补丁版本 (x.x.1)
npm run publish:minor     # 发布次要版本 (x.1.0)
npm run publish:major     # 发布主要版本 (1.0.0)
```

---

## [1.0.0] - 2025-10-02 🎉

### 🚀 首次正式发布

这是 **雷动三千vscode工具集** 的首个正式版本，集成了多个强大的开发效率工具。

---

## 核心功能

### 1. 🔍 Vue.js 智能代码跳转

**功能描述**：
- 从 HTML 模板跳转到 Vue 实例定义（data、methods、computed）
- 支持内联 `<script>` 标签和外部 `.dev.js` 文件
- 智能识别 `this.`、`that.` 上下文
- 支持模板局部变量（v-for、slot-scope）优先跳转
- 支持 mixins 中的属性和方法跳转

**使用方式**：
- 按 `F12` 跳转到定义
- 按 `Ctrl+K F12` 在侧边栏打开定义
- 右键菜单选择 "Go to Definition"

**配置项**：
- `leidong-tools.enableDefinitionJump`: 启用/禁用跳转功能
- `leidong-tools.indexLogging`: 启用/禁用调试日志
- `leidong-tools.rebuildOnSave`: 保存时重建索引
- `leidong-tools.maxIndexEntries`: 最大索引缓存数（默认 200）
- `leidong-tools.maxTemplateIndexEntries`: 最大模板索引数（默认 300）

---

### 2. ⚡ 智能日志补全（.log）

**功能描述**：
- 输入 `variableName.log` 自动生成完整日志语句
- 自动包含文件名和行号信息
- 支持多种日志级别（log、err、warn、info、dbg）
- 支持字符串直接输出：`'message'.log`
- 使用 command 模式实现，优先级高于内置补全

**触发方式**：
```javascript
// 输入：userName.log
// 输出：console.log('file.js:10 userName:', userName)

// 输入：'error message'.err
// 输出：console.error('error message')

// 支持的触发器
.log   // 🔥 console.log
.err   // ❌ console.error  
.warn  // ⚠️ console.warn
.info  // ℹ️ console.info
.dbg   // 🐛 console.debug
```

**技术实现**：
- 参考 [jaluik/dot-log](https://github.com/jaluik/dot-log) (MIT License)
- 使用 `CompletionItemProvider` + `resolveCompletionItem` + `command` 模式
- 通过 `registerTextEditorCommand` 实现文本替换
- 正则匹配变量名和字符串字面量

---

### 3. 🧠 JavaScript 智能补全

**功能描述**：
- 自动识别变量声明和函数定义
- 智能补全 Vue 组件的 data、methods、computed
- 上下文感知：区分 `this.` 和 `that.`
- 30秒 LRU 缓存机制
- 高优先级排序（sortText: '0000'）

**支持文件**：
- JavaScript (.js)
- TypeScript (.ts)
- Vue (.vue)
- 特别优化 `.dev.js` 文件

---

### 4. ⌨️ 快捷键日志插入

**快捷键列表**：
- `Ctrl+Shift+L`: 为选中变量生成 console.log
- `Ctrl+L`: 快速插入 console.log
- `Ctrl+E`: 快速插入 console.error
- `Ctrl+Alt+L`: 插入 console.log（备选）
- `Ctrl+Alt+E`: 插入 console.error（备选）

**工作原理**：
- 自动识别光标处或选中的变量
- 在下一行插入日志语句
- 包含文件名和行号
- 支持复杂变量名（obj.prop、arr[0]）

---

### 5. 🗜️ 多行代码压缩

**功能描述**：
- 智能识别文件类型并选择压缩策略
- 支持 HTML、JavaScript、CSS、JSON 等
- 专门处理各种注释格式
- 保持代码语法正确性

**支持语言**：
- HTML/XML: 移除标签间空白
- JavaScript/TypeScript: 移除注释和空行
- CSS/SCSS/SASS/Less: 压缩样式规则
- JSON: 移除空白符
- 注释：`//`、`/* */`、`<!-- -->`、`#`、`--`

**使用方式**：
- 选中多行文本
- 右键选择 "Compress Multiple Lines"
- 或使用命令面板

---

### 6. 👁️ HTML→JS 文件监听

**功能描述**：
- 监听 HTML 文件变化，自动更新对应 JS 文件
- 提取特定 HTML 内容（注释标记或 id="vm"）
- 自动转义单引号并压缩为单行
- 更新 JS 中的 `var html =` 变量

**使用方式**：
- 右键文件夹 → "启动 HTML→JS 文件监听"
- 输入文件扩展名（默认：html）
- 底部状态栏显示监听状态 `👁️ N`
- 点击图标可管理监听列表

**智能识别**：
- 自动识别 `dev` 目录
- 支持单项目和多项目模式
- 防重复监听（检测父子目录冲突）

**详细文档**：参见 [docs/file-watch-usage.md](docs/file-watch-usage.md)

---

### 7. 🔧 Von 快捷补全

**功能描述**：
- 输入 `von` 触发快捷补全
- 自动插入当前时间（YYYYMMDDHHMMSS）
- 自动生成随机 UUID

**使用场景**：
- 快速添加时间戳
- 生成唯一标识符
- 文件命名辅助

---

## 技术架构

### 模块化设计

```
src/
├── cache/        # LRU 缓存管理
├── core/         # 核心配置和命令注册  
├── errors/       # 统一错误处理
├── finders/      # 定义查找、脚本查找、模板索引
├── managers/     # 索引生命周期、文件监听管理
├── monitoring/   # 性能监控（@monitor 装饰器）
├── parsers/      # AST 和文档解析
├── providers/    # VSCode Provider 实现
├── tools/        # 工具命令（压缩、日志）
├── types/        # TypeScript 类型定义
└── utils/        # 向后兼容导出层（仅兼容）
```

### 关键技术

1. **AST 解析**：
   - 使用 `@babel/parser` 解析 JavaScript
   - 启用 `errorRecovery` 支持语法错误场景
   - 处理混合 PHP/Layui 模板

2. **缓存策略**：
   - 文档级缓存：内容哈希 + 版本检查
   - 外部文件缓存：mtime + 哈希
   - LRU 淘汰策略，可配置上限

3. **性能监控**：
   - `@monitor` 装饰器记录方法执行时间
   - 命令："Show Performance Report"

4. **配置系统**：
   - 两个独立开关：`enableDefinitionJump`、`indexLogging`
   - 功能启用与调试日志分离

---

## 命令列表

| 命令 | 功能 | 快捷键 |
|------|------|--------|
| `leidong-tools.goToDefinitionInNewTab` | 在新标签页打开定义 | - |
| `leidong-tools.toggleDefinitionJump` | 切换定义跳转功能 | - |
| `leidong-tools.toggleIndexLogging` | 切换索引日志 | - |
| `leidong-tools.clearIndexCache` | 清除索引缓存 | - |
| `leidong-tools.showIndexSummary` | 显示索引摘要 | - |
| `leidong-tools.showPerformanceReport` | 显示性能报告 | - |
| `leidong-tools.logSelectedVariable` | 日志选中变量 | `Ctrl+Shift+L` |
| `leidong-tools.quickConsoleLog` | 快速 console.log | `Ctrl+L` |
| `leidong-tools.quickConsoleError` | 快速 console.error | `Ctrl+E` |
| `leidong-tools.compressLines` | 压缩多行 | - |
| `leidong-tools.startWatch` | 启动文件监听 | - |
| `leidong-tools.showWatchList` | 查看监听列表 | - |

---

## 支持的文件类型

| 功能 | 支持的文件 |
|------|------------|
| Vue 跳转 | HTML |
| JavaScript 补全 | JS, TS, Vue, .dev.js |
| .log 补全 | JS, TS, JSX, TSX, Vue, HTML |
| 代码压缩 | HTML, XML, JS, TS, JSON, CSS, SCSS, SASS, Less |
| 文件监听 | 可配置（默认 HTML）|

---

## 已知限制

1. 不支持 Vue 3 Composition API（计划中）
2. 不支持 Vue 单文件组件 (.vue) 的复杂模块结构
3. 假设 Vue 实例使用 `new Vue({...})` 创建
4. 错误恢复机制在严重语法错误时可能不准确

---

## 参考与致谢

- [jaluik/dot-log](https://github.com/jaluik/dot-log) - .log 补全实现灵感（MIT License）
- Babel 项目 - AST 解析工具
- VSCode API 文档

---

## 开发团队

由 **KuCai** 开发和维护。

---

## 许可证

MIT License

---

## 未来计划 🚀

- [ ] 支持 Vue 3 Composition API
- [ ] 支持 TypeScript Vue 项目
- [ ] 支持 Pinia/Vuex 状态管理跳转
- [ ] 增强模板变量作用域检测
- [ ] 支持更多日志格式自定义
- [ ] 添加代码片段管理功能
- [ ] 性能进一步优化

---

## 反馈与贡献

如有问题或建议，欢迎通过以下方式反馈：

- GitHub Issues: [lsrweb/leidong-tools](https://github.com/lsrweb/leidong-tools/issues)
- Email: 联系开发者

感谢使用 **雷动三千vscode工具集**！

---