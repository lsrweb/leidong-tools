# 更新日志

## [1.1.0] - 2025-09-01 ✨ 模板索引与跳转增强

## [1.1.1] - 2025-09-01 🛠 计算属性跳转修复

## [1.1.2] - 2025-09-01 ⚡ 跳转稳定性修复

### 修复
- 添加 `provideDefinition` try/catch，防止单个解析异常导致所有跳转失效。
- 修正 this 别名检测正则转义问题，避免无故匹配失败导致别名链式跳转失效。
- 增强日志：若索引结果为空可结合 `[jump][fatal]` 快速定位根因。

### 使用提示
- 若仍无法跳转：确认 js/ 同名 *.dev.js 是否存在；或内联 `<script>` 是否包含 `new Vue(`。
- 可通过命令 `Toggle Index Logging` 开启日志，再使用 `Show Index Summary` 查看缓存情况。

### 修复
- 新增对 `computed` 与 mixin `computed` 属性的索引与跳转支持，解决绑定到计算属性名无法跳转的问题。

### 说明
- 跳转优先级更新：data > mixinData > computed > mixinComputed > methods > mixinMethods。
- 计算属性在补全中归类为属性 (Property)。

### 新功能 🚀
- **模板局部变量智能跳转**: 支持 `v-for` (含 `(item,index)` / 解构 / 单变量)、`slot-scope`、`v-slot`、`#slot` 语法内的局部变量索引与优先跳转。
- **作用域判定**: 通过轻量标签栈估算变量生效范围，实现局部变量优先于 `data/methods`、`mixin` 命中。
- **索引摘要命令**: 新增 `Show Index Summary (Template + Vue)`（`leidong-tools.showIndexSummary`）输出模板与 Vue 索引统计。
- **日志开关命令**: 新增 `Toggle Index Logging`（`leidong-tools.toggleIndexLogging`）快速启用/关闭索引与跳转调试日志。
- **统一缓存清理**: `Clear Vue Index Cache` 现同时清理模板索引缓存。

### 性能与架构 🧠
- **模板索引缓存 (LRU)**: 最多 50 份，超出按最久未访问淘汰，避免内存膨胀。
- **Vue 索引 + 模板索引并行体系**: 模板局部 -> VueIndex(data > mixinData > methods > mixinMethods) 分层优先级更清晰。
- **可配置日志**: 新增配置项 `leidong-tools.indexLogging` 控制 `[template-index]`、`[jump]`、`[build]` 等调试输出。

### 调试与可观测性 🔍
- 结构化日志前缀：`[template-index][build|hit]`、`[jump][html][template-hit]`、`[jump][js]` 等，便于过滤排查。
- 清理命令增加模板索引同步清理，保证问题复现时可完全重建。

### 兼容与稳定性 ✅
- 不改变既有 `data/method` 跳转逻辑；在无模板局部变量命中时保持旧行为。
- 代码增量式引入（`templateIndexer.ts`），对其他功能零侵入。

### 后续规划 🔭
- 指令/插值表达式内更细粒度 token 跳转
- 嵌套链条更深层属性根定位
- 更精确的作用域结束判定（自闭合/嵌套不完整场景）
- 模板变量增量更新而非整文重建

> 升级到 1.1.0 后即可直接使用新命令与局部变量跳转功能，如需关闭调试输出可运行 `Toggle Index Logging` 或在设置中关闭。

## [1.0.0] - 2025-05-29 🎉 正式版发布

### 重大优化和完善 🚀
- **🚀 补全优先级彻底优化**: 使用 `sortText: '0000'` 确保工具补全优先于 VS Code 内置词汇建议
- **⌨️ 新增选中变量快捷键**: `Ctrl+Shift+L` 快速为选中变量生成 console.log
- **🎨 代码片段全面增强**: 
  - 添加表情符号图标 (🔥, ❌, ℹ️, 🐛) 
  - 改进描述和作用域定义
  - 新增替代前缀 "varlog", "vlog" 便于快速访问
- **🔧 命令体系统一**: 所有命令从混合前缀统一为 `leidong-tools` 前缀，解决激活冲突
- **🗑️ 代码清理**: 移除 hello world 示例代码，扩展更加精简专业
- **✅ 编译优化**: 确保扩展无错误编译，提升稳定性和性能
- **📚 文档完善**: 全面更新 README 文档，详细说明新功能使用方法

