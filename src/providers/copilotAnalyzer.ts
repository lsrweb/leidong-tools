/**
 * @file copilotAnalyzer.ts
 * @description 接入 GitHub Copilot Chat，分析 Vue 变量/方法的引用上下文和逻辑关系
 *
 * 两种触发方式：
 *   1. CodeLens 上的「🔍 分析」按钮 → 调用命令 leidong-tools.analyzeWithCopilot
 *   2. Chat 参与者 @leidong-tools /analyze variableName
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    resolveVueIndexForHtml,
    buildVueIndexForContent,
    getExternalDevScriptPathsForHtml,
    findDefinitionInIndex
} from '../parsers/parseDocument';
import type { VueIndex } from '../parsers/parseDocument';

// ─── 上下文收集 ───

interface ReferenceContext {
    identifier: string;
    category: string;          // data / methods / computed / function ...
    definitionSnippet: string;  // 定义处代码片段
    definitionFile: string;
    definitionLine: number;
    componentSummary: string;   // 整个组件的成员概览
    htmlReferences: { file: string; line: number; snippet: string }[];
    jsReferences: { file: string; line: number; snippet: string }[];
    relatedDefinitions: { name: string; category: string; snippet: string; file: string; line: number }[];
}

const CONTEXT_LINES = 10; // 默认较多

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 获取带行号的代码片段（用于用户预览）
 */
function getSnippetWithLineNumbers(lines: string[], startLine: number, endLine: number, highlightLine?: number): string {
    const result: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
        if (i < 0 || i >= lines.length) { continue; }
        const marker = (highlightLine !== undefined && i === highlightLine) ? ' >> ' : '    ';
        result.push(`${marker}${i + 1}: ${lines[i]}`);
    }
    return result.join('\n');
}

/**
 * 获取纯净的代码块（用于发送给 AI）
 */
function getCleanCodeBlock(lines: string[], startLine: number, endLine: number): string {
    const result: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
        if (i < 0 || i >= lines.length) { continue; }
        result.push(lines[i]);
    }
    return result.join('\n');
}

/**
 * 收集某个标识符的所有引用上下文
 */
