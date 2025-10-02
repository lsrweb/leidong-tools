# Copilot Instructions for Leidong Tools VSCode Extension

## 🚨 AI Agent Guidelines - READ FIRST

### Documentation Generation Policy
**CRITICAL**: When working in agent/agentic mode:

❌ **DO NOT** automatically generate any documentation files unless explicitly requested:
- No README updates
- No CHANGELOG entries  
- No feature documentation (*.md files)
- No code comments beyond inline explanations
- No summary documents
- No tutorial files

✅ **ONLY generate documentation when user explicitly asks:**
- "请生成文档" / "generate documentation"
- "写一个 README" / "write a README"  
- "更新 CHANGELOG" / "update CHANGELOG"
- Direct requests for specific documentation types

**Why**: Keep focus on code implementation. User will request documentation separately when needed.

### Code-First Approach
When implementing features or fixes:
1. Write/modify code directly
2. Add inline comments for complex logic only
3. Update existing docs ONLY if they become incorrect
4. Wait for explicit documentation requests

### Exception Cases
You MAY update documentation without asking ONLY when:
- Fixing obvious typos/errors in existing docs
- Code changes make existing docs factually incorrect
- Adding JSDoc/TypeDoc comments to public APIs

---

## Project Overview
A VSCode extension for Vue.js development productivity, providing intelligent code navigation, completion, and utility commands. Core features: Vue definition jumping (HTML→JS), quick console.log insertion, and code compression.

## Architecture Patterns

### Module Organization (Post-Refactor v1.1.5+)
Files are organized by **function**, not layer. Never add files to `utils/` - it's a compatibility layer only.

```
src/
├── parsers/       # AST & document parsing (astParser, parseDocument)
├── finders/       # Definition/script/template indexing (definitionLogic, scriptFinder, templateIndexer)
├── cache/         # LRU caching (cacheManager, lruCache)
├── monitoring/    # Performance tracking with @monitor decorator
├── errors/        # Centralized error handling with ErrorType enum
├── tools/         # User commands (consoleLogger, codeCompressor)
├── providers/     # VSCode API providers (completion, definition, hover)
├── managers/      # Lifecycle management (indexManager)
└── core/          # Config constants & registration (config.ts, commands.ts, providers.ts)
```

**Import Pattern**: Use specific module paths (`../parsers/parseDocument`) not `../utils`. Each directory exports via `index.ts`.

### Vue Definition Resolution Flow
Critical 3-tier lookup strategy for HTML files:

1. **External Script**: Check `js/<basename>.dev.js` (recursive subdirs) using filesystem with mtime caching
2. **Inline Script**: Parse `<script>` tags containing `new Vue({...})`
3. **Template Variables**: Check v-for/slot-scope local bindings FIRST (via templateIndexer), then Vue index

**Key Files**:
- `finders/definitionLogic.ts`: Entry point, handles `this.`/`that.`/alias detection
- `parsers/parseDocument.ts`: Builds VueIndex from AST (data/methods/computed/mixins)
- `finders/templateIndexer.ts`: Tracks v-for/slot-scope variable scopes with line ranges

### Caching Strategy
**Two-level caching** prevents redundant parsing:

```typescript
// Document-level: Content hash + version check
const hash = fastHash(content);
if (cached && cached.hash === hash) return cached;

// External files: mtime + hash
const stat = fs.statSync(fullPath);
if (cached.mtimeMs === stat.mtimeMs) return cached;
```

**LRU Limits**: Configurable via `maxIndexEntries` (default 200) and `maxTemplateIndexEntries` (300). Cache invalidation on file close/save.

### Configuration System
**Two independent toggles** added in v1.1.6:

- `enableDefinitionJump` (default: true): Controls feature ON/OFF
- `indexLogging` (default: true): Controls debug output ONLY

**Always check feature enabled** in providers:
```typescript
if (!isFeatureEnabled()) return null; // definitionLogic.ts
```

## Development Workflows

### Build & Test
```bash
npm run compile          # Webpack bundle to dist/extension.js
npm run watch           # Auto-rebuild on changes
npm run package         # Production build (hidden source maps)
npm run vsix            # Create .vsix package
```

