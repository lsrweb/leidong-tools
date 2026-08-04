/**
 * 文件监听管理器
 * 用于监听 HTML 文件变化并自动更新对应的 JS 文件
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 监听项接口
 */
interface WatchItem {
    id: string;                    // 唯一标识
    directory: string;             // 监听的目录路径
    projectName: string;           // 项目名称
    watcher: vscode.FileSystemWatcher | null;  // VSCode 文件监听器
    fileExtensions: string[];      // 监听的文件扩展名
    isPaused: boolean;             // 是否暂停中
    savedWatcher?: vscode.FileSystemWatcher | null;  // 暂停时保存的 watcher（用于恢复）
    mappedHtmlFile?: string;       // 未发现 index.html 时，用户指定的 HTML 文件
    mappedJsFile?: string;         // 未发现 index.html 时，用户指定的 JS 文件
}

/**
 * 文件监听管理器类
 */
export class FileWatchManager {
    private watchItems: Map<string, WatchItem> = new Map();
    private statusBarItem: vscode.StatusBarItem;
    private context: vscode.ExtensionContext;
    private watchItemsChangedCallbacks: Array<() => void> = [];

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        
        // 创建状态栏项
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'leidong-tools.showWatchList';
        this.statusBarItem.tooltip = '点击查看/管理监听列表';
        this.updateStatusBar();
        
