/**
 * ReferenceProvider - 查找引用
 * 在 JS 文件中光标在 data/methods/computed 属性上时，
 * 列出 HTML 模板中所有引用该变量的位置。
 * 也支持从 HTML 模板中反向查找同一模板内所有引用。
 */
import * as vscode from 'vscode';
import { resolveVueIndexForHtml, getOrCreateVueIndexFromContent, findDefinitionInIndex, getExternalDevScriptPathsForHtml } from '../parsers/parseDocument';
import type { VueIndex } from '../parsers/parseDocument';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 获取关联的 HTML 文件路径
 * 1. 检查所有可见 + 所有打开的 HTML 文档，看其关联 JS 是否包含目标 JS
 * 2. 回退到基于目录约定的查找
 */
function findAssociatedHtmlFiles(jsFilePath: string): string[] {
    const normalizedJs = path.normalize(jsFilePath).toLowerCase();
    const seen = new Set<string>();
    const result: string[] = [];

    const addFile = (filePath: string) => {
        const n = path.normalize(filePath).toLowerCase();
        if (!seen.has(n) && fs.existsSync(filePath)) {
            seen.add(n);
            result.push(path.normalize(filePath));
        }
    };

    // 方法 1：遍历所有已打开/可见的 HTML 文档，检查其 dev.js 关联
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'html' && !doc.isClosed) {
            try {
                const scriptPaths = getExternalDevScriptPathsForHtml(doc);
                for (const sp of scriptPaths) {
                    if (path.normalize(sp).toLowerCase() === normalizedJs) {
                        addFile(doc.uri.fsPath);
                    }
                }
            } catch { /* ignore */ }
        }
    }

    // 方法 2：基于目录约定的回退查找
    const dir = path.dirname(jsFilePath);
    const parentDir = path.dirname(dir);
    const baseName = path.basename(jsFilePath).replace(/\.dev\.js$/, '').replace(/\.js$/, '');

    const candidates = [
        path.join(parentDir, `${baseName}.html`),
        path.join(parentDir, 'index.html'),
        path.join(dir, `${baseName}.html`),
    ];

    for (const c of candidates) {
        addFile(c);
    }

    return result;
}

/**
 * 在文本中搜索标识符的所有出现位置
 */
function findIdentifierOccurrencesInHtml(text: string, identifier: string, uri: vscode.Uri): vscode.Location[] {
    const locations: vscode.Location[] = [];
    const lines = text.split('\n');
    
    // 匹配模板中的标识符引用
    const patterns = [
        // {{ identifier }} 或 {{ expr.identifier }}
        new RegExp(`\\{\\{[^}]*\\b${escapeRegex(identifier)}\\b[^}]*\\}\\}`, 'g'),
        // v-bind:xxx="identifier" / :xxx="identifier"
        new RegExp(`(?:v-bind:|:)[\\w.-]+\\s*=\\s*"[^"]*\\b${escapeRegex(identifier)}\\b[^"]*"`, 'g'),
        // v-on:xxx="identifier" / @xxx="identifier"  
        new RegExp(`(?:v-on:|@)[\\w.-]+\\s*=\\s*"[^"]*\\b${escapeRegex(identifier)}\\b[^"]*"`, 'g'),
        // v-if/v-show/v-else-if="identifier"
        new RegExp(`(?:v-if|v-else-if|v-show)\\s*=\\s*"[^"]*\\b${escapeRegex(identifier)}\\b[^"]*"`, 'g'),
        // v-for="... in identifier"
        new RegExp(`v-for\\s*=\\s*"[^"]*\\b(?:in|of)\\s+[^"]*\\b${escapeRegex(identifier)}\\b[^"]*"`, 'g'),
        // v-model="identifier"
        new RegExp(`v-model\\s*=\\s*"[^"]*\\b${escapeRegex(identifier)}\\b[^"]*"`, 'g'),
    ];

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        // 跳过 <script> 标签内的内容
        // (简单处理，更复杂场景可能需要完善)

        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(line)) !== null) {
                // 精确定位标识符在行内的位置
                const innerRegex = new RegExp(`\\b${escapeRegex(identifier)}\\b`, 'g');
                const subText = match[0];
                let innerMatch: RegExpExecArray | null;
                while ((innerMatch = innerRegex.exec(subText)) !== null) {
                    const col = match.index + innerMatch.index;
                    const range = new vscode.Range(lineNum, col, lineNum, col + identifier.length);
                    // 去重
                    if (!locations.some(l => l.range.start.line === lineNum && l.range.start.character === col)) {
                        locations.push(new vscode.Location(uri, range));
                    }
                }
            }
        }
    }

    return locations;
}

/**
 * 在 JS 文件中搜索标识符的引用
 */
