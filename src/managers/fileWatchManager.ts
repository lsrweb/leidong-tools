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
}

/**
 * 监听项接口
 */
interface WatchItem {
    id: string;                    // 唯一标识
    directory: string;             // 监听的目录路径
    projectName: string;           // 项目名称
    watcher: vscode.FileSystemWatcher | null;  // VSCode 文件监听器
    fileExtensions: string[];      // 监听的文件扩展名
}

/**
 * 文件监听管理器类
 */
export class FileWatchManager {
    private watchItems: Map<string, WatchItem> = new Map();
    private statusBarItem: vscode.StatusBarItem;
    private context: vscode.ExtensionContext;

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
     * 启动监听
     */
    public async startWatch(folderUri: vscode.Uri) {
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

        // 询问文件扩展名
        const fileExtInput = await vscode.window.showInputBox({
            prompt: '请输入要监听的文件扩展名（逗号分隔）',
            placeHolder: 'html,htm',
            value: 'html'
        });

        if (!fileExtInput) {
            return;
        }

        const fileExtensions = fileExtInput.split(',').map(ext => ext.trim().replace(/^\./, ''));

        // 确定监听目录
        const watchDir = await this.determineWatchDirectory(folderPath);
        if (!watchDir) {
            return;
        }

        const projectName = path.basename(path.dirname(watchDir.path));
        const watchId = this.generateWatchId(watchDir.path);

        // 检查是否已经在监听
        if (this.watchItems.has(watchId)) {
            vscode.window.showInformationMessage(`已经在监听: ${projectName}/dev`);
            return;
        }

        // 创建监听器
        const pattern = new vscode.RelativePattern(
            watchDir.path,
            `**/*.{${fileExtensions.join(',')}}`
        );
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);

        // 监听文件变化
        watcher.onDidChange(uri => this.handleFileChange(uri, projectName));
        watcher.onDidCreate(uri => this.handleFileChange(uri, projectName));

        // 保存监听项
        const watchItem: WatchItem = {
            id: watchId,
            directory: watchDir.path,
            projectName,
            watcher,
            fileExtensions
        };

        this.watchItems.set(watchId, watchItem);
        this.updateStatusBar();

        vscode.window.showInformationMessage(
            `✅ 已启动监听: ${projectName}/dev (${fileExtensions.join(', ')})`
        );

        // 输出日志
        console.log(`[FileWatch] 启动监听: ${watchDir.path}`);
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
     * 处理文件变化
     */
    private async handleFileChange(uri: vscode.Uri, projectName: string) {
        const filePath = uri.fsPath;
        console.log(`[${projectName}] 检测到文件变化: ${filePath}`);

        try {
            // 读取 HTML 文件内容
            const html = fs.readFileSync(filePath, 'utf8');
            console.log(`[${projectName}] 读取到HTML文件内容，长度: ${html.length} 字符`);

            // 处理 HTML 内容
            const processedHtml = this.processHtmlContent(html);

            if (processedHtml === '') {
                console.log(`[${projectName}] 警告: HTML内容处理后为空`);
                return;
            }

            console.log(`[${projectName}] 成功处理HTML内容，长度: ${processedHtml.length} 字符`);

            // 更新相应的 JS 文件
            const updateCount = this.updateJsFiles(filePath, processedHtml, projectName);

            if (updateCount > 0) {
                vscode.window.showInformationMessage(
                    `✅ ${projectName}: 已更新 ${updateCount} 个 JS 文件`
                );
            }
        } catch (err) {
            console.error(`[${projectName}] 处理文件出错:`, err);
            vscode.window.showErrorMessage(`处理文件失败: ${err}`);
        }
    }