export function collectReferenceContext(
    identifier: string,
    document: vscode.TextDocument
): ReferenceContext | null {
    let vueIndex: VueIndex | null = null;
    let jsText = '';
    let jsFilePath = '';
    let htmlTexts: { file: string; text: string }[] = [];

    try {
        if (document.languageId === 'javascript' || document.languageId === 'typescript' || document.languageId === 'vue') {
            jsText = document.getText();
            jsFilePath = document.uri.fsPath;
            vueIndex = buildVueIndexForContent(jsText, document.uri, 0);

            // 找关联 HTML
            for (const doc of vscode.workspace.textDocuments) {
                if (doc.languageId === 'html' && !doc.isClosed) {
                    try {
                        const scriptPaths = getExternalDevScriptPathsForHtml(doc);
                        for (const sp of scriptPaths) {
                            if (path.normalize(sp).toLowerCase() === path.normalize(jsFilePath).toLowerCase()) {
                                htmlTexts.push({ file: doc.uri.fsPath, text: doc.getText() });
                            }
                        }
                    } catch { /* */ }
                }
            }
            // 目录约定
            const dir = path.dirname(jsFilePath);
            const parentDir = path.dirname(dir);
            const baseName = path.basename(jsFilePath).replace(/\.dev\.js$/, '').replace(/\.js$/, '');
            for (const c of [
                path.join(parentDir, `${baseName}.html`),
                path.join(parentDir, 'index.html'),
            ]) {
                if (fs.existsSync(c) && !htmlTexts.some(h => path.normalize(h.file).toLowerCase() === path.normalize(c).toLowerCase())) {
                    try { htmlTexts.push({ file: c, text: fs.readFileSync(c, 'utf8') }); } catch { /* */ }
                }
            }
        } else if (document.languageId === 'html') {
            htmlTexts.push({ file: document.uri.fsPath, text: document.getText() });
            vueIndex = resolveVueIndexForHtml(document, true);
            if (vueIndex) {
                const def = findDefinitionInIndex(identifier, vueIndex);
                if (def && def.uri.fsPath !== document.uri.fsPath) {
                    jsFilePath = def.uri.fsPath;
                    try { jsText = fs.readFileSync(jsFilePath, 'utf8'); } catch { /* */ }
                }
            }
        }
    } catch { /* */ }

    // 确定 category
    let category = 'unknown';
    let componentSummary = '';
    if (vueIndex) {
        if (vueIndex.data.has(identifier)) { category = 'data'; }
        else if (vueIndex.methods.has(identifier)) { category = 'methods'; }
        else if (vueIndex.computed.has(identifier)) { category = 'computed'; }
        else if (vueIndex.props.has(identifier)) { category = 'props'; }
        else if (vueIndex.filters.has(identifier)) { category = 'filters'; }
        else if (vueIndex.mixinData.has(identifier)) { category = 'mixin data'; }
        else if (vueIndex.mixinMethods.has(identifier)) { category = 'mixin methods'; }
        else if (vueIndex.mixinComputed.has(identifier)) { category = 'mixin computed'; }

        // 构建组件概览，让 AI 理解大的上下文
        const summaryParts: string[] = [];
        if (vueIndex.props.size) { summaryParts.push(`Props: ${Array.from(vueIndex.props.keys()).join(', ')}`); }
        if (vueIndex.data.size) { summaryParts.push(`Data: ${Array.from(vueIndex.data.keys()).join(', ')}`); }
        if (vueIndex.computed.size) { summaryParts.push(`Computed: ${Array.from(vueIndex.computed.keys()).join(', ')}`); }
        if (vueIndex.methods.size) { summaryParts.push(`Methods: ${Array.from(vueIndex.methods.keys()).join(', ')}`); }
        componentSummary = summaryParts.join('\n');
    }
    // 全局函数
    if (category === 'unknown' && jsText) {
        const funcRe = new RegExp(`^function\\s+${escapeRegex(identifier)}\\s*\\(`, 'm');
        if (funcRe.test(jsText)) { category = 'function'; }
    }

    if (category === 'unknown' && !vueIndex) { return null; }

    // 定义片段
    let definitionSnippet = '';
    let definitionLine = 0;
    const jsLines = jsText ? jsText.split('\n') : [];

    if (vueIndex) {
        const loc = findDefinitionInIndex(identifier, vueIndex);
        if (loc) {
            definitionLine = loc.range.start.line;
            // 使用 full range 获取完整定义
            definitionSnippet = getCleanCodeBlock(jsLines, loc.range.start.line, loc.range.end.line);
        }
    }
    if (!definitionSnippet && jsText) {
        // 全局函数
        const funcRe = new RegExp(`^function\\s+${escapeRegex(identifier)}\\s*\\(`, 'gm');
        const fm = funcRe.exec(jsText);
        if (fm) {
            definitionLine = jsText.substring(0, fm.index).split('\n').length - 1;
            // 尝试找到函数结束
            let braceCount = 0;
            let endLine = definitionLine;
            for (let i = definitionLine; i < jsLines.length && i < definitionLine + 300; i++) {
                for (const ch of jsLines[i]) {
                    if (ch === '{') { braceCount++; }
                    if (ch === '}') { braceCount--; }
                }
                endLine = i;
                if (braceCount <= 0 && i > definitionLine) { break; }
            }
            definitionSnippet = getCleanCodeBlock(jsLines, definitionLine, endLine);
        }
    }

    // 构建所有已知方法/计算属性的行范围表，用于快速查找引用行所属方法
    const knownRanges: { name: string; startLine: number; endLine: number }[] = [];
    if (vueIndex) {
        for (const map of [vueIndex.methods, vueIndex.computed, vueIndex.data]) {
            map.forEach((loc, name) => {
                if (loc.range.end.line > loc.range.start.line) {
                    knownRanges.push({ name, startLine: loc.range.start.line, endLine: loc.range.end.line });
                }
            });
        }
    }

    /**
     * 从某一行向上找函数/方法起点，向下追踪大括号闭合，提取完整方法体
     */
    function extractEnclosingBlock(lineIdx: number): { start: number; end: number; name: string } | null {
        // 1. 先查 VueIndex 已知范围
        for (const r of knownRanges) {
            if (lineIdx >= r.startLine && lineIdx <= r.endLine) {
                return { start: r.startLine, end: r.endLine, name: r.name };
            }
        }
        // 2. 回退到大括号匹配：向上找方法签名
        let methodStart = lineIdx;
        const methodSigRe = /^\s*(?:(?:async\s+)?\w+\s*\(|(?:async\s+)?function\s|\w+\s*:\s*(?:async\s+)?function)/;
        for (let k = lineIdx; k >= Math.max(0, lineIdx - 80); k--) {
            if (methodSigRe.test(jsLines[k])) {
                methodStart = k;
                break;
            }
        }
        // 从 methodStart 向下追踪大括号闭合
        let braceCount = 0;
        let foundOpen = false;
        let methodEnd = methodStart;
        for (let k = methodStart; k < jsLines.length && k < methodStart + 500; k++) {
            for (const ch of jsLines[k]) {
                if (ch === '{') { braceCount++; foundOpen = true; }
                if (ch === '}') { braceCount--; }
            }
            methodEnd = k;
            if (foundOpen && braceCount <= 0) { break; }
        }
        if (!foundOpen) { return null; }
        // 提取方法名
        const nameMatch = jsLines[methodStart].match(/(?:async\s+)?(\w+)\s*[:(]/);
        const name = nameMatch ? nameMatch[1] : 'anonymous';
        return { start: methodStart, end: methodEnd, name };
    }

    // JS 引用：提取完整的所属方法体，同一方法只发一次
    const jsReferences: ReferenceContext['jsReferences'] = [];
    if (jsText) {
        const aliasPattern = `(?:this|that|_this|self|_self|vm|_vm|me|ctx|app)\\.${escapeRegex(identifier)}\\b`;
        const directCallPattern = `\\b${escapeRegex(identifier)}\\s*\\(`;
        const combined = new RegExp(`${aliasPattern}|${directCallPattern}`, 'g');
        const emittedRanges = new Set<string>(); // 用于去重："startLine-endLine"

        for (let i = 0; i < jsLines.length; i++) {
            if (i === definitionLine) { continue; }
            combined.lastIndex = 0;
            if (combined.test(jsLines[i])) {
                const block = extractEnclosingBlock(i);
                if (block) {
                    const rangeKey = `${block.start}-${block.end}`;
                    if (emittedRanges.has(rangeKey)) { continue; } // 已经发送过这个方法
                    emittedRanges.add(rangeKey);
                    jsReferences.push({
                        file: jsFilePath,
                        line: block.start + 1,
                        snippet: getCleanCodeBlock(jsLines, block.start, block.end),
                    });
                } else {
                    // 最后兜底：发单行上下文
                    const start = Math.max(0, i - 3);
                    const end = Math.min(jsLines.length - 1, i + 3);
                    jsReferences.push({
                        file: jsFilePath,
                        line: i + 1,
                        snippet: getCleanCodeBlock(jsLines, start, end),
                    });
                }
            }
        }
    }

    // HTML 引用
    const htmlReferences: ReferenceContext['htmlReferences'] = [];
    const identifierRe = new RegExp(`\\b${escapeRegex(identifier)}\\b`);
    for (const { file, text } of htmlTexts) {
        const hLines = text.split('\n');
        for (let i = 0; i < hLines.length; i++) {
            if (identifierRe.test(hLines[i])) {
                // 查找该行所属的完整标签块
                let start = i;
                let end = i;
                // 向上找 <
                for (let k = i; k >= Math.max(0, i - 15); k--) {
                    if (hLines[k].includes('<')) { start = k; break; }
                }
                // 向下找 >
                for (let k = i; k < Math.min(hLines.length, i + 15); k++) {
                    if (hLines[k].includes('>')) { end = k; break; }
                }

                htmlReferences.push({
                    file,
                    line: i + 1,
                    snippet: getCleanCodeBlock(hLines, start, end),
                });
            }
        }
    }

    // ─── 收集传递依赖：引用方法内部调用的其他方法/属性 ───
    const relatedDefinitions: ReferenceContext['relatedDefinitions'] = [];
    if (vueIndex && jsLines.length > 0) {
        const visited = new Set<string>();
        visited.add(identifier); // 排除目标本身（已在 definitionSnippet 中）

        // 也排除已经作为 jsReference 直接收集的方法名（避免重复输出）
        for (const r of knownRanges) {
            // 如果某个 knownRange 已被 jsReferences 命中，记录其名称
            for (const jr of jsReferences) {
                const jrStart = jr.line - 1; // jr.line 是 1-based
                if (r.startLine === jrStart) {
                    // 这个方法已作为直接引用发送，但我们仍需扫描其内部依赖
                }
            }
        }

        /**
         * 从代码片段中提取所有 this.xxx 引用的标识符
         */
        function extractThisRefs(snippet: string): string[] {
            const re = /(?:this|that|_this|self|_self|vm|_vm|me|ctx|app)\.(\w+)/g;
            const refs: string[] = [];
            let m;
            while ((m = re.exec(snippet)) !== null) {
                if (!visited.has(m[1])) {
                    refs.push(m[1]);
                }
            }
            return [...new Set(refs)]; // 去重
        }

        /**
         * 递归收集传递依赖
         * @param snippets 待扫描的代码片段
         * @param depth 当前递归深度（最大 3 层）
         */
        function collectTransitiveDeps(snippets: string[], depth: number): void {
            if (depth > 3 || snippets.length === 0) { return; }
            const newSnippets: string[] = [];

            for (const snippet of snippets) {
                const refs = extractThisRefs(snippet);
                for (const dep of refs) {
                    if (visited.has(dep)) { continue; }
                    visited.add(dep);

                    // 在 VueIndex 中查找
                    let depCategory = '';
                    let depLoc: vscode.Location | undefined;
                    if (vueIndex!.methods.has(dep)) { depCategory = 'methods'; depLoc = vueIndex!.methods.get(dep); }
                    else if (vueIndex!.computed.has(dep)) { depCategory = 'computed'; depLoc = vueIndex!.computed.get(dep); }
                    else if (vueIndex!.data.has(dep)) { depCategory = 'data'; depLoc = vueIndex!.data.get(dep); }
                    else if (vueIndex!.props.has(dep)) { depCategory = 'props'; depLoc = vueIndex!.props.get(dep); }
                    else if (vueIndex!.filters.has(dep)) { depCategory = 'filters'; depLoc = vueIndex!.filters.get(dep); }
                    else if (vueIndex!.mixinMethods.has(dep)) { depCategory = 'mixin methods'; depLoc = vueIndex!.mixinMethods.get(dep); }
                    else if (vueIndex!.mixinComputed.has(dep)) { depCategory = 'mixin computed'; depLoc = vueIndex!.mixinComputed.get(dep); }
                    else if (vueIndex!.mixinData.has(dep)) { depCategory = 'mixin data'; depLoc = vueIndex!.mixinData.get(dep); }

                    if (depLoc) {
                        const depSnippet = getCleanCodeBlock(jsLines, depLoc.range.start.line, depLoc.range.end.line);
                        relatedDefinitions.push({
                            name: dep,
                            category: depCategory,
                            snippet: depSnippet,
                            file: jsFilePath,
                            line: depLoc.range.start.line + 1
                        });
                        // 对方法/计算属性继续递归（data/props 通常无内部调用）
                        if (depCategory === 'methods' || depCategory === 'computed' || depCategory === 'mixin methods' || depCategory === 'mixin computed') {
                            newSnippets.push(depSnippet);
                        }
                    }
                    // 防止收集过多（上限 30 个关联定义）
                    if (relatedDefinitions.length >= 30) { return; }
                }
            }

            if (newSnippets.length > 0) {
                collectTransitiveDeps(newSnippets, depth + 1);
            }
        }

        // 第一轮：从定义本身 + 所有直接引用方法体中提取依赖
        const initialSnippets: string[] = [];
        if (definitionSnippet) { initialSnippets.push(definitionSnippet); }
        for (const jr of jsReferences) { initialSnippets.push(jr.snippet); }
        collectTransitiveDeps(initialSnippets, 0);
    }

    return {
        identifier,
        category,
        definitionSnippet,
        definitionFile: jsFilePath,
        definitionLine: definitionLine + 1,
        componentSummary,
        htmlReferences,
        jsReferences,
        relatedDefinitions,
    };
}

// ─── 构建 Prompt ───

/**
 * 优化后的系统提示词
 */
const SYSTEM_PROMPT = `你是一位经验丰富的 Vue 前端开发专家，负责帮助开发者快速理解代码逻辑。用户会提供一个 Vue 组件中的变量或方法，以及它的所有相关代码。

请按以下结构分析：
1. **作用说明**：用简明的语言描述这个标识符的功能和业务用途。
2. **数据流向**：说明它的初始值、在哪些地方被修改、修改后会影响哪些地方。
3. **关联关系**：它依赖了哪些变量/方法？又被哪些方法调用？理清上下游。
4. **页面使用**：根据提供的 HTML 引用说明它在页面中的表现。**如果没有提供 HTML 引用，直接写「页面中未发现使用」，禁止猜测。**
5. **潜在问题**：指出可能存在的问题，如冗余代码、易出错写法、性能问题等。
6. **改进建议**：给出具体可操作的优化方案。
7. **完整调用链**：你会收到所有关联方法和变量的完整代码，请逐个说明其作用，并画出完整的调用流程图。

输出要求：
- 中文回复，表述清晰易懂，避免堆砌学术术语。
- 代码中的标识符（变量名、方法名等）保持原样。
- 必须包含 Mermaid 流程图（graph TD），将所有提供的关联方法纳入，展示完整调用链路。
- **Mermaid 图表中的节点说明和连线描述使用中文。**
- Markdown 格式排版，结构清晰，重点突出。`;

function buildAnalysisPrompt(ctx: ReferenceContext): string {
    const parts: string[] = [];

    parts.push(`## 分析目标：\`${ctx.identifier}\`（${ctx.category}）\n`);

    if (ctx.componentSummary) {
        parts.push(`### 组件整体环境概览\n此标识符运行在如下环境中，请结合相关成员分析：\n\`\`\`text\n${ctx.componentSummary}\n\`\`\`\n`);
    }

    if (ctx.definitionSnippet) {
        parts.push(`### 定义位置\n文件: ${path.basename(ctx.definitionFile)} 第 ${ctx.definitionLine} 行\n\`\`\`javascript\n${ctx.definitionSnippet}\n\`\`\`\n`);
    }

    if (ctx.jsReferences.length > 0) {
        parts.push(`### JS 中的引用 (显示前 50 处)\n`);
        const refs = ctx.jsReferences.slice(0, 50);
        for (const ref of refs) {
            parts.push(`**${path.basename(ref.file)}:${ref.line}**\n\`\`\`javascript\n${ref.snippet}\n\`\`\`\n`);
        }
        if (ctx.jsReferences.length > 50) {
            parts.push(`... 以及其他 ${ctx.jsReferences.length - 50} 处 JS 引用\n`);
        }
    }

    if (ctx.htmlReferences.length > 0) {
        parts.push(`### HTML 模板中的引用 (显示前 30 处)\n`);
        const refs = ctx.htmlReferences.slice(0, 30);
        for (const ref of refs) {
            parts.push(`**${path.basename(ref.file)}:${ref.line}**\n\`\`\`html\n${ref.snippet}\n\`\`\`\n`);
        }
        if (ctx.htmlReferences.length > 30) {
            parts.push(`... 以及其他 ${ctx.htmlReferences.length - 30} 处 HTML 引用\n`);
        }
    }

    if (ctx.relatedDefinitions && ctx.relatedDefinitions.length > 0) {
        parts.push(`### 关联方法/属性完整定义\n以下是引用链中递归涉及的其他方法/属性的完整代码，请在分析和流程图中一并覆盖，不得遗漏：\n`);
        for (const rd of ctx.relatedDefinitions) {
            parts.push(`**${rd.name}** (${rd.category}) - ${path.basename(rd.file)}:${rd.line}\n\`\`\`javascript\n${rd.snippet}\n\`\`\`\n`);
        }
    }

    return parts.join('\n');
}

// ─── Webview 渲染逻辑 ───

/**
 * 获取用于 Markdown 渲染的 HTML（使用 CDN 上的 marked.js）
 */
function getHtmlForAnalysis(webview: vscode.Webview, identifier: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'unsafe-inline' https://cdn.jsdelivr.net ${webview.cspSource};">
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-editor-foreground);
            padding: 24px;
            line-height: 1.6;
            max-width: 900px;
            margin: 0 auto;
        }
        pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 14px;
            border-radius: 6px;
            overflow: auto;
            border: 1px solid var(--vscode-widget-border);
        }
        /* Mermaid 图表容器样式 - 黑色主题优化 + 缩放支持 */
        .mermaid-wrapper {
            position: relative;
            background-color: #1e1e1e;
            border-radius: 8px;
            margin: 16px 0;
            border: 1px solid #333;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        .mermaid-toolbar {
            display: flex;
            justify-content: flex-end;
            gap: 4px;
            padding: 6px 10px;
            background: #252526;
            border-bottom: 1px solid #333;
        }
        .mermaid-toolbar button {
            background: #3c3c3c;
            color: #ccc;
            border: 1px solid #555;
            border-radius: 4px;
            padding: 2px 10px;
            cursor: pointer;
            font-size: 14px;
            line-height: 1.4;
        }
        .mermaid-toolbar button:hover {
            background: #505050;
            color: #fff;
        }
        .mermaid-viewport {
            overflow: hidden;
            padding: 16px;
            text-align: center;
            cursor: grab;
            min-height: 100px;
            position: relative;
        }
        .mermaid-viewport.dragging {
            cursor: grabbing;
            user-select: none;
        }
        .mermaid {
            display: inline-block;
            transform-origin: 0 0;
            transition: transform 0.1s ease;
        }
        code {
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
        }
        h1, h2, h3 {
            color: var(--vscode-symbolIcon-methodForeground);
            border-bottom: 1px solid var(--vscode-textSeparator-foreground);
            padding-bottom: 10px;
            margin-top: 32px;
        }
        h1 { font-size: 1.8em; margin-top: 0; }

        /* 代码预览区域样式 */
        #preview-area {
            margin-bottom: 24px;
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            background-color: var(--vscode-sideBar-background);
            overflow: hidden;
        }
        .preview-header {
            padding: 10px 16px;
            background-color: var(--vscode-editor-lineHighlightBackground);
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-weight: bold;
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
        }
        .preview-header:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .preview-content {
            padding: 12px;
            display: none; /* 默认隐藏 */
            max-height: 400px;
            overflow-y: auto;
        }
        .preview-item {
            margin-bottom: 16px;
        }
        .preview-item-title {
            font-size: 0.8em;
            color: var(--vscode-textLink-foreground);
            margin-bottom: 4px;
        }
        .preview-item pre {
            margin: 0;
            padding: 8px;
            font-size: 0.85em;
        }

        blockquote {
            background: var(--vscode-textBlockQuote-background);
        }
        .loading {
            font-style: italic;
            opacity: 0.7;
            display: flex;
            align-items: center;
            gap: 12px;
            margin-top: 20px;
            padding: 10px;
            background: var(--vscode-badge-background);
            border-radius: 4px;
            width: fit-content;
        }
        .loading::after {
            content: "";
            width: 14px;
            height: 14px;
            border: 2px solid var(--vscode-progressBar-background);
            border-top: 2px solid transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        #content {
            animation: fadeIn 0.5s ease-in;
        }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    </style>
