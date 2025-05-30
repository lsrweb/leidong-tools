# 雷动三千vscode工具集

**雷动三千vscode工具集** 是一个功能强大的 Visual Studio Code 扩展，专为增强 Vue.js 开发体验和通用代码编辑效率而设计。

## 主要功能

### 🔍 Vue.js 代码跳转
*   **Go to Definition**: 支持从 HTML 模板中的变量或方法跳转到 `<script>` 标签或对应 `.dev.js` 文件中的定义
*   **支持 Vue 组件结构**: 自动识别 `data`、`methods`、`computed` 属性中的定义
*   **智能作用域识别**: 区分 `this.` 和 `that.` 上下文引用
*   **侧边栏打开**: 支持 VS Code 内置的 "Go to Definition to Side" 命令
*   **新标签页打开**: 提供命令在新标签页中打开定义

### 🧠 JavaScript 智能补全
*   **变量和函数补全**: 自动识别 JavaScript 文件中的变量声明和函数定义
*   **Vue 组件补全**: 智能识别 Vue 实例中的 `data`、`methods`、`computed` 属性
*   **上下文感知**: 根据 `this.` 和 `that.` 上下文提供相应的补全建议
*   **高优先级补全**: 使用优化的排序算法，确保工具提供的补全建议优先显示
*   **缓存优化**: 30秒缓存机制提升性能
*   **支持 .dev.js 文件**: 特别优化对 `.dev.js` 文件的补全支持

### ⚡ 快速日志补全
*   **高优先级 .log 补全**: 输入 `.log` 时优先显示 console.log 补全，优于 VS Code 内置词汇建议
*   **多种日志类型**: 支持 `.log`、`.er`、`.info`、`.dbg` 等快速补全
*   **表情符号标识**: 🔥 log、❌ error、ℹ️ info、🐛 debug，便于快速识别
*   **智能文件信息**: 自动包含文件名和行号信息
*   **多变量支持**: 支持 `var1,var2,var3.lg` 多变量一次性日志输出
*   **代码片段增强**: 提供 `clog`、`varlog`、`vlog` 等多种触发前缀

### ⌨️ 键盘快捷键
*   **快速选中变量日志**: `Ctrl+Shift+L` - 选中变量后快速在下一行生成 console.log
*   **快速 console.log**: `Ctrl+L` - 快速插入 console.log
*   **快速 console.error**: `Ctrl+E` - 快速插入 console.error  
*   **多种日志级别快捷键**: 
    - `Ctrl+Alt+L`: 插入 console.log
    - `Ctrl+Alt+E`: 插入 console.error

### 🗜️ 多行代码压缩
*   **智能压缩**: 根据文件类型选择最佳压缩策略
*   **支持多种语言**: HTML/XML、JavaScript/TypeScript、JSON、CSS/SCSS/SASS/Less
*   **注释压缩**: 专门处理各种类型的注释内容
    - JavaScript/TypeScript: `//` 单行注释和 `/* */` 多行注释
    - HTML: `<!-- -->` 注释
    - Python/Shell: `#` 注释
    - SQL: `--` 注释
*   **保持语法正确**: 智能处理空白符，确保压缩后代码语法正确

## 使用方法

### Vue 代码跳转
1. 在 HTML 文件中，将光标置于 Vue 模板中的变量或方法名上
2. 使用 `F12` 跳转到定义，或 `Ctrl+K F12` 在侧边栏打开
3. 或通过命令面板 (`Ctrl+Shift+P`) 执行相关跳转命令

### JavaScript 自动补全
1. 在 JavaScript 文件中输入代码时会自动触发补全
2. 输入 `this.` 或 `that.` 时会显示相应的 Vue 组件属性和方法
3. 支持普通变量和函数的补全

### 快速日志补全
1. **变量.log 补全**: 在任意变量后输入 `.log` 自动补全 console.log
2. **多变量日志**: 输入 `var1,var2,var3.lg` 一次性输出多个变量
3. **代码片段**: 输入 `clog`、`varlog` 或 `vlog` 触发日志代码片段