**No traditional tests yet** - validation via manual testing and compilation.

### Performance Monitoring
Use `@monitor(operationName)` decorator for methods:
```typescript
import { monitor } from '../monitoring/performanceMonitor';

@monitor('findDefinitionInAst')
public async findDefinition() { ... }
```

Access reports: Command Palette → "Show Performance Report"

### Debug Logging
All `console.log('[jump]', ...)` calls MUST check `shouldLog()`:
```typescript
if (this.shouldLog()) { console.log(`[jump][js][hit] ...`); }
```

Patterns: `[jump]`, `[vue-index]`, `[template-index]`, `[parser]`

## Critical Conventions

### AST Parsing with Babel
**Error recovery is essential** for mixed PHP/Layui templates:
```typescript
parser.parse(cleanContent, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
    errorRecovery: true  // CRITICAL for hybrid codebases
});
```

Sanitize before parsing:
```typescript
content
    .replace(/<\?(=|php)?[\s\S]*?\?>/g, m => ' '.repeat(m.length))  // PHP
    .replace(/\{\{[\s\S]*?\}\}/g, m => `''/*${' '.repeat(m.length-5)}*/`); // Layui
```

### Completion Provider Priority
**High priority override** for `.log` suffix completions:
```typescript
item.sortText = '0000';        // Beat built-in suggestions
item.preselect = true;
item.detail = '(雷动三千)';    // Brand identifier
```

### Command Registration Pattern
All commands use `leidong-tools.*` prefix. Registration in `core/commands.ts`:
```typescript
context.subscriptions.push(
    vscode.commands.registerCommand('leidong-tools.commandName', () => { ... })
);
```

### Index Lifecycle Management
Indexes built on:
- Document open (`onDidOpenTextDocument`)
- Editor visible (`onDidChangeVisibleTextEditors`)
- File save (if `rebuildOnSave: true`)

Cleared on:
- Document close (`onDidCloseTextDocument`)
- 10-minute prune cycle for stale entries

**Force rebuild** flag for visible editors (not just open):
```typescript
getOrCreateVueIndexFromContent(content, uri, 0, true); // force=true
```

## Key Integration Points

### VSCode Provider APIs
- **DefinitionProvider**: `VueHtmlDefinitionProvider` → `DefinitionLogic.provideDefinition()`
- **CompletionItemProvider**: 4 providers (QuickLog, MultiVariable, JavaScript, Von)
- **HoverProvider**: `VueHoverProvider.getHoverContent()` with configurable delay

### External Dependencies
- `@babel/*`: AST parsing (parser, traverse, types)
- `vue-template-compiler`: Unused import (artifact, safe to ignore)
- Webpack for bundling (no TypeScript output)

## Anti-Patterns to Avoid

❌ Adding new files to `src/utils/` (use specific module directories)  
❌ Unchecked `console.log()` without `shouldLog()` guard  
❌ Forgetting `errorRecovery: true` in Babel parser config  
❌ Missing `isFeatureEnabled()` check in provider entry points  
❌ Hardcoded file paths (use `vscode.Uri` and `path` module)  
❌ Synchronous file I/O in hot paths (use cached results)

## File Patterns & Conventions

- **TypeScript strict**: `tsconfig.json` has strict checks enabled
- **ESLint**: Custom config in `eslint.config.mjs` (ESLint 9+)
- **Webpack mode**: 'none' for dev, 'production' for package
- **Activation events**: Auto-activate on HTML/JS/TS/Vue/JSON/CSS files
- **Keybindings**: Ctrl+L (log), Ctrl+E (error), Ctrl+Shift+L (selected), Ctrl+Alt+L/E (alternative)

## Quick Reference Commands

```bash
# Development
npm run watch                     # Hot reload during dev
npm run compile                   # One-time build

# Publishing
npm run package                   # Minified production build
npm run vsix                      # Create installable .vsix

# Extension Commands (Command Palette)
Toggle Definition Jump Feature    # Enable/disable jumping
Toggle Index Logging             # Debug output control
Clear Vue Index Cache            # Force cache clear
Show Performance Report          # Timing analysis
```