### 新功能亮点 ⭐
- **高优先级 .log 补全**: 输入 `.log` 时优先显示 console.log 补全
- **CompletionList 格式**: 返回优化的补全列表格式，提供更好的控制体验  
- **多变量日志支持**: 支持 `var1,var2,var3.lg` 多变量一次性日志输出
- **智能文件信息**: 自动包含文件名和行号信息
- **键盘快捷键体系**: 
  - `Ctrl+Shift+L`: 选中变量快速日志
  - `Ctrl+L`: 快速 console.log
  - `Ctrl+E`: 快速 console.error
  - `Ctrl+Alt+L/E`: 传统日志插入

### 技术改进 🔧
- JavaScript 补全使用30秒缓存机制提升性能
- 智能解析 AST 提取变量和方法信息
- 支持错误恢复，确保在语法错误时仍能工作
- 所有补全项带有 "(雷动三千)" 标识符便于识别

## [0.0.8] - 2024-12-19

### 重大优化和新功能 🚀
- **补全优先级大幅提升**: 解决快速日志补全优先级低的问题
  - 添加 emoji 图标标识：🔥 log、❌ error、ℹ️ info、🐛 debug
  - 设置最高优先级 `sortText: '00000'`
  - 启用预选中功能 `preselect: true`
  - 现在 `.lg` 等补全会显示在最顶部，不会被 VS Code 单词记录覆盖
- **快捷键支持**: 新增强大的快捷键功能
  - **Ctrl+L**: 快速插入 console.log（选中变量或光标位置的变量）
  - **Ctrl+Shift+L**: 快速插入 console.error
  - **Ctrl+Alt+I**: 快速插入 console.info
  - **Ctrl+Alt+D**: 快速插入 console.debug
- **智能变量识别**: 增强变量识别能力
  - 支持复杂变量名如 `obj.property[index]`
  - 自动识别选中文本或光标位置的变量
  - 如果没有变量，会弹出输入框让用户输入
- **用户体验优化**: 
  - 插入日志后自动显示成功提示
  - 插入带有 emoji 标识的日志便于区分
  - 自动移动光标到插入行末尾

### 使用方法增强 📝
1. **补全方式**: 输入 `res.lg` 现在会优先显示快速日志补全
2. **快捷键方式**: 
   - 选中变量 `res` 按 **Ctrl+L** 立即生成日志
   - 光标在变量上按快捷键也能自动识别
   - 没有变量时会提示输入变量名
3. **日志格式**: `console.log(\`🔥 文件名:行号 变量名:\`, 变量名);`

## [0.0.7] - 2024-12-19

### 重大修复和功能增强 🔧
- **快速日志补全功能**: 修复并大幅增强快速日志输入功能
  - 支持 `变量名.lg` 快速生成 `console.log(变量名, '文件名-行-变量')`
  - 支持 `变量名.er` 快速生成 `console.error`
  - 支持 `变量名.info` 快速生成 `console.info`
  - 支持 `变量名.dbg` 快速生成 `console.debug`
- **多变量日志支持**: 新增多变量同时日志功能
  - 支持 `var1,var2,var3.lg` 快速生成多变量日志
  - 智能识别复杂变量名如 `res.err_msg.lg`
- **智能补全集成**: 快速日志功能完全集成到 VS Code 自动补全系统
  - 输入时实时显示补全建议
  - 包含详细的功能说明和预览
  - 自动包含文件名和行号信息

### 使用方法 📝
1. **单变量日志**: 输入 `res.lg` 按 Tab 或回车即可生成完整的 console.log 语句
2. **多变量日志**: 输入 `var1,var2.lg` 可同时输出多个变量
3. **支持复杂变量**: `obj.property.lg`、`this.data.lg` 等都可以正常工作
4. **多种日志级别**: `.lg`、`.er`、`.info`、`.dbg` 对应不同的 console 方法

### 功能保持 ✅
- 保持所有现有功能完全不变
- Vue.js 代码跳转功能正常
- JavaScript 智能补全功能正常
- 多行代码压缩功能正常
- 注释压缩功能正常

## [0.0.6] - 2024-12-19

### 重大更新 🔄
- 

