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
    getOrCreateVueIndexFromContent,
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
        if (i < 0 || i >= lines.length) continue;
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
        if (i < 0 || i >= lines.length) continue;
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
            vueIndex = getOrCreateVueIndexFromContent(jsText, document.uri, 0);

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
            vueIndex = resolveVueIndexForHtml(document);
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

    // JS 引用
    const jsReferences: ReferenceContext['jsReferences'] = [];
    if (jsText) {
        const aliasPattern = `(?:this|that|_this|self|_self|vm|_vm|me|ctx|app)\\.${escapeRegex(identifier)}\\b`;
        const directCallPattern = `\\b${escapeRegex(identifier)}\\s*\\(`;
        const combined = new RegExp(`${aliasPattern}|${directCallPattern}`, 'g');
        for (let i = 0; i < jsLines.length; i++) {
            if (i === definitionLine) { continue; }
            combined.lastIndex = 0;
            if (combined.test(jsLines[i])) {
                // 对于引用，我们也给一个较大的块（上下各 10 行）
                const start = Math.max(0, i - 10);
                const end = Math.min(jsLines.length - 1, i + 10);
                jsReferences.push({
                    file: jsFilePath,
                    line: i + 1,
                    snippet: getCleanCodeBlock(jsLines, start, end), // 给 AI 发纯净代码
                });
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

    return {
        identifier,
        category,
        definitionSnippet,
        definitionFile: jsFilePath,
        definitionLine: definitionLine + 1,
        componentSummary,
        htmlReferences,
        jsReferences,
    };
}

// ─── 构建 Prompt ───

/**
 * 优化后的系统提示词：更专业、结构化、高效
 */
const SYSTEM_PROMPT = `你是一个资深的 Vue.js 与前端架构专家。你的任务是深度分析用户提供的代码标识符（变量、方法、计算属性等）在其所属 Vue 组件中的逻辑角色与生命周期。

分析要求：
1. **角色定义**：精准描述该标识符的业务含义与技术类型（如组件状态、副作用触发器、复杂逻辑封装等）。
2. **数据追踪**：追踪其数据流（Sources -> Sinks）。它是如何初始化的？在何处被更改？通过什么事件或属性响应？
3. **上下文依赖**：分析它与其他组件属性（data/props/computed/methods）或全局变量（Vuex/Store/EventBus）的交互关系。
4. **DOM/模板映射**：详细说明在 HTML 模板中的具体表现（指令绑定、事件处理逻辑、条件渲染等）。
5. **代码健康诊断**：指出潜在的风险点，如死代码、竞态条件、逻辑耦合度过高、类型不安全或 Vue 版本兼容性隐患。
6. **优化建议**：提出具体的重构思路（如拆分子组件、改写为计算属性、内存管理建议等）。

输出规范：
- 使用结构清晰、美观的 Markdown 格式。
- 采用专业、客观、简洁的风格，不要有废话。
- 如果逻辑复杂，建议推荐使用 Mermaid 图表描述流程。
- **重要：Mermaid 图表中的节点名称、连线描述必须全部使用中文。**
- 必须使用中文回复。`;

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
        /* Mermaid 图表容器样式 - 黑色主题优化 */
        .mermaid {
            background-color: #1e1e1e; /* 深黑色背景 */
            padding: 16px;
            border-radius: 8px;
            margin: 16px 0;
            text-align: center;
            border: 1px solid #333;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
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
                return '<div class="mermaid">' + text + '</div>';
            }
            return baseCode(code, lang);
        };
        marked.setOptions({ renderer });

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
    const config = vscode.workspace.getConfiguration('leidong-tools');
    const configModelId = config.get<string>('aiModel');
    
    const allModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (allModels.length === 0) {
        return undefined;
    }

    // 1. 优先使用「设置」里手动指定的模型（用户强力干预）
    if (configModelId) {
        const found = allModels.find(m => m.id === configModelId || m.name === configModelId);
        if (found) { return found; }
    }

    // 2. 其次使用「上次选择」的模型（保持一致性）
    const lastModelId = context.globalState.get<string>(LAST_MODEL_KEY);
    if (lastModelId) {
        const found = allModels.find(m => m.id === lastModelId);
        if (found) { return found; }
    }

    // 3. 都没有，则弹框让用户明确选择一次，并保存
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
}
