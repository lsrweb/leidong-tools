# 模块导入快速参考

## 常用模块导入

### 解析器 (Parsers)
```typescript
// AST解析
import { AstParser, parseAST } from '../parsers/astParser';

// 文档解析和Vue索引
import { 
    parseDocument,
    resolveVueIndexForHtml,
    findDefinitionInIndex,
    getOrCreateVueIndexFromContent
} from '../parsers/parseDocument';

// 或使用模块索引
import { AstParser, parseDocument } from '../parsers';
```

### 查找器 (Finders)
```typescript
// 定义查找
import { DefinitionLogic } from '../finders/definitionLogic';

// 脚本查找
import { ScriptFinder, ScriptSource } from '../finders/scriptFinder';

// 模板索引
import { 
    buildAndCacheTemplateIndex,
    findTemplateVar,
    getTemplateIndex
} from '../finders/templateIndexer';

// 或使用模块索引
import { DefinitionLogic, ScriptFinder } from '../finders';
```

### 缓存 (Cache)
```typescript
// 缓存管理
import { 
    CacheManager,
    astIndexCache,
    documentParseCache
} from '../cache/cacheManager';

// LRU缓存
import { LRUCache } from '../cache/lruCache';

// 或使用模块索引
import { CacheManager, LRUCache } from '../cache';
```

### 性能监控 (Monitoring)
```typescript
// 性能监控
import { 
    performanceMonitor,
    monitor,
    withPerformanceMonitoring
} from '../monitoring/performanceMonitor';

// 或使用模块索引
import { performanceMonitor, monitor } from '../monitoring';
```

### 错误处理 (Errors)
```typescript
// 错误处理
import { 
    errorHandler,
    ErrorType,
    safeExecute,
    handleParseError
} from '../errors/errorHandler';

// 或使用模块索引
import { errorHandler, ErrorType } from '../errors';
```

### 辅助函数 (Helpers)
```typescript
// Vue辅助函数
import { 
    findVueDefinition,
    isCommentContent
} from '../helpers/vueHelper';

// 或使用模块索引
import { findVueDefinition } from '../helpers';
```

### 工具命令 (Tools)
```typescript
// 代码压缩
import { compressMultipleLines } from '../tools/codeCompressor';

// 控制台日志
import { 
    insertConsoleLog,
    quickInsertConsoleLog,
    logSelectedVariable
} from '../tools/consoleLogger';

// 或使用模块索引
import { compressMultipleLines, insertConsoleLog } from '../tools';
```

### 管理器 (Managers)
```typescript
// 索引管理
import { registerIndexLifecycle } from '../managers/indexManager';

// 或使用模块索引
import { registerIndexLifecycle } from '../managers';
```

## 性能监控装饰器使用

```typescript
import { monitor } from '../monitoring';

class MyClass {
    @monitor('operationName')
    public async myMethod() {
        // 方法内容
    }
}
```

## 错误处理包装

```typescript
import { safeExecute, ErrorType } from '../errors';

const result = await safeExecute(
    async () => {
        // 可能抛出错误的代码
    },
    ErrorType.PARSE_ERROR,
    { file: 'path/to/file' }
);
```

## 缓存使用

```typescript
import { astIndexCache } from '../cache';

// 设置缓存
astIndexCache.setIndex(content, definitions);

// 获取缓存
const cached = astIndexCache.getIndex(content);

// 清理缓存
astIndexCache.clear();
```

## 向后兼容导入（不推荐）

```typescript
// 旧的导入方式仍然可用，但不推荐
import { 
    AstParser,
    DefinitionLogic,
    performanceMonitor
} from '../utils';
```

## 导入建议

1. **优先使用具体路径**: 直接从具体文件导入，提高IDE智能提示性能
2. **使用模块索引**: 对于同一模块的多个导入，使用模块的 index.ts
3. **避免使用 utils**: 除非是维护旧代码，否则不要使用 utils 导入
4. **保持一致性**: 在同一个文件中保持导入风格一致