function findIdentifierOccurrencesInJs(text: string, identifier: string, uri: vscode.Uri): vscode.Location[] {
    const locations: vscode.Location[] = [];
    const lines = text.split('\n');
    const regex = new RegExp(`(?:this|that|_this|self|_self|vm|_vm|me|ctx|app)\\.${escapeRegex(identifier)}\\b`, 'g');

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
            // 定位到属性名
            const dotIdx = match[0].lastIndexOf('.');
            const col = match.index + dotIdx + 1;
            const range = new vscode.Range(lineNum, col, lineNum, col + identifier.length);
            locations.push(new vscode.Location(uri, range));
        }
    }
    return locations;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class VueReferenceProvider implements vscode.ReferenceProvider {

    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.Location[] | null> {
        const config = vscode.workspace.getConfiguration('leidong-tools');
        // enableReferences 或 enableCodeLens 任一开启时都提供引用查找
        if (!config.get<boolean>('enableReferences', false)
            && !config.get<boolean>('enableCodeLens', false)) {
            return null;
        }

        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_$][\w$]*/);
        if (!wordRange) { return null; }
        const word = document.getText(wordRange);

        const locations: vscode.Location[] = [];

        if (document.languageId === 'javascript' || document.languageId === 'typescript') {
            // 检查这个词是否是 Vue 索引中的成员
            const vueIndex = getOrCreateVueIndexFromContent(document.getText(), document.uri, 0);
            if (!vueIndex) { return null; }
            const isDefined = vueIndex.data.has(word) || vueIndex.methods.has(word)
                || vueIndex.computed.has(word) || vueIndex.props.has(word)
                || vueIndex.filters.has(word) || vueIndex.watch.has(word);
            if (!isDefined) { return null; }

            // 在当前 JS 文件中查找 this.xxx / that.xxx 引用
            const jsRefs = findIdentifierOccurrencesInJs(document.getText(), word, document.uri);
            locations.push(...jsRefs);

            // 查找关联的 HTML 文件
            const htmlFiles = findAssociatedHtmlFiles(document.uri.fsPath);
            const htmlFileSet = new Set(htmlFiles.map(f => path.normalize(f).toLowerCase()));
            for (const htmlPath of htmlFiles) {
                try {
                    // 优先使用已打开的文档（获取最新内容）
                    const openDoc = vscode.workspace.textDocuments.find(
                        d => path.normalize(d.uri.fsPath).toLowerCase() === path.normalize(htmlPath).toLowerCase() && !d.isClosed
                    );
                    const htmlContent = openDoc ? openDoc.getText() : fs.readFileSync(htmlPath, 'utf8');
                    const htmlUri = openDoc ? openDoc.uri : vscode.Uri.file(htmlPath);
                    const htmlRefs = findIdentifierOccurrencesInHtml(htmlContent, word, htmlUri);
                    locations.push(...htmlRefs);
                } catch { /* ignore read errors */ }
            }

            // 也搜索所有打开的 HTML 文档（可能不在常规路径中）
            for (const doc of vscode.workspace.textDocuments) {
                if (doc.languageId === 'html' && !doc.isClosed
                    && !htmlFileSet.has(path.normalize(doc.uri.fsPath).toLowerCase())) {
                    const htmlRefs = findIdentifierOccurrencesInHtml(doc.getText(), word, doc.uri);
                    locations.push(...htmlRefs);
                }
            }

            // 包含定义本身
            if (context.includeDeclaration) {
                const def = findDefinitionInIndex(word, vueIndex);
                if (def) { locations.push(def); }
            }
        }

        if (document.languageId === 'html') {
            // HTML 中查找同文件的所有引用
            const htmlRefs = findIdentifierOccurrencesInHtml(document.getText(), word, document.uri);
            locations.push(...htmlRefs);

            // 也查找对应 JS 中的引用
            const vueIndex = resolveVueIndexForHtml(document);
            if (vueIndex) {
                const isDefined = vueIndex.data.has(word) || vueIndex.methods.has(word)
                    || vueIndex.computed.has(word) || vueIndex.props.has(word)
                    || vueIndex.filters.has(word);
                if (isDefined) {
                    // 查找定义位置
                    if (context.includeDeclaration) {
                        const def = findDefinitionInIndex(word, vueIndex);
                        if (def) { locations.push(def); }
                    }
                    // 搜索关联的 JS 文件
                    const def = findDefinitionInIndex(word, vueIndex);
                    if (def && def.uri.fsPath !== document.uri.fsPath) {
                        try {
                            const jsContent = fs.readFileSync(def.uri.fsPath, 'utf8');
                            const jsRefs = findIdentifierOccurrencesInJs(jsContent, word, def.uri);
                            locations.push(...jsRefs);
                        } catch { /* ignore */ }
                    }
                }
            }
        }

        return locations.length > 0 ? locations : null;
    }
}