</head>
<body>
    <div id="header">
        <h1>AI 深度分析: ${identifier}</h1>
    </div>

    <!-- 新增：上下文预览区域（默认折叠） -->
    <div id="preview-area">
        <div class="preview-header" onclick="togglePreview()">
            <span>📦 本次分析收集的上下文 (供 AI 参考)</span>
            <span id="preview-arrow">▼</span>
        </div>
        <div id="preview-content" class="preview-content">
            <p style="font-size: 0.85em; opacity: 0.7;">正在整理定义与引用信息...</p>
        </div>
    </div>

    <div id="content">正在收集数据流与上下文信息...</div>
    <div id="status" class="loading">AI 思考中...</div>

    <script>
        const contentDiv = document.getElementById('content');
        const previewContent = document.getElementById('preview-content');
        const statusDiv = document.getElementById('status');
        const arrow = document.getElementById('preview-arrow');
        let fullMarkdown = "";
        let isFirstFragment = true;

        function togglePreview() {
            const isVisible = previewContent.style.display === 'block';
            previewContent.style.display = isVisible ? 'none' : 'block';
            arrow.innerText = isVisible ? '▼' : '▲';
        }

        const isDark = document.body.classList.contains('vscode-dark');
        mermaid.initialize({ 
            startOnLoad: false, 
            theme: 'dark', // 强制使用黑色主题
            securityLevel: 'loose' 
        });

        const renderer = new marked.Renderer();
        const baseCode = renderer.code.bind(renderer);
        renderer.code = function(code, lang) {
            // 老版本 marked 为 (code, lang)，新版本为 (token)
            const text = typeof code === 'object' ? code.text : code;
            const infostring = typeof code === 'object' ? code.lang : lang;
            if (infostring === 'mermaid') {
                var id = 'mermaid-' + Math.random().toString(36).substr(2, 9);
                return '<div class="mermaid-wrapper" id="wrap-' + id + '">'
                    + '<div class="mermaid-toolbar">'
                    + '<button onclick="zoomChart(\\'' + id + '\\', 0.2)" title="\u653e\u5927">+</button>'
                    + '<button onclick="zoomChart(\\'' + id + '\\', -0.2)" title="\u7f29\u5c0f">\u2212</button>'
                    + '<button onclick="resetChart(\\'' + id + '\\')" title="\u91cd\u7f6e">1:1</button>'
                    + '</div>'
                    + '<div class="mermaid-viewport" id="vp-' + id + '">'
                    + '<div class="mermaid" id="' + id + '">' + text + '</div>'
                    + '</div></div>';
            }
            return baseCode(code, lang);
        };
        marked.setOptions({ renderer });

        // ─── 图表缩放与拖拽控制 ───
        var chartState = {}; // { scale, tx, ty }

        function getState(id) {
            if (!chartState[id]) { chartState[id] = { scale: 1, tx: 0, ty: 0 }; }
            return chartState[id];
        }

        function applyTransform(id) {
            var s = getState(id);
            var el = document.getElementById(id);
            if (el) {
                el.style.transition = 'transform 0.1s ease';
                el.style.transform = 'translate(' + s.tx + 'px, ' + s.ty + 'px) scale(' + s.scale + ')';
            }
        }

        function zoomChart(id, delta) {
            var s = getState(id);
            s.scale = Math.max(0.3, Math.min(3, s.scale + delta));
            applyTransform(id);
        }

        function resetChart(id) {
            var s = getState(id);
            s.scale = 1; s.tx = 0; s.ty = 0;
            applyTransform(id);
        }

        // 鼠标滚轮缩放
        document.addEventListener('wheel', function(e) {
            var vp = e.target.closest('.mermaid-viewport');
            if (!vp) return;
            e.preventDefault();
            var mermaidEl = vp.querySelector('.mermaid');
            if (!mermaidEl) return;
            var delta = e.deltaY < 0 ? 0.1 : -0.1;
            zoomChart(mermaidEl.id, delta);
        }, { passive: false });

        // 鼠标拖拽平移
        (function() {
            var dragId = null, startX = 0, startY = 0, startTx = 0, startTy = 0;

            document.addEventListener('mousedown', function(e) {
                var vp = e.target.closest('.mermaid-viewport');
                if (!vp || e.button !== 0) return;
                var mermaidEl = vp.querySelector('.mermaid');
                if (!mermaidEl) return;
                dragId = mermaidEl.id;
                var s = getState(dragId);
                startX = e.clientX; startY = e.clientY;
                startTx = s.tx; startTy = s.ty;
                vp.classList.add('dragging');
                mermaidEl.style.transition = 'none';
                e.preventDefault();
            });

            document.addEventListener('mousemove', function(e) {
                if (!dragId) return;
                var s = getState(dragId);
                s.tx = startTx + (e.clientX - startX);
                s.ty = startTy + (e.clientY - startY);
                var el = document.getElementById(dragId);
                if (el) { el.style.transform = 'translate(' + s.tx + 'px, ' + s.ty + 'px) scale(' + s.scale + ')'; }
            });

            document.addEventListener('mouseup', function() {
                if (!dragId) return;
                var el = document.getElementById(dragId);
                if (el) {
                    var vp = el.closest('.mermaid-viewport');
                    if (vp) { vp.classList.remove('dragging'); }
                }
                dragId = null;
            });
        })();

        async function render() {
            contentDiv.innerHTML = marked.parse(fullMarkdown);
            try {
                // 如果图表还不完整（还在流式输出中），mermaid.run 可能抛错，我们将其静默
                await mermaid.run({ querySelector: '.mermaid' });
            } catch (e) {
                // 静默由于流式输出导致的图变解析错误
            }
        }

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'refCtx':
                    renderRefCtx(message.data);
                    break;
                case 'append':
                    if (isFirstFragment && message.text) {
                        contentDiv.innerHTML = "";
                        isFirstFragment = false;
                    }
                    fullMarkdown += message.text;
                    render();
                    window.scrollTo(0, document.body.scrollHeight);
                    break;
                case 'done':
                    statusDiv.style.display = 'none';
                    render(); // 最终渲染一次，确保图表闭合
                    break;
                case 'error':
                    statusDiv.innerHTML = '<span style="color:var(--vscode-errorForeground)">❌ 分析中止: ' + message.text + '</span>';
                    statusDiv.classList.remove('loading');
                    break;
            }
        });

        function renderRefCtx(ctx) {
            let html = "";
            
            // 定义
            if (ctx.definitionSnippet) {
                html += '<div class="preview-item">';
                html += '<div class="preview-item-title">定义: ' + (ctx.definitionFile.split("/").pop().split("\\\\").pop()) + ':' + ctx.definitionLine + '</div>';
                html += '<pre>' + escapeHtml(ctx.definitionSnippet) + '</pre>';
                html += '</div>';
            }

            // JS 引用
            if (ctx.jsReferences && ctx.jsReferences.length > 0) {
                ctx.jsReferences.forEach((ref, idx) => {
                   html += '<div class="preview-item">';
                   html += '<div class="preview-item-title">JS 引用 #' + (idx+1) + ': ' + (ref.file.split("/").pop().split("\\\\").pop()) + ':' + ref.line + '</div>';
                   html += '<pre>' + escapeHtml(ref.snippet) + '</pre>';
                   html += '</div>';
                });
            }

            // HTML 引用
            if (ctx.htmlReferences && ctx.htmlReferences.length > 0) {
                ctx.htmlReferences.forEach((ref, idx) => {
                   html += '<div class="preview-item">';
                   html += '<div class="preview-item-title">HTML 引用 #' + (idx+1) + ': ' + (ref.file.split("/").pop().split("\\\\").pop()) + ':' + ref.line + '</div>';
                   html += '<pre>' + escapeHtml(ref.snippet) + '</pre>';
                   html += '</div>';
                });
            }

            // 关联方法/属性
            if (ctx.relatedDefinitions && ctx.relatedDefinitions.length > 0) {
                html += '<div class="preview-item-title" style="margin-top:12px;font-weight:bold;font-size:0.9em;">&#128279; 关联方法/属性 (' + ctx.relatedDefinitions.length + ')</div>';
                ctx.relatedDefinitions.forEach(function(rd) {
                   html += '<div class="preview-item">';
                   html += '<div class="preview-item-title">' + rd.name + ' (' + rd.category + ')</div>';
                   html += '<pre>' + escapeHtml(rd.snippet) + '</pre>';
                   html += '</div>';
                });
            }

            previewContent.innerHTML = html;
        }

        function escapeHtml(text) {
            const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
            return text.replace(/[&<>"']/g, function(m) { return map[m]; });
        }
    </script>
</body>
</html>`;
}

// ─── 模型选择逻辑 ───

const LAST_MODEL_KEY = 'leidong-tools.lastSelectedModelId';

async function selectChatModel(context: vscode.ExtensionContext): Promise<vscode.LanguageModelChat | undefined> {
    const allModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (allModels.length === 0) {
        return undefined;
    }

    // 1. 优先使用上次选择的模型（通过命令切换）
    const lastModelId = context.globalState.get<string>(LAST_MODEL_KEY);
    if (lastModelId) {
        const found = allModels.find(m => m.id === lastModelId);
        if (found) { return found; }
    }

    // 2. 没有保存的模型，弹框让用户选择，并保存
    const items = allModels.map(m => ({
        label: `$(sparkle) ${m.name || m.id}`,
        description: `${m.vendor} / ${m.family}`,
        detail: `API 版本: ${m.version}`,
        model: m
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: '请选择本次分析使用的 AI 模型',
        title: '雷动三千 - AI 模型选择'
    });

    if (selected) {
        // 保存本次选择，下次默认跳过弹框
        context.globalState.update(LAST_MODEL_KEY, selected.model.id);
        return selected.model;
    }

    return undefined;
}

// ─── Chat Participant ───

const PARTICIPANT_ID = 'leidong-tools.analyzer';

interface IChatResult extends vscode.ChatResult {
    metadata: { command: string };
}

export function registerCopilotAnalyzer(context: vscode.ExtensionContext): void {

    // 1. 注册 Chat 参与者 @leidong-tools (保持兼容，但优化 Prompt)
    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<IChatResult> => {

        const identifier = request.prompt.trim();
        if (!identifier) {
            stream.markdown('请提供分析目标。用法：`@leidong-tools /analyze variableName`');
            return { metadata: { command: '' } };
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            stream.markdown('请先打开一个 Vue/JS/HTML 文件。');
            return { metadata: { command: '' } };
        }

        const refCtx = collectReferenceContext(identifier, editor.document);
        if (!refCtx) {
            stream.markdown(`未能解析 \`${identifier}\` 的上下文。`);
            return { metadata: { command: '' } };
        }

        const contextText = buildAnalysisPrompt(refCtx);
        try {
            const model = await selectChatModel(context);
            if (!model) {
                stream.markdown('❌ 未选择模型或无可用模型。');
                return { metadata: { command: 'analyze' } };
            }

            const messages = [
                vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
                vscode.LanguageModelChatMessage.User(contextText),
            ];

            const response = await model.sendRequest(messages, {}, token);
            for await (const fragment of response.text) {
                stream.markdown(fragment);
            }
        } catch (err: any) {
            stream.markdown(`⚠️ 异常: ${err.message}`);
        }

        return { metadata: { command: 'analyze' } };
    };

    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    participant.iconPath = new vscode.ThemeIcon('hubot');

    context.subscriptions.push(participant);

    // 2. 注册核心命令：独立窗口 AI 分析分析
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'leidong-tools.analyzeWithCopilot',
            async (identifier: string, documentUri?: vscode.Uri) => {
                // 检查开关
                const isEnabled = vscode.workspace.getConfiguration('leidong-tools').get('enableAIAnalysis', false);
                if (!isEnabled) {
                    const act = await vscode.window.showWarningMessage('AI 分析功能尚未开启，是否前往设置开启？', '去开启');
                    if (act === '去开启') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'leidong-tools.enableAIAnalysis');
                    }
                    return;
                }

                // 获取当前正在编辑的文件或传入的文件
                let doc: vscode.TextDocument | undefined;
                if (documentUri) {
                    doc = await vscode.workspace.openTextDocument(documentUri);
                } else {
                    doc = vscode.window.activeTextEditor?.document;
                }

                if (!doc) {
                    vscode.window.showErrorMessage('无法获取待分析文档。');
                    return;
                }

                // 如果 identifier 是空的，提示输入
                if (!identifier) {
                    identifier = await vscode.window.showInputBox({ prompt: '请输入要分析的变量或方法名' }) || '';
                }
                if (!identifier) { return; }

                // 准备 Webview 窗口
                const panel = vscode.window.createWebviewPanel(
                    'aiAnalysis',
                    `AI 分析: ${identifier}`,
                    vscode.ViewColumn.Beside,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true
                    }
                );

                panel.webview.html = getHtmlForAnalysis(panel.webview, identifier);

                // 逻辑执行
                try {
                    const refCtx = collectReferenceContext(identifier, doc);
                    if (!refCtx) {
                        panel.webview.postMessage({ type: 'error', text: '未找到该标识符的定义或引用上下文。' });
                        return;
                    }

                    // 展示在预览区域
                    panel.webview.postMessage({ type: 'refCtx', data: refCtx });

                    const model = await selectChatModel(context);
                    if (!model) {
                        panel.webview.postMessage({ type: 'error', text: '已取消模型选择。' });
                        return;
                    }

                    const contextText = buildAnalysisPrompt(refCtx);
                    const messages = [
                        vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
                        vscode.LanguageModelChatMessage.User(contextText),
                    ];

                    const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
                    
                    panel.webview.postMessage({ type: 'append', text: '' }); // 清除初始文字
                    for await (const fragment of response.text) {
                        panel.webview.postMessage({ type: 'append', text: fragment });
                    }
                    panel.webview.postMessage({ type: 'done' });

                } catch (err: any) {
                    panel.webview.postMessage({ type: 'error', text: err.message || '未知错误' });
                }
            }
        )
    );

    // 3. 注册模型切换命令
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'leidong-tools.switchAIModel',
            async () => {
                const allModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
                if (allModels.length === 0) {
                    vscode.window.showWarningMessage('未找到可用的 Copilot 模型。');
                    return;
                }

                const currentModelId = context.globalState.get<string>(LAST_MODEL_KEY);
                const items = allModels.map(m => ({
                    label: `${m.id === currentModelId ? '$(check) ' : '$(sparkle) '}${m.name || m.id}`,
                    description: `${m.vendor} / ${m.family}${m.id === currentModelId ? '  (当前)' : ''}`,
                    detail: `API 版本: ${m.version}`,
                    model: m
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: '请选择 AI 分析使用的模型',
                    title: '雷动三千 - 切换 AI 模型'
                });

                if (selected) {
                    context.globalState.update(LAST_MODEL_KEY, selected.model.id);
                    vscode.window.showInformationMessage(`AI 模型已切换为: ${selected.model.name || selected.model.id}`);
                }
            }
        )
    );
}
