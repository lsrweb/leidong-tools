# 项目结构说明

本项目已经过重新组织，按照功能职责进行了模块化划分。

## 目录结构

```
src/
├── cache/              # 缓存管理模块
│   ├── cacheManager.ts    # 通用缓存管理器
│   ├── lruCache.ts        # LRU缓存实现
│   └── index.ts           # 模块导出
│
├── core/               # 核心配置和命令
│   ├── commands.ts        # 命令注册
│   ├── config.ts          # 配置常量
│   ├── index.ts           # 核心模块导出
│   └── providers.ts       # Provider注册
│
├── errors/             # 错误处理模块
│   ├── errorHandler.ts    # 统一错误处理
│   └── index.ts           # 模块导出
│
├── finders/            # 查找器模块
│   ├── definitionLogic.ts    # 定义查找逻辑
│   ├── scriptFinder.ts       # 脚本文件查找
│   ├── templateIndexer.ts    # 模板索引器
│   └── index.ts              # 模块导出
│
├── helpers/            # 辅助函数模块
│   ├── vueHelper.ts       # Vue相关辅助函数
│   └── index.ts           # 模块导出
│
├── managers/           # 管理器模块
│   ├── indexManager.ts    # 索引生命周期管理
│   └── index.ts           # 模块导出
│
├── monitoring/         # 性能监控模块
│   ├── performanceMonitor.ts  # 性能监控和统计
│   └── index.ts               # 模块导出
│
├── parsers/            # 解析器模块
│   ├── astParser.ts        # AST解析器
│   ├── parseDocument.ts    # 文档解析器
│   └── index.ts            # 模块导出
│
├── providers/          # VSCode Provider实现
│   ├── completionProvider.ts   # 自动补全提供器
│   ├── definitionProvider.ts   # 定义跳转提供器
│   ├── hoverProvider.ts        # 悬停提示提供器
│   └── index.ts                # 模块导出
│
├── tools/              # 工具命令模块
│   ├── codeCompressor.ts   # 代码压缩工具
│   ├── consoleLogger.ts    # 控制台日志工具
│   └── index.ts            # 模块导出
│
├── types/              # 类型定义
│   └── index.ts
│
├── test/               # 测试文件
│   ├── extension.test.ts
│   └── testDefinitionLogic.ts
│
├── utils/              # 工具函数（向后兼容）
│   └── index.ts           # 重新导出所有模块
│
└── extension.ts        # 扩展入口文件
```

## 模块职责说明

### 1. cache/ - 缓存管理
- `cacheManager.ts`: 提供通用缓存管理功能，包括AST索引缓存和文档解析缓存
- `lruCache.ts`: 实现LRU（最近最少使用）缓存策略

### 2. core/ - 核心功能
- `commands.ts`: 注册所有VS Code命令
- `config.ts`: 定义扩展配置常量
- `providers.ts`: 注册所有Provider

### 3. errors/ - 错误处理
- `errorHandler.ts`: 统一的错误处理和日志记录机制

### 4. finders/ - 查找器
- `definitionLogic.ts`: Vue变量和方法定义查找的核心逻辑
- `scriptFinder.ts`: 查找外部脚本文件（.dev.js）或内联脚本
- `templateIndexer.ts`: 模板变量索引（v-for, slot-scope等）

### 5. helpers/ - 辅助函数
- `vueHelper.ts`: Vue相关的辅助工具函数

### 6. managers/ - 管理器
- `indexManager.ts`: 管理索引的生命周期（创建、更新、清理）

### 7. monitoring/ - 性能监控
- `performanceMonitor.ts`: 性能监控、统计和报告生成

### 8. parsers/ - 解析器
- `astParser.ts`: 轻量级AST解析器，用于从JS代码中查找Vue定义
- `parseDocument.ts`: 文档解析器，构建Vue索引（data、methods、computed等）

### 9. providers/ - Provider实现
- `completionProvider.ts`: 自动补全（快速日志、Vue变量等）
- `definitionProvider.ts`: 定义跳转功能
- `hoverProvider.ts`: 悬停提示功能

### 10. tools/ - 工具命令
- `codeCompressor.ts`: 多行代码压缩工具
- `consoleLogger.ts`: 快速插入console.log等日志语句

### 11. types/ - 类型定义
- 共享的TypeScript类型定义

### 12. utils/ - 向后兼容
- 重新导出所有模块，保持向后兼容性

## 导入指南

### 推荐的导入方式（使用具体模块）

```typescript
// 从具体模块导入
import { AstParser } from '../parsers/astParser';
import { DefinitionLogic } from '../finders/definitionLogic';
import { performanceMonitor } from '../monitoring/performanceMonitor';
import { errorHandler } from '../errors/errorHandler';
import { CacheManager } from '../cache/cacheManager';
```

### 简化的导入方式（使用模块索引）

```typescript
// 从模块索引导入
import { AstParser, parseDocument } from '../parsers';
import { DefinitionLogic, ScriptFinder } from '../finders';
import { performanceMonitor } from '../monitoring';
import { errorHandler } from '../errors';
```

### 向后兼容的导入方式（不推荐）

```typescript
// 从utils导入（向后兼容，但不推荐）
import { AstParser, DefinitionLogic } from '../utils';
```

## 迁移说明

如果你有旧的代码使用了 `utils/` 路径，不需要立即修改，因为 `utils/index.ts` 重新导出了所有模块。但建议逐步迁移到新的模块化导入方式，以获得更好的代码组织和IDE支持。

## 优势

1. **清晰的职责划分**: 每个目录都有明确的职责
2. **更好的可维护性**: 相关功能集中在一起，便于查找和修改
3. **模块化**: 每个模块都可以独立开发和测试
4. **可扩展性**: 添加新功能时知道应该放在哪里
5. **向后兼容**: 不会破坏现有代码

## 开发建议

1. 新功能应该放在对应的功能目录中
2. 每个目录都应该有 `index.ts` 导出文件
3. 避免循环依赖
4. 使用具体的模块路径而不是 `utils`