        context.subscriptions.push(this.statusBarItem);
    }

    /**
     * 启动监听 - 简化版本（直接根据右键选择或手动输入的路径）
     */
    public async startWatch(folderUri?: vscode.Uri) {
        // 🔧 修复: 检查 folderUri 是否存在
        if (!folderUri || !folderUri.fsPath) {
            vscode.window.showErrorMessage('无效的文件夹路径');
            return;
        }

        const folderPath = folderUri.fsPath;
        
        // 检查路径是否存在
        if (!fs.existsSync(folderPath)) {
            vscode.window.showErrorMessage(`目录不存在: ${folderPath}`);
            return;
        }

        // 检查是否已经监听了父目录或子目录
        const conflict = this.checkConflict(folderPath);
        if (conflict) {
            const action = await vscode.window.showWarningMessage(
                `${conflict.message}，是否继续？`,
                '继续', '取消'
            );
            if (action !== '继续') {
                return;
            }
        }

        // 自动识别目录结构并呈现给用户选择
        const watchDirs = await this.identifyWatchDirectories(folderPath);
        if (!watchDirs || watchDirs.length === 0) {
            return;
        }

        // 让用户通过 Checkbox 选择要监听的项目（多项目时）
        const selectedDirs = await this.selectProjectsToWatch(watchDirs);
        if (!selectedDirs || selectedDirs.length === 0) {
            return;
        }

        // 默认监听 html 文件（简化，不再询问）
        const fileExtensions = ['html'];

        // 开始监听所有选中的目录 (异步进行, 不阻塞主线程)
        setImmediate(async () => {
            for (const watchDir of selectedDirs) {
                await this.createWatch(watchDir.path, watchDir.projectName, fileExtensions);
            }
        });
    }

    /**
     * 让用户通过 QuickPick 的 checkbox 选择要监听的项目
     */
    private async selectProjectsToWatch(
        watchDirs: Array<{ path: string; projectName: string }>
    ): Promise<Array<{ path: string; projectName: string }> | null> {
        // 如果只有一个，直接返回
        if (watchDirs.length === 1) {
            return watchDirs;
        }

        // 多个项目时，使用 QuickPick with canPickMany
        const items = watchDirs.map(dir => ({
            label: `$(folder) ${dir.projectName}`,
            description: dir.path,
            picked: true,  // 默认全选
            dir
        }));

        // 添加特殊项：全选/全不选
        items.unshift({
            label: '$(check-all) 全选全部',
            description: '选中所有项目',
            picked: false,
            dir: { path: '', projectName: '_select_all' }
        });

        items.push({
            label: '$(close-all) 全部取消',
            description: '取消选中所有项目',
            picked: false,
            dir: { path: '', projectName: '_select_none' }
        });

        const selected = await vscode.window.showQuickPick(items, {
            title: `🔍 发现 ${watchDirs.length} 个项目，请选择要监听的项目（支持多选）`,
            placeHolder: '使用空格或鼠标勾选，按 Enter 确认',
            canPickMany: true,
            matchOnDescription: true
        });

        if (!selected) {
            return null;
        }

        // 处理特殊项
        const hasSelectAll = selected.some(item => item.dir.projectName === '_select_all');
        const hasSelectNone = selected.some(item => item.dir.projectName === '_select_none');

        if (hasSelectAll) {
            return watchDirs;
        }

        if (hasSelectNone) {
            return [];
        }

        // 返回选中的项目（过滤掉特殊项）
        const result = selected
            .filter(item => !item.dir.projectName.startsWith('_'))
            .map(item => item.dir);

        return result.length > 0 ? result : null;
    }

    /**
     * 创建单个监听项 (异步执行, 不阻塞主线程)
     */
    private async createWatch(watchDirPath: string, projectName: string, fileExtensions: string[]): Promise<void> {
        const watchId = this.generateWatchId(watchDirPath);

        // 检查是否已经在监听
        if (this.watchItems.has(watchId)) {
            return;
        }

        const mapping = await this.resolveHtmlJsMappingIfNeeded(watchDirPath, projectName);
        if (mapping === undefined) {
            return;
        }

        const mappedHtmlFile = mapping?.mappedHtmlFile;
        const mappedJsFile = mapping?.mappedJsFile;

        // 在后台异步创建监听器
        return new Promise((resolve) => {
            setImmediate(() => {
                const pattern = mappedHtmlFile
                    ? new vscode.RelativePattern(
                        path.dirname(mappedHtmlFile),
                        path.basename(mappedHtmlFile)
                    )
                    : new vscode.RelativePattern(
                        watchDirPath,
                        `**/*.{${fileExtensions.join(',')}}`
                    );

                const watcher = vscode.workspace.createFileSystemWatcher(pattern);

                // 监听文件变化 (异步处理)
                watcher.onDidChange(uri => {
                    setImmediate(() => this.handleFileChange(uri, watchId));
                });
                watcher.onDidCreate(uri => {
                    setImmediate(() => this.handleFileChange(uri, watchId));
                });

                // 保存监听项
                const watchItem: WatchItem = {
                    id: watchId,
                    directory: watchDirPath,
                    projectName,
                    watcher,
                    fileExtensions,
                    isPaused: false,  // 初始状态：未暂停
                    mappedHtmlFile,
                    mappedJsFile
                };

                this.watchItems.set(watchId, watchItem);
                this.updateStatusBar();

                vscode.window.showInformationMessage(
                    mappedHtmlFile && mappedJsFile
                        ? `✅ 已启动监听: ${projectName}/dev（指定映射）`
                        : `✅ 已启动监听: ${projectName}/dev (${fileExtensions.join(', ')})`
                );

                console.log(`[FileWatch] 启动监听: ${watchDirPath}`);
                resolve();
            });
        });
    }

    /**
     * 手动搜索目录并启动监听 (开放式面板)
     * 用户可以输入一个工作区目录，系统自动搜索 dev 目录
     */
    public async startWatchManual() {
        // 第一步：让用户输入一个目录路径或选择工作区文件夹
        const folderUri = await vscode.window.showOpenDialog({
            title: '🔍 选择项目工作区目录（会自动搜索 dev 文件夹）',
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: '选择'
        });

        if (!folderUri || folderUri.length === 0) {
            return;
        }

        const selectedPath = folderUri[0].fsPath;

        // 检查路径是否存在
        if (!fs.existsSync(selectedPath)) {
            vscode.window.showErrorMessage(`目录不存在: ${selectedPath}`);
            return;
        }

        // 检查是否已经监听了父目录或子目录
        const conflict = this.checkConflict(selectedPath);
        if (conflict) {
            const action = await vscode.window.showWarningMessage(
                `${conflict.message}，是否继续？`,
                '继续', '取消'
            );
            if (action !== '继续') {
                return;
            }
        }

        // 自动识别目录结构
        const watchDirs = await this.identifyWatchDirectories(selectedPath);
        if (!watchDirs || watchDirs.length === 0) {
            return;
        }

        // 让用户通过 Checkbox 选择要监听的项目
        const selectedDirs = await this.selectProjectsToWatch(watchDirs);
        if (!selectedDirs || selectedDirs.length === 0) {
            return;
        }

        // 默认监听 html 文件
        const fileExtensions = ['html'];

        // 开始监听所有选中的目录
        setImmediate(async () => {
            for (const watchDir of selectedDirs) {
                await this.createWatch(watchDir.path, watchDir.projectName, fileExtensions);
            }
        });
    }

    /**
     * 暂停单个监听
     */
    public pauseWatch(watchId: string) {
        const watchItem = this.watchItems.get(watchId);
        if (!watchItem || watchItem.isPaused) {
            return;
        }

        // 保存当前 watcher
        watchItem.savedWatcher = watchItem.watcher;
        // 销毁 watcher（暂停）
        watchItem.watcher?.dispose();
        watchItem.watcher = null;
        watchItem.isPaused = true;

        this.updateStatusBar();
        vscode.window.showInformationMessage(
            `⏸️ 已暂停监听: ${watchItem.projectName}/dev`
        );

        console.log(`[FileWatch] 暂停监听: ${watchItem.directory}`);
    }

    /**
     * 恢复单个监听
     */
    public resumeWatch(watchId: string) {
        const watchItem = this.watchItems.get(watchId);
        if (!watchItem || !watchItem.isPaused) {
            return;
        }

        // 异步重建 watcher
        setImmediate(() => {
            const pattern = watchItem.mappedHtmlFile
                ? new vscode.RelativePattern(
                    path.dirname(watchItem.mappedHtmlFile),
                    path.basename(watchItem.mappedHtmlFile)
                )
                : new vscode.RelativePattern(
                    watchItem.directory,
                    `**/*.{${watchItem.fileExtensions.join(',')}}`
                );
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);

            // 监听文件变化
            watcher.onDidChange(uri => {
                setImmediate(() => this.handleFileChange(uri, watchId));
            });
            watcher.onDidCreate(uri => {
                setImmediate(() => this.handleFileChange(uri, watchId));
            });

            watchItem.watcher = watcher;
            watchItem.savedWatcher = undefined;
            watchItem.isPaused = false;

            this.updateStatusBar();
            vscode.window.showInformationMessage(
                `▶️ 已恢复监听: ${watchItem.projectName}/dev`
            );

            console.log(`[FileWatch] 恢复监听: ${watchItem.directory}`);
        });
    }

    /**
     * 暂停所有监听
     */
    public pauseAllWatches() {
        let count = 0;
        for (const [watchId, watchItem] of this.watchItems) {
            if (!watchItem.isPaused) {
                this.pauseWatch(watchId);
                count++;
            }
        }

        if (count > 0) {
            vscode.window.showInformationMessage(
                `⏸️ 已暂停 ${count} 个监听`
            );
        }
    }

    /**
     * 恢复所有监听
     */
    public resumeAllWatches() {
        let count = 0;
        for (const [watchId, watchItem] of this.watchItems) {
            if (watchItem.isPaused) {
                this.resumeWatch(watchId);
                count++;
            }
        }

        if (count > 0) {
            vscode.window.showInformationMessage(
                `▶️ 已恢复 ${count} 个监听`
            );
        }
    }

    /**
     * 停止监听
     */
    public stopWatch(watchId: string) {
        const watchItem = this.watchItems.get(watchId);
        if (!watchItem) {
            return;
        }

        // 销毁监听器
        watchItem.watcher?.dispose();
        this.watchItems.delete(watchId);
        this.updateStatusBar();

        vscode.window.showInformationMessage(
            `⏹️ 已停止监听: ${watchItem.projectName}/dev`
        );

        console.log(`[FileWatch] 停止监听: ${watchItem.directory}`);
    }

    /**
     * 停止所有监听
     */
    public stopAllWatches() {
        for (const [watchId] of this.watchItems) {
            this.stopWatch(watchId);
        }
    }

    /**
     * 显示监听列表
     */
    public async showWatchList() {
        if (this.watchItems.size === 0) {
            vscode.window.showInformationMessage('当前没有正在监听的目录');
            return;
        }

        const items: vscode.QuickPickItem[] = [];
        
        for (const [watchId, watchItem] of this.watchItems) {
            items.push({
                label: `$(eye) ${watchItem.projectName}/dev`,
                description: `${watchItem.fileExtensions.join(', ')}`,
                detail: watchItem.directory,
                buttons: [{
                    iconPath: new vscode.ThemeIcon('close'),
                    tooltip: '停止监听'
                }]
            } as any);
        }

        items.push({
            label: '$(trash) 停止所有监听',
            description: '',
            detail: `共 ${this.watchItems.size} 个监听项`
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: '选择要停止的监听项',
            canPickMany: false
        });

        if (!selected) {
            return;
        }

        if (selected.label.includes('停止所有监听')) {
            const confirm = await vscode.window.showWarningMessage(
                '确定要停止所有监听吗？',
                '确定', '取消'
            );
            if (confirm === '确定') {
                this.stopAllWatches();
            }
        } else {
            // 根据项目名称找到对应的 watchId
            for (const [watchId, watchItem] of this.watchItems) {
                if (selected.label.includes(watchItem.projectName)) {
                    this.stopWatch(watchId);
                    break;
                }
            }
        }
    }

    /**
     * 处理文件变化 (异步执行, 不阻塞主线程)
     */
    private async handleFileChange(uri: vscode.Uri, watchId: string) {
        // 在后台异步处理文件变化
        setImmediate(async () => {
            const watchItem = this.watchItems.get(watchId);
            if (!watchItem) {
                return;
            }

            const { projectName, mappedHtmlFile, mappedJsFile } = watchItem;
            const filePath = uri.fsPath;
            console.log(`[${projectName}] 检测到文件变化: ${filePath}`);

            if (mappedHtmlFile && !this.isSameFilePath(mappedHtmlFile, filePath)) {
                return;
            }

            try {
                // 使用异步读取 (避免阻塞)
                const html = await this.readFileAsync(filePath);
                console.log(`[${projectName}] 读取到HTML文件内容，长度: ${html.length} 字符`);

                // 处理 HTML 内容
                const processedHtml = this.processHtmlContent(html);

                if (processedHtml === '') {
                    console.log(`[${projectName}] 警告: HTML内容处理后为空`);
                    return;
                }

                console.log(`[${projectName}] 成功处理HTML内容，长度: ${processedHtml.length} 字符`);

                // 异步更新 JS 文件
                const updateCount = await this.updateJsFilesAsync(
                    filePath,
                    processedHtml,
                    projectName,
                    mappedJsFile
                );

                if (updateCount > 0) {
                    vscode.window.showInformationMessage(
                        `✅ ${projectName}: 已更新 ${updateCount} 个 JS 文件`
                    );
                }
            } catch (err) {
                console.error(`[${projectName}] 处理文件出错:`, err);
                vscode.window.showErrorMessage(`处理文件失败: ${err}`);
            }
        });
    }

    /**
     * 异步读取文件
     */
    private readFileAsync(filePath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            fs.readFile(filePath, 'utf8', (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            });
        });
    }

    /**
     * 异步更新 JS 文件
     */
    private async updateJsFilesAsync(
        htmlFilePath: string,
        processedHtml: string,
        projectName: string,
        mappedJsFile?: string
    ): Promise<number> {
        return new Promise((resolve) => {
            setImmediate(() => {
                let updateCount = 0;
                const variableName = this.getWatchVariableName();
                const variableRegex = this.getWatchVariableRegex(variableName);

                try {
                    const jsFiles = mappedJsFile
                        ? [mappedJsFile]
                        : fs.readdirSync(path.dirname(htmlFilePath))
                            .filter(file => file.endsWith('.js'))
                            .map(file => path.join(path.dirname(htmlFilePath), file));

                    for (const jsFile of jsFiles) {
                        try {
                            if (!fs.existsSync(jsFile)) {
                                continue;
                            }

                            let content = fs.readFileSync(jsFile, 'utf8');

                            const lines = content.split('\n');
                            let foundHtmlLine = false;
                            let skippingOriginalBlock = false;
                            const updatedLines: string[] = [];

                            for (let i = 0; i < lines.length; i++) {
                                const line = lines[i];
                                const match = !foundHtmlLine && !skippingOriginalBlock ? line.match(variableRegex) : null;

                                if (match) {
                                    foundHtmlLine = true;
                                    skippingOriginalBlock = true;
                                    const prefix = match[1]
                                        ? match[1].trimEnd()
                                        : `var ${variableName} =`;
                                    updatedLines.push(`${prefix} '${processedHtml}';`);

                                    if (line.trim().endsWith(';')) {
                                        skippingOriginalBlock = false;
                                    }
                                    continue;
                                }

                                if (skippingOriginalBlock) {
                                    if (line.trim().endsWith(';')) {
                                        skippingOriginalBlock = false;
                                    }
                                    continue;
                                }

                                updatedLines.push(line);
                            }

                            if (foundHtmlLine) {
                                // 使用 join 而不是逐行添加 \n，避免文末添加空行
                                const updatedContent = updatedLines.join('\n');
                                fs.writeFileSync(jsFile, updatedContent, 'utf8');
                                console.log(`[${projectName}] 已更新: ${path.basename(jsFile)}`);
                                updateCount++;
                            }
                        } catch (err) {
                            console.error(`[${projectName}] 处理文件出错:`, err);
                        }
                    }
                } catch (err) {
                    console.error(`[${projectName}] 读取目录出错:`, err);
                }

                resolve(updateCount);
            });
        });
    }

    /**
     * 无 index.html 时，让用户选择 HTML 并映射到指定 JS
     * - 返回 null：无需映射（目录下存在 index.html）
     * - 返回 undefined：用户取消
     */
    private async resolveHtmlJsMappingIfNeeded(
        watchDirPath: string,
        projectName: string
    ): Promise<{ mappedHtmlFile: string; mappedJsFile: string } | null | undefined> {
        const indexPath = path.join(watchDirPath, 'index.html');

        if (fs.existsSync(indexPath)) {
            return null;
        }

        const chooseHtml = await vscode.window.showOpenDialog({
            title: `未发现 index.html，请选择要监听的 HTML（${projectName}）`,
            canSelectFolders: false,
            canSelectFiles: true,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(watchDirPath),
            filters: { 'HTML Files': ['html', 'htm'] }
        });

        if (!chooseHtml || chooseHtml.length === 0) {
            return undefined;
        }

        const htmlFile = chooseHtml[0].fsPath;

        const chooseJs = await vscode.window.showOpenDialog({
            title: `请选择要替换的 JS 文件（${projectName}）`,
            canSelectFolders: false,
            canSelectFiles: true,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(watchDirPath),
            filters: { 'JavaScript Files': ['js'] }
        });

        if (!chooseJs || chooseJs.length === 0) {
            return undefined;
        }

        const jsFile = chooseJs[0].fsPath;

        return {
            mappedHtmlFile: htmlFile,
            mappedJsFile: jsFile
        };
    }

    /**
     * 比较两个文件路径是否一致（跨平台大小写处理）
     */
    private isSameFilePath(a: string, b: string): boolean {
        return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    }

    /**
     * 处理 HTML 内容
     */
    private processHtmlContent(html: string): string {
        let extractedHtml = '';

        // 方案一：提取两个注释标记之间的内容（支持“以字符串的方式放在js中”等变体）
        const markerRegex = /<!--\s*这部分要以字符串[\s\S]*?放在js中[\s\S]*?-->/gi;
        const markers = Array.from(html.matchAll(markerRegex));

        if (markers.length >= 2) {
            const startIndex = (markers[0].index ?? 0) + markers[0][0].length;
            const endIndex = markers[1].index ?? startIndex;
            if (endIndex > startIndex) {
                extractedHtml = html.substring(startIndex, endIndex);
                console.log('使用方案一：从注释标记提取内容');
            }
        }

        if (!extractedHtml) {
            // 方案二：提取 id="vm" 的 div
            const openTagPattern = /<div\s+[^>]*id\s*=\s*(['"])vm\1[^>]*>/i;
            const openTagMatch = html.match(openTagPattern);

            if (openTagMatch) {
                const divStart = html.indexOf(openTagMatch[0]);
                if (divStart >= 0) {
                    let depth = 1;
                    let pos = divStart + openTagMatch[0].length;
                    const remainingHtml = html.substring(pos);
                    const divRegex = /<\/?div[^>]*>/gi;
                    let tagMatch;

                    while ((tagMatch = divRegex.exec(remainingHtml)) !== null) {
                        const isOpenTag = !tagMatch[0].startsWith('</');

                        if (isOpenTag) {
                            depth++;
                        } else {
                            depth--;
                            if (depth === 0) {
                                const endPos = pos + tagMatch.index + tagMatch[0].length;
                                extractedHtml = html.substring(divStart, endPos);
                                break;
                            }
                        }
                    }
                }
            }
        }

        if (!extractedHtml) {
            return '';
        }

        // 处理 && 字符
        if (extractedHtml.includes('&amp;&amp;')) {
            extractedHtml = extractedHtml.replace(/&amp;&amp;/g, '&&');
        }

        // 替换单引号并压缩成一行
        const escapedHtml = extractedHtml.replace(/'/g, "\\'");
        const compressedHtml = escapedHtml.replace(/\s*\n\s*/g, '');

        return compressedHtml;
    }

    /**
     * 获取替换变量名（可配置）
     */
    private getWatchVariableName(): string {
        const cfg = vscode.workspace.getConfiguration('leidong-tools');
        const name = cfg.get<string>('watchHtmlVariableName', 'html');
        const trimmed = (name || '').trim();
        return trimmed.length > 0 ? trimmed : 'html';
    }

    /**
     * 获取替换变量的匹配正则
     */
    private getWatchVariableRegex(variableName: string): RegExp {
        const cfg = vscode.workspace.getConfiguration('leidong-tools');
        const customPattern = cfg.get<string>('watchHtmlVariablePattern', '').trim();

        if (customPattern) {
            try {
                return new RegExp(customPattern);
            } catch (err) {
                console.error('[FileWatch] 自定义匹配正则无效，已回退到默认规则:', err);
            }
        }

        return new RegExp(
            `^(\\s*(?:var|let|const)?\\s*${this.escapeRegExp(variableName)}\\s*=)`,
            'm'
        );
    }

    /**
     * 转义正则特殊字符
     */
    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * 识别监听目录 - 支持多层级结构
     * 
     * 简化逻辑 (项目结构都是约定好的):
     * 1. 直接是 dev 目录 → 监听该目录
     * 2. 包含 dev 子目录 → 监听 dev 目录
     * 3. 多项目容器模式 (如 static/h5/项目/dev) → 递归扫描所有项目
     */
    private async identifyWatchDirectories(
        folderPath: string
    ): Promise<Array<{ path: string; projectName: string }> | null> {
        const folderName = path.basename(folderPath);

        // 情况1: 直接就是 dev 目录
        if (folderName.toLowerCase() === 'dev') {
            return [{
                path: folderPath,
                projectName: path.basename(path.dirname(folderPath))
            }];
        }

        // 情况2: 包含 dev 子目录的项目
        const devPath = path.join(folderPath, 'dev');
        if (fs.existsSync(devPath) && fs.statSync(devPath).isDirectory()) {
            return [{
                path: devPath,
                projectName: folderName
            }];
        }

        // 情况3: 多项目容器模式 - 递归扫描并找到所有 dev 目录
        const watchDirs = this.scanProjectsRecursively(folderPath, 0);

        if (watchDirs.length === 0) {
            vscode.window.showWarningMessage('未找到任何包含 dev 的子目录');
            return null;
        }

        return watchDirs;
    }

    /**
     * 递归扫描项目结构，找出所有符合条件的 dev 目录
     * 只递归到第 3 层 (避免深度过深)
     */
    private scanProjectsRecursively(
        dirPath: string,
        depth: number,
        maxDepth: number = 3
    ): Array<{ path: string; projectName: string }> {
        if (depth > maxDepth) {
            return [];
        }

        const results: Array<{ path: string; projectName: string }> = [];

        try {
            const entries = fs.readdirSync(dirPath);

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry);

                try {
                    const stat = fs.statSync(fullPath);
                    
                    if (!stat.isDirectory()) {
                        continue;
                    }

                    // 如果是 dev 目录，记录项目名
                    if (entry.toLowerCase() === 'dev') {
                        const projectName = path.basename(dirPath);
                        results.push({
                            path: fullPath,
                            projectName
                        });
                    } else {
                        // 继续递归查找
                        const subResults = this.scanProjectsRecursively(
                            fullPath,
                            depth + 1,
                            maxDepth
                        );
                        results.push(...subResults);
                    }
                } catch (err) {
                    // 忽略权限问题
                    continue;
                }
            }
        } catch (err) {
            // 忽略读取目录失败
        }

        return results;
    }

    /**
     * 检查监听冲突
     */
    private checkConflict(folderPath: string): { message: string } | null {
        for (const [, watchItem] of this.watchItems) {
            // 检查是否是父目录
            if (folderPath.startsWith(watchItem.directory)) {
                return {
                    message: `父目录 "${watchItem.projectName}" 已在监听中`
                };
            }

            // 检查是否是子目录
            if (watchItem.directory.startsWith(folderPath)) {
                return {
                    message: `子目录 "${watchItem.projectName}" 已在监听中`
                };
            }
        }

        return null;
    }

    /**
     * 生成监听ID
     */
    private generateWatchId(directory: string): string {
        return directory.replace(/[\\\/]/g, '_');
    }

    /**
     * 获取所有监听项（供 TreeView 使用）
     */
    public getAllWatchItems(): Array<{id: string; directory: string; projectName: string; fileExtensions: string[]; isPaused: boolean}> {
        const items: Array<{id: string; directory: string; projectName: string; fileExtensions: string[]; isPaused: boolean}> = [];
        this.watchItems.forEach(item => {
            items.push({
                id: item.id,
                directory: item.directory,
                projectName: item.projectName,
                fileExtensions: item.fileExtensions,
                isPaused: item.isPaused
            });
        });
        return items;
    }

    /**
     * 注册监听项变化回调
     */
    public onWatchItemsChanged(callback: () => void): vscode.Disposable {
        this.watchItemsChangedCallbacks.push(callback);
        return new vscode.Disposable(() => {
            const index = this.watchItemsChangedCallbacks.indexOf(callback);
            if (index >= 0) { this.watchItemsChangedCallbacks.splice(index, 1); }
        });
    }

    /**
     * 触发监听项变化事件
     */
    private fireWatchItemsChanged(): void {
        this.watchItemsChangedCallbacks.forEach(callback => {
            try {
                callback();
            } catch (err) {
                console.error('[FileWatch] 监听项变化回调出错:', err);
            }
        });
    }

    /**
     * 更新状态栏
     */
    private updateStatusBar() {
        const count = this.watchItems.size;
        if (count === 0) {
            this.statusBarItem.hide();
        } else {
            this.statusBarItem.text = `$(eye) ${count}`;
            this.statusBarItem.show();
        }
        
        // 触发变化事件（用于刷新 TreeView）
        this.fireWatchItemsChanged();
    }

    /**
     * 清理资源
     */
    public dispose() {
        this.stopAllWatches();
        this.watchItemsChangedCallbacks.length = 0;
        this.statusBarItem.dispose();
    }
}