### 功能保持 ✅
- 保持所有现有功能完全不变
- Vue.js 代码跳转功能正常
- JavaScript 智能补全功能正常
- 多行代码压缩功能正常
- 注释压缩功能正常
- 快速日志插入功能正常

## [0.0.5] - 2025-05-29

### 重大更新 🔄
- **扩展重命名**: 将扩展名称从 "Unitools - 开发效率工具集" 更改为 "雷动三千vscode工具集"
- **品牌更新**: 更新所有文档和描述以反映新的品牌形象
- **README 文档更新**: 完善使用说明和功能介绍

### 功能保持 ✅
- 保持所有现有功能不变
- Vue.js 代码跳转
- JavaScript 智能补全
- 多行代码压缩
- 注释压缩
- 快速日志插入

## [0.0.4] - 2025-05-29

### 新增功能 ✨
- **扩展图标**: 添加了自定义的扩展图标 (logo.jpg)
- **视觉识别**: 提升扩展在 VS Code 扩展市场中的视觉识别度

## [0.0.3] - 2025-05-29

### 新增功能 ✨
- **多行代码压缩功能**: 支持智能压缩多行代码为单行
  - 支持 HTML/XML、JavaScript/TypeScript、JSON、CSS/SCSS/SASS/Less 等多种文件类型
  - 针对不同文件类型采用最佳压缩策略
- **注释压缩专门处理**: 智能识别和压缩各种类型的注释
  - JavaScript/TypeScript: `//` 单行注释和 `/* */` 多行注释
  - HTML: `<!-- -->` 注释  
  - Python/Shell: `#` 注释
  - SQL: `--` 注释
  - 自动移除多余的注释符号，保持内容完整
- **JavaScript 智能补全**: 为 JavaScript 文件提供变量和函数自动补全
  - 支持变量声明、函数声明、对象属性和方法的补全
  - 特别优化 Vue 组件的 `data`、`methods`、`computed` 属性补全
  - 智能区分 `this.` 和 `that.` 上下文，提供相应补全建议
  - 30秒缓存机制提升性能
- **快速日志插入**: 快速插入各种类型的 console 日志
  - 支持 `console.log`、`console.error`、`console.info`、`console.debug`
  - 自动识别变量名并生成带文件名和行号的日志语句
  - 提供快捷键支持

### 功能增强 🔧
- **Vue 代码跳转优化**: 改进 `this.` 调用的识别和跳转
- **上下文菜单**: 为多行压缩功能添加右键菜单支持
- **命令面板集成**: 所有功能都可通过命令面板访问
- **扩展激活优化**: 支持更多文件类型的自动激活

### 技术改进 🛠️
- 使用 `@babel/parser` 进行 JavaScript AST 解析
- 添加错误处理和日志记录
- 优化代码结构和性能
- 完善 TypeScript 类型定义

### 界面改进 💫
- 更新扩展显示名称为 "Unitools - 开发效率工具集"
- 完善命令分类和描述
- 添加快捷键绑定

## [0.0.2] - 2025-05-28

### 新增功能 ✨
- 添加快速日志插入功能的基础实现

### 修复问题 🐛  
- 修复 Vue 代码跳转的一些边界情况
- 改进错误处理机制

## [0.0.1] - 2025-05-27

### 初始版本 🎉
- **Vue 代码跳转**: 基本的 Go to Definition 功能
  - 支持从 HTML 模板跳转到 Vue 实例中的定义
  - 支持内联 `<script>` 标签和外部 `.dev.js` 文件
  - 支持 `data`、`methods`、`computed` 属性的跳转
- **多种打开方式**: 
  - 标准 F12 跳转
  - 侧边栏打开 (Ctrl+K F12)
  - 新标签页打开 (命令面板)

---

## 计划中的功能 🚀

- [ ] 支持 Vue 3 Composition API
- [ ] 支持 TypeScript Vue 项目
- [ ] 支持更多文件格式的压缩
- [ ] 添加代码格式化功能
- [ ] 支持自定义压缩规则
- [ ] 添加代码片段插入功能

## 反馈和贡献 💬

如果您在使用过程中遇到问题或有功能建议，请通过以下方式联系：

- 在项目仓库提交 Issue
- 发送邮件反馈
- 提交 Pull Request 贡献代码

感谢您使用 Unitools 扩展！Log

All notable changes to the "unitools" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release