    /**
     * 处理 HTML 内容
     */
    private processHtmlContent(html: string): string {
        let extractedHtml = '';

        // 方案一：提取两个指定注释之间的内容
        const startMarker = `<!-- 这部分要以字符串放在js中，注意里边的单引号需要替换为\\' -->`;
        const endMarker = `<!-- 这部分要以字符串放在js中，注意里边的单引号需要替换为\\' -->`;

        const regex = new RegExp(`${startMarker}\\s*([\\s\\S]*?)\\s*${endMarker}`, 'i');
        const match = html.match(regex);

        if (match) {
            extractedHtml = match[1];
            console.log('使用方案一：从注释标记提取内容');
        } else {
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
     * 更新 JS 文件
     */
    private updateJsFiles(htmlFilePath: string, processedHtml: string, projectName: string): number {
        const devDirPath = path.dirname(htmlFilePath);
        let updateCount = 0;

        try {
            const jsFiles = fs.readdirSync(devDirPath)
                .filter(file => file.endsWith('.js'))
                .map(file => path.join(devDirPath, file));

            jsFiles.forEach(jsFile => {
                try {
                    let content = fs.readFileSync(jsFile, 'utf8');

                    if (content.includes("var html =")) {
                        const lines = content.split('\n');
                        let foundHtmlLine = false;
                        let updatedContent = '';

                        for (const line of lines) {
                            if (!foundHtmlLine && line.trim().startsWith('var html =')) {
                                foundHtmlLine = true;
                                updatedContent += `var html = '${processedHtml}';\n`;
                            } else {
                                updatedContent += line + '\n';
                            }
                        }

                        if (foundHtmlLine) {
                            fs.writeFileSync(jsFile, updatedContent, 'utf8');
                            console.log(`[${projectName}] 已更新: ${path.basename(jsFile)}`);
                            updateCount++;
                        }
                    }
                } catch (err) {
                    console.error(`[${projectName}] 处理文件出错:`, err);
                }
            });
        } catch (err) {
            console.error(`[${projectName}] 读取目录出错:`, err);
        }

        return updateCount;
    }

    /**
     * 确定监听目录
     */
    private async determineWatchDirectory(folderPath: string): Promise<{ path: string; name: string } | null> {
        const folderName = path.basename(folderPath);

        // 情况1: 直接就是 dev 目录
        if (folderName.toLowerCase() === 'dev') {
            return {
                path: folderPath,
                name: path.basename(path.dirname(folderPath))
            };
        }

        // 情况2: 包含 dev 子目录
        const devPath = path.join(folderPath, 'dev');
        if (fs.existsSync(devPath) && fs.statSync(devPath).isDirectory()) {
            return {
                path: devPath,
                name: folderName
            };
        }

        // 情况3: 多项目模式 - 扫描子目录
        const subDirs = fs.readdirSync(folderPath)
            .filter(file => {
                const fullPath = path.join(folderPath, file);
                return fs.statSync(fullPath).isDirectory();
            })
            .map(dir => ({
                name: dir,
                path: path.join(folderPath, dir),
                hasDevDir: fs.existsSync(path.join(folderPath, dir, 'dev'))
            }))
            .filter(d => d.hasDevDir);

        if (subDirs.length === 0) {
            vscode.window.showWarningMessage('未找到任何包含 dev 的子目录');
            return null;
        }

        if (subDirs.length === 1) {
            return {
                path: path.join(subDirs[0].path, 'dev'),
                name: subDirs[0].name
            };
        }

        // 多个项目，让用户选择
        const selected = await vscode.window.showQuickPick(
            subDirs.map(d => ({
                label: d.name,
                description: d.path
            })),
            {
                placeHolder: '选择要监听的项目',
                canPickMany: false
            }
        );

        if (!selected) {
            return null;
        }

        return {
            path: path.join(selected.description!, 'dev'),
            name: selected.label
        };
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
    public getAllWatchItems(): Array<{id: string; directory: string; projectName: string; fileExtensions: string[]}> {
        const items: Array<{id: string; directory: string; projectName: string; fileExtensions: string[]}> = [];
        this.watchItems.forEach(item => {
            items.push({
                id: item.id,
                directory: item.directory,
                projectName: item.projectName,
                fileExtensions: item.fileExtensions
            });
        });
        return items;
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
    }

    /**
     * 清理资源
     */
    public dispose() {
        this.stopAllWatches();
        this.statusBarItem.dispose();
    }
}
