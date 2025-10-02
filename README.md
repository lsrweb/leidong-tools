# 雷动三千 VSCode 工具集

<div align="center">

![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![VSCode](https://img.shields.io/badge/VSCode-%5E1.99.0-blue.svg)

**一站式 Vue.js 开发效率提升工具集**

[功能特性](#-功能特性) • [快速开始](#-快速开始) • [使用指南](#-使用指南) • [配置说明](#️-配置说明) • [更新日志](CHANGELOG.md)

</div>

---

## 🌟 功能特性

### 1. 🔍 Vue.js 智能代码跳转

一键从 HTML 模板跳转到 Vue 实例定义，支持 data、methods、computed、mixins。

```html
<!-- HTML 模板 -->
<div @click="handleClick">{{ userName }}</div>

<!-- 按 F12 直接跳转到对应定义 -->
```

**核心特性**：
- ✅ 支持内联 `<script>` 和外部 `.dev.js` 文件
- ✅ 智能识别 `this.` 和 `that.` 上下文
- ✅ 模板局部变量优先跳转（v-for, slot-scope）
- ✅ 支持 mixins 属性和方法
- ✅ 可配置索引缓存大小和刷新策略

---

### 2. ⚡ 智能日志补全（.log）

告别手动输入冗长的 console.log，一个 `.log` 搞定一切！

```javascript
// 输入：userName.log
// 自动展开为：console.log('file.js:10 userName:', userName)

// 输入：'error message'.err
// 自动展开为：console.error('error message')

// 支持的触发器：
userName.log   // 🔥 console.log
userName.err   // ❌ console.error
userName.warn  // ⚠️ console.warn
userName.info  // ℹ️ console.info
userName.dbg   // 🐛 console.debug
```

**技术亮点**：
- 🎯 使用 command 模式，优先级高于内置补全
- 📍 自动包含文件名和行号
- 🎨 图标标识不同日志级别
- 📝 支持字符串字面量直接输出
- ⚡ 正则匹配变量名，支持复杂表达式

**参考实现**：[jaluik/dot-log](https://github.com/jaluik/dot-log) (MIT)

---

### 3. 🧠 JavaScript 智能补全

为 JavaScript/TypeScript/Vue 文件提供强大的变量和函数补全。

**支持场景**：
- 变量声明、函数定义
- Vue 组件 data、methods、computed
- 上下文感知（this. / that.）
- .dev.js 文件特别优化

**性能优化**：
- 30秒 LRU 缓存
- 高优先级排序（sortText: '0000'）
- 标识符：`(雷动三千)`

---

### 4. ⌨️ 快捷键快速日志

选中变量或光标定位，一键生成日志语句。

| 快捷键 | 功能 | 示例 |
|--------|------|------|
| `Ctrl+Shift+L` | 选中变量生成 log | `console.log('file:10 userName:', userName)` |
| `Ctrl+L` | 快速 console.log | 识别光标处变量 |
| `Ctrl+E` | 快速 console.error | 识别光标处变量 |
| `Ctrl+Alt+L` | 备选 console.log | - |
| `Ctrl+Alt+E` | 备选 console.error | - |

---

### 5. 🗜️ 多行代码压缩

智能识别文件类型，一键压缩多行代码。

**支持语言**：
- **HTML/XML**: 移除标签间空白
- **JavaScript/TypeScript**: 移除注释和空行
- **CSS/SCSS/Less**: 压缩样式规则
- **JSON**: 移除格式化空白
- **注释**: `//`, `/* */`, `<!-- -->`, `#`, `--`

**使用方式**：
1. 选中多行文本
2. 右键 → "Compress Multiple Lines"
3. 或命令面板搜索


---

### 6. 👁️ HTML→JS 文件监听

监听 HTML 文件变化，自动提取内容并更新对应 JS 文件。

```
项目结构：
my-project/
  └── dev/
      ├── index.html   # 修改这个
      └── index.js     # 自动更新这个
```

**工作流程**：
1. 右键文件夹 → "启动 HTML→JS 文件监听"
2. 输入文件扩展名（默认：html）
3. 编辑 HTML，保存后自动更新 JS 中的 `var html =`
4. 底部状态栏显示监听状态 `👁️ N`

**智能特性**：
- 自动识别 `dev` 目录
- 支持单项目/多项目模式
- 防重复监听（父子目录冲突检测）
- 可视化管理面板

**详细文档**：[docs/file-watch-usage.md](docs/file-watch-usage.md)

---

### 7. 🔧 Von 快捷补全

输入 `von` 触发快捷补全。

- � 当前时间（YYYYMMDDHHMMSS）
- 🆔 随机 UUID

**使用场景**：
- 快速添加时间戳
- 生成唯一标识符
- 文件命名辅助

---

## 🚀 快速开始

### 安装

1. **VSCode 扩展市场**（推荐）
   - 搜索 "雷动三千vscode工具集"
   - 点击安装

2. **手动安装 .vsix**
   - 下载 `.vsix` 文件
   - VSCode → 扩展 → 从 VSIX 安装

### 首次使用

安装后，扩展会在以下文件类型自动激活：
- HTML, JavaScript, TypeScript, Vue, JSON, CSS

无需额外配置，开箱即用！

---

## 📖 使用指南

### Vue 代码跳转

```html
<template>
  <div @click="handleClick">{{ userName }}</div>
</template>

<script>
new Vue({
  data: {
    userName: 'John'
  },
  methods: {
    handleClick() { }
  }
})
</script>
```

**操作**：
- 光标放在 `userName` 或 `handleClick` 上
- 按 `F12` 跳转到定义
- 按 `Ctrl+K F12` 在侧边栏打开

---

### 日志补全

**方式一：.log 补全**
```javascript
// 输入并回车
userName.log

// 自动变为
console.log('file.js:10 userName:', userName)
```

**方式二：快捷键**
```javascript
// 1. 选中 userName
// 2. 按 Ctrl+Shift+L
// 3. 自动在下一行生成
console.log('file.js:10 userName:', userName)
```

**方式三：字符串**
```javascript
'Hello World'.log
// → console.log('Hello World')
```

---

### 文件监听

**单项目模式**：
```
项目/
  └── dev/      ← 右键这个文件夹
      ├── index.html
      └── index.js
```

**多项目模式**：
```
父目录/        ← 右键这个文件夹
  ├── 项目A/dev/
  ├── 项目B/dev/
  └── 项目C/dev/
```

**管理监听**：
- 点击底部状态栏 `👁️ N` 图标
- 查看所有监听项
- 选择停止单个或全部

---

## ⚙️ 配置说明

### 通过设置面板配置

`文件` → `首选项` → `设置` → 搜索 "leidong-tools"

### 配置项列表

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enableDefinitionJump` | boolean | true | 启用/禁用 Vue 定义跳转 |
| `indexLogging` | boolean | true | 启用/禁用索引调试日志 |
| `rebuildOnSave` | boolean | true | 保存时重建索引 |
| `maxIndexEntries` | number | 200 | Vue 索引缓存上限 |
| `maxTemplateIndexEntries` | number | 300 | 模板索引缓存上限 |
| `hoverDelay` | number | 300 | 悬停延迟（毫秒） |

### 配置示例

```json
{
  "leidong-tools.enableDefinitionJump": true,
  "leidong-tools.indexLogging": false,
  "leidong-tools.maxIndexEntries": 500
}
```

---

## �️ 命令面板

按 `Ctrl+Shift+P` 打开命令面板，搜索以下命令：

| 命令 | 功能 |
|------|------|
| `Toggle Definition Jump Feature` | 切换定义跳转功能 |
| `Toggle Index Logging` | 切换索引日志 |
| `Clear Vue Index Cache` | 清除索引缓存 |
| `Show Index Summary` | 显示索引摘要 |
| `Show Performance Report` | 显示性能报告 |
| `启动 HTML→JS 文件监听` | 启动文件监听 |
| `查看/管理文件监听列表` | 管理监听列表 |

---

## 🎯 使用技巧

### 1. 提升 .log 补全优先级

如果发现 .log 补全不够靠前，确保：
- 使用最新版本（v1.0.0+）
- 补全项会显示 🔥 图标
- 标记为 `(雷动三千)`

### 2. 调试跳转问题

如果跳转失败：
1. 检查 `.dev.js` 文件是否存在于 `js/` 目录
2. 确认 `<script>` 包含 `new Vue({...})`
3. 运行命令 `Toggle Index Logging` 开启日志
4. 运行命令 `Show Index Summary` 查看索引状态

### 3. 性能优化

- 适当调整 `maxIndexEntries` 和 `maxTemplateIndexEntries`
- 关闭不需要的 `indexLogging`
- 使用 `Show Performance Report` 查看瓶颈

---

## 📁 项目结构

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
└── utils/        # 向后兼容导出层
```

**架构特点**：
- 按功能组织，不按层次
- 每个目录独立 `index.ts` 导出
- 使用具体路径导入，避免循环依赖
- `utils/` 仅作兼容层，不添加新文件

---

## 🔧 技术栈

- **VSCode API**: 扩展开发框架
- **TypeScript**: 类型安全
- **Babel**: AST 解析（@babel/parser, @babel/traverse）
- **Webpack**: 打包构建
- **ESLint**: 代码规范

**关键技术**：
- AST 解析带 `errorRecovery`
- LRU 缓存策略
- Command 模式补全
- FileSystemWatcher 监听

---

## 📊 性能指标

| 指标 | 数值 | 说明 |
|------|------|------|
| 扩展大小 | ~1.5MB | Webpack 打包后 |
| 启动时间 | <100ms | 按需激活 |
| 补全响应 | <50ms | 有缓存时 |
| 索引构建 | <200ms | 中等大小文件 |
| 内存占用 | <50MB | 正常使用 |

---

## 🐛 已知限制

1. **Vue 版本**: 仅支持 Vue 2 Options API
2. **文件结构**: 假设 Vue 实例使用 `new Vue({...})`
3. **SFC 支持**: 不支持 .vue 单文件组件复杂结构
4. **错误恢复**: 严重语法错误时可能不准确

**未来计划**：
- [ ] Vue 3 Composition API 支持
- [ ] TypeScript Vue 项目支持
- [ ] Pinia/Vuex 状态管理跳转

---

## 🤝 参考与致谢

- [jaluik/dot-log](https://github.com/jaluik/dot-log) - .log 补全实现灵感（MIT License）
- [Babel](https://babeljs.io/) - AST 解析工具
- [VSCode Extension API](https://code.visualstudio.com/api)

---

## 📄 许可证

MIT License

Copyright (c) 2025 雷动三千 (KuCai)

---

## 💬 反馈与贡献

**遇到问题？**
- [GitHub Issues](https://github.com/lsrweb/leidong-tools/issues)

**想要贡献？**
- Fork 项目
- 提交 Pull Request
- 参与讨论

**联系方式**：
- 项目主页：[leidong-tools](https://github.com/lsrweb/leidong-tools)

---

<div align="center">

**感谢使用 雷动三千 VSCode 工具集！**

如果觉得有用，请给个 ⭐️ Star！

[返回顶部](#雷动三千-vscode-工具集)

</div>