### 键盘快捷键使用
1. **选中变量快速日志**: 选中任意变量，按 `Ctrl+Shift+L` 在下一行自动生成 console.log
2. **快速日志**: 光标定位到变量上，按 `Ctrl+L` 快速插入 console.log
3. **错误日志**: 按 `Ctrl+E` 快速插入 console.error

### 多行压缩
1. 选中需要压缩的多行文本
2. 右键选择 "Compress Multiple Lines" 或使用命令面板
3. 扩展会智能识别内容类型并应用最佳压缩策略

## 项目结构要求

*   HTML 文件包含 `<script>` 标签和 `new Vue({...})` 实例，或
*   HTML 文件对应的 JavaScript 文件位于 `js/basename.dev.js`，包含 `new Vue({...})` 实例

## 支持的文件类型

- **Vue 跳转**: HTML 文件
- **JavaScript 补全**: JavaScript、TypeScript、Vue 文件，特别是 `.dev.js` 文件
- **快速日志补全**: JavaScript、TypeScript、Vue 文件
- **代码压缩**: HTML、XML、JavaScript、TypeScript、JSON、CSS、SCSS、SASS、Less 等
- **注释压缩**: 所有支持的编程语言注释格式

## 特色亮点

### 🎯 补全优先级优化
- 使用优化的 `sortText: '0000'` 确保工具补全建议优先于 VS Code 内置词汇建议
- 返回 `CompletionList` 格式提供更好的补全控制体验
- 所有补全项都带有 "(雷动三千)" 标识符便于识别

### 🔧 命令体系统一
- 所有命令使用统一的 `leidong-tools` 前缀
- 解决了扩展激活冲突问题
- 提供清晰一致的用户体验

### ⚡ 性能优化
- JavaScript 补全使用30秒缓存机制
- 智能解析 AST 提取变量和方法信息
- 支持错误恢复，确保在语法错误时仍能工作

## 已知限制

*   错误恢复机制可能在语法错误时导致不准确的结果
*   目前不支持 Vue 单文件组件 (.vue 文件) 的复杂模块结构
*   假设 Vue 实例使用 `new Vue({...})` 创建

## 更新日志

### 1.0.0 🎉 正式版
- 🚀 **优化补全优先级**: .log 补全现在优先于 VS Code 内置词汇建议显示
- ⌨️ **新增键盘快捷键**: `Ctrl+Shift+L` 快速为选中变量生成 console.log
- 🎨 **增强代码片段**: 添加表情符号图标、改进描述、增加替代前缀
- 🔧 **统一命令前缀**: 所有命令使用 `leidong-tools` 前缀，解决激活冲突
- 🗑️ **代码清理**: 移除了 hello world 示例代码，扩展更加精简
- ✅ **编译优化**: 确保扩展无错误编译，提升稳定性

### 0.0.6
- 🔧 优化补全提供器的稳定性
- 🐛 修复多变量日志补全的边界情况

### 0.0.5
- ✨ 新增快速日志补全功能
- ✨ 新增键盘快捷键支持
- 🔧 优化日志输出格式

### 0.0.4
- ✨ 新增多变量日志支持
- 🔧 改进补全算法

### 0.0.3
- ✨ 新增代码片段支持
- 🔧 优化用户界面

### 0.0.2
- ✨ 新增 JavaScript 变量和函数智能补全功能
- ✨ 新增多行代码压缩功能，支持多种文件类型
- ✨ 新增注释内容专门压缩处理
- ✨ 新增快速日志插入功能
- 🔧 优化 Vue 代码跳转的上下文识别
- 🔧 添加性能缓存机制

### 0.0.1
初始版本，支持基本的内联脚本和关联 `.dev.js` 文件的 Go to Definition 功能。

## 开发团队

由 雷动三千(KuCai) 开发和维护。

## 许可证

MIT License
