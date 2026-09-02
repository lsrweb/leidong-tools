import * as vscode from 'vscode';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import { Client as FtpClient, FileType as FtpFileType } from 'basic-ftp';
import { registerRemoteTerminal, BUILTIN_COMMANDS, type RemoteTerminalBuiltins } from './remoteTerminal';

// ssh2-sftp-client does not ship first-party TypeScript declarations.
const SftpClient = require('ssh2-sftp-client');

export interface SftpProfile {
    id: string;
    name: string;
    host: string;
    protocol: 'sftp' | 'ssh' | 'ftp' | 'ftps';
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    secure: boolean | 'implicit';
    rejectUnauthorized: boolean;
    remotePath: string;
    uploadOnSave: boolean;
    workspaceFolder: vscode.WorkspaceFolder;
    configUri: vscode.Uri;
}

interface RawSftpProfile {
    name?: string;
    host?: string;
    protocol?: string;
    port?: number;
    username?: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    secure?: boolean | 'implicit';
    rejectUnauthorized?: boolean;
    remotePath?: string;
    uploadOnSave?: boolean;
}

interface RemoteEntry {
    name: string;
    type: 'd' | '-' | 'l';
    size?: number;
    modifyTime?: number;
}

interface RemoteStat {
    size: number;
    mtime: number;
    directory: boolean;
}

/** vscode.git 扩展 API 的最小类型声明（避免引入额外依赖）。 */
interface GitExtensionExports {
    getAPI(version: number): GitApi;
}
interface GitApi {
    repositories: GitRepository[];
}
interface GitRepository {
    rootUri: vscode.Uri;
    state: GitRepositoryState;
}
interface GitRepositoryState {
    HEAD?: unknown;
    indexChanges: GitChange[];
    workingTreeChanges: GitChange[];
    mergeChanges: GitChange[];
    onDidChange: vscode.Event<void>;
}
interface GitChange {
    uri: vscode.Uri;
    renameUri?: vscode.Uri;
}

class RemoteLogger implements vscode.Disposable {
    private readonly channel = vscode.window.createOutputChannel('远程资源');

    info(profile: SftpProfile | undefined, message: string): void {
        this.write('INFO', profile, message);
    }

    error(profile: SftpProfile | undefined, message: string): void {
        this.write('ERROR', profile, message);
    }

    protocol(profile: SftpProfile, message: string): void {
        const sanitized = message.replace(/^(>\s*PASS\s+).*/i, '$1******');
        this.write(profile.protocol.toUpperCase(), profile, sanitized);
    }

    show(): void { this.channel.show(true); }
    dispose(): void { this.channel.dispose(); }

    private write(level: string, profile: SftpProfile | undefined, message: string): void {
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const target = profile ? ` [${profile.name}]` : '';
        this.channel.appendLine(`[${time}] [${level}]${target} ${message}`);
    }
}

class RemoteActivity implements vscode.Disposable {
    private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
    private active = 0;
    private failed = false;
    private transitionTimer?: NodeJS.Timeout;
    private generation = 0;

    constructor() {
        this.item.command = 'leidong-tools.sftp.showLogs';
        this.item.tooltip = '点击查看远程资源日志';
        this.render();
        this.item.show();
    }

    begin(label: string): (success?: boolean) => void {
        this.generation++;
        if (this.transitionTimer) { clearTimeout(this.transitionTimer); this.transitionTimer = undefined; }
        if (this.active === 0) { this.failed = false; }
        this.active++;
        this.item.text = '$(sync~spin) 远程同步：Loading';
        this.item.tooltip = `${label}（点击查看日志）`;
        let finished = false;
        return (success = true) => {
            if (finished) { return; }
            finished = true;
            if (!success) { this.failed = true; }
            this.active = Math.max(0, this.active - 1);
            if (this.active > 0) { return; }
            const currentGeneration = ++this.generation;
            this.item.text = this.failed ? '$(error) 远程同步：失败' : '$(check) 远程同步：成功';
            this.item.tooltip = this.failed ? '部分远程操作失败（点击查看日志）' : '远程同步完成（点击查看日志）';
            this.transitionTimer = setTimeout(() => {
                if (this.active === 0 && this.generation === currentGeneration) { this.renderIdle(); }
            }, 1000);
        };
    }

    report(transferred: number, total?: number): void {
        if (this.active === 0) { return; }
        const percent = total && total > 0 ? Math.min(100, Math.round(transferred / total * 100)) : undefined;
        this.item.text = percent === undefined ? `$(sync~spin) 远程同步：${formatSize(transferred)}` : `$(sync~spin) 远程同步：${percent}%`;
    }

    dispose(): void {
        if (this.transitionTimer) { clearTimeout(this.transitionTimer); }
        this.item.dispose();
    }

    private render(): void {
        if (this.active === 0) { this.renderIdle(); }
    }

    private renderIdle(): void {
        this.item.text = '$(remote) 远程同步：空闲';
        this.item.tooltip = '远程同步空闲（点击查看日志）';
    }
}

export class SftpTreeItem extends vscode.TreeItem {
    constructor(
        public readonly profile: SftpProfile,
        public readonly remotePath: string,
        public readonly kind: 'profile' | 'directory' | 'file',
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        description?: string,
    ) {
        super(label, collapsibleState);
        this.description = description;
        this.contextValue = `remote-${kind}`;
        this.iconPath = new vscode.ThemeIcon(kind === 'profile' ? 'remote' : kind === 'directory' ? 'folder' : 'file');
        if (kind === 'file') {
            this.command = {
                command: 'leidong-tools.sftp.preview',
                title: '预览远程文件',
                arguments: [this],
            };
        }
        this.tooltip = kind === 'profile'
            ? `${profile.protocol.toUpperCase()} · ${profile.username}@${profile.host}:${profile.port}${profile.remotePath}`
            : remotePath;
    }
}

export class SftpConfigStore {
    async loadProfiles(showErrors = false): Promise<SftpProfile[]> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const profiles: SftpProfile[] = [];
        for (const folder of folders) {
            const configuration = vscode.workspace.getConfiguration('leidong-tools', folder.uri);
            const remoteFiles = configuration.get<string[]>('remoteConfigFiles', []);
            const legacyFiles = configuration.get<string[]>('sftpConfigFiles', ['.vscode/sftp.json']);
            const files = remoteFiles?.length ? remoteFiles : legacyFiles?.length ? legacyFiles : ['.vscode/sftp.json'];
            for (const relativeFile of files) {
                const configUri = vscode.Uri.joinPath(folder.uri, ...relativeFile.replace(/\\/g, '/').split('/'));
                try {
                    const bytes = await vscode.workspace.fs.readFile(configUri);
                    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, ''));
                    const values = Array.isArray(parsed) ? parsed : [parsed];
                    for (let index = 0; index < values.length; index++) {
                        const profile = this.toProfile(values[index] as RawSftpProfile, index, folder, configUri);
                        if (profile) {
                            profiles.push(profile);
                        }
                    }
                } catch (error) {
                    if (this.isMissingFile(error)) {
                        continue;
                    }
                    if (showErrors) {
                        void vscode.window.showErrorMessage(`读取远程配置失败: ${configUri.fsPath} - ${messageOf(error)}`);
                    }
                }
            }
        }
        return profiles;
    }

    private toProfile(
        value: RawSftpProfile,
        index: number,
        workspaceFolder: vscode.WorkspaceFolder,
        configUri: vscode.Uri,
    ): SftpProfile | undefined {
        if (!value || typeof value !== 'object' || !value.host || !value.username || !value.remotePath) {
            return undefined;
        }
        const protocol = value.protocol?.toLowerCase();
        if (protocol && !['sftp', 'ssh', 'ftp', 'ftps'].includes(protocol)) {
            return undefined;
        }
        const resolvedProtocol = (protocol || 'sftp') as SftpProfile['protocol'];
        const secure = resolvedProtocol === 'ftps' ? (value.secure ?? true) : (value.secure ?? false);
        const name = value.name || `${value.username}@${value.host}`;
        return {
            id: `${workspaceFolder.uri.toString()}|${configUri.toString()}|${name}|${index}`,
            name,
            host: value.host,
            protocol: resolvedProtocol,
            port: value.port ?? (secure === 'implicit' ? 990 : resolvedProtocol === 'ftp' || resolvedProtocol === 'ftps' ? 21 : 22),
            username: value.username,
            password: value.password,
            privateKey: value.privateKey,
            passphrase: value.passphrase,
            secure,
            rejectUnauthorized: value.rejectUnauthorized !== false,
            remotePath: normalizeRemote(value.remotePath),
            uploadOnSave: value.uploadOnSave === true,
            workspaceFolder,
            configUri,
        };
    }

    private isMissingFile(error: unknown): boolean {
        const message = messageOf(error);
        return message.includes('FileNotFound') || message.includes('ENOENT');
    }
}

interface SftpConnectionEntry {
    client: any;
    connected: boolean;
    signature: string;
    queue: Promise<void>;
    idleTimer?: NodeJS.Timeout;
}

interface FtpConnectionEntry {
    client: FtpClient;
    signature: string;
    queue: Promise<void>;
    idleTimer?: NodeJS.Timeout;
}

class SftpService implements vscode.Disposable {
    private readonly sftpConnections = new Map<string, SftpConnectionEntry>();
    private readonly ftpConnections = new Map<string, FtpConnectionEntry>();
    private readonly uploadFilterCache = new Map<string, { signature: string; extensions: Set<string>; regexes: RegExp[] }>();

    constructor(
        private readonly logger: RemoteLogger,
        private readonly progress?: (transferred: number, total?: number) => void,
        /** 连接建立/断开时通知（用于刷新面板连接状态显示）。 */
        private readonly onStateChange?: () => void,
    ) {}

    dispose(): void {
        void this.closeAll();
    }

    resetConnections(): void {
        for (const [id, entry] of this.sftpConnections) {
            void this.enqueue(entry, async () => {
                await this.closeSftpById(id, entry);
            });
        }
        for (const [id, entry] of this.ftpConnections) {
            void this.enqueue(entry, async () => {
                this.clearIdle(entry);
                entry.client.close();
                this.ftpConnections.delete(id);
            });
        }
    }

    cancelActiveTransfers(): void { void this.closeAll(); }

    isConnected(profile: SftpProfile): boolean {
        return isFtp(profile) ? this.ftpConnections.get(profile.id)?.client.closed === false : this.sftpConnections.get(profile.id)?.connected === true;
    }

    async list(profile: SftpProfile, remotePath: string): Promise<RemoteEntry[]> {
        this.logger.info(profile, `读取目录 ${remotePath}`);
        if (isFtp(profile)) {
            return this.withFtpClient(profile, async client => (await client.list(remotePath)).map(entry => ({
                name: entry.name,
                type: entry.type === FtpFileType.Directory ? 'd' : entry.type === FtpFileType.SymbolicLink ? 'l' : '-',
                size: entry.size,
                modifyTime: entry.modifiedAt?.getTime(),
            })));
        }
        return this.withSftpClient(profile, client => client.list(remotePath) as Promise<RemoteEntry[]>);
    }

    async read(profile: SftpProfile, remotePath: string): Promise<Buffer> {
        this.logger.info(profile, `预览文件 ${remotePath}`);
        if (isFtp(profile)) {
            return this.withFtpClient(profile, async client => {
                const chunks: Buffer[] = [];
                const destination = new Writable({
                    write(chunk, _encoding, callback) {
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                        callback();
                    },
                });
                await client.downloadTo(destination, remotePath);
                return Buffer.concat(chunks);
            });
        }
        return this.withSftpClient(profile, async client => {
            const result = await client.get(remotePath);
            return Buffer.isBuffer(result) ? result : Buffer.from(result);
        });
    }

    async stat(profile: SftpProfile, remotePath: string): Promise<RemoteStat> {
        if (isFtp(profile)) {
            return this.withFtpClient(profile, async client => {
                const size = await client.size(remotePath);
                let mtime = 0;
                try { mtime = (await client.lastMod(remotePath)).getTime(); } catch { /* Optional FTP capability. */ }
                return { size, mtime, directory: false };
            });
        }
        return this.withSftpClient(profile, async client => {
            const value = await client.stat(remotePath);
            return { size: value.size ?? 0, mtime: value.modifyTime ?? 0, directory: value.isDirectory === true };
        });
    }

    async write(profile: SftpProfile, remotePath: string, content: Uint8Array): Promise<void> {
        this.logger.info(profile, `保存远程文件 ${remotePath}`);
        if (isFtp(profile)) {
            await this.withFtpClient(profile, async client => {
                await client.ensureDir(posixDirname(remotePath));
                await client.uploadFrom(Readable.from(Buffer.from(content)), remotePath);
            });
            return;
        }
        await this.withSftpClient(profile, async client => {
            await client.mkdir(posixDirname(remotePath), true);
            await client.put(Buffer.from(content), remotePath);
        });
    }

    async testConnection(profile: SftpProfile): Promise<void> {
        await this.list(profile, profile.remotePath);
        this.logger.info(profile, '连接测试成功');
    }

    async disconnect(profile: SftpProfile): Promise<void> {
        for (const [id, sftp] of this.sftpConnections) {
            if (!isProfileConnectionKey(id, profile.id)) { continue; }
            await this.enqueue(sftp, () => this.closeSftp(profile, sftp, '已手动断开连接'));
            this.sftpConnections.delete(id);
        }
        for (const [id, ftp] of this.ftpConnections) {
            if (!isProfileConnectionKey(id, profile.id)) { continue; }
            await this.enqueue(ftp, async () => this.closeFtp(profile, ftp, '已手动断开连接'));
            this.ftpConnections.delete(id);
        }
    }

    /** 释放批量上传的并发槽位连接（profileId#uN）；主连接不受影响，保存上传/终端/浏览仍复用主连接。 */
    async closeUploadSlotConnections(profile: SftpProfile): Promise<void> {
        for (const [id, sftp] of this.sftpConnections) {
            if (id === profile.id || !isProfileConnectionKey(id, profile.id)) { continue; }
            await this.enqueue(sftp, () => this.closeSftp(profile, sftp, '批量上传结束，并发连接已释放'));
            this.sftpConnections.delete(id);
        }
        for (const [id, ftp] of this.ftpConnections) {
            if (id === profile.id || !isProfileConnectionKey(id, profile.id)) { continue; }
            await this.enqueue(ftp, async () => this.closeFtp(profile, ftp, '批量上传结束，并发连接已释放'));
            this.ftpConnections.delete(id);
        }
    }

    async upload(profile: SftpProfile, localUri: vscode.Uri, remotePath: string, slot?: number): Promise<void> {
        if (!this.isUploadAllowed(profile, localUri)) {
            this.logger.info(profile, `已按过滤规则跳过 ${localUri.fsPath}`);
            return;
        }
        this.logger.info(profile, `上传文件 ${localUri.fsPath} -> ${remotePath}`);
        if (isFtp(profile)) {
            await this.withFtpClient(profile, async client => {
                await client.ensureDir(posixDirname(remotePath));
                const total = (await vscode.workspace.fs.stat(localUri)).size;
                client.trackProgress((info: any) => this.progress?.(info.bytesOverall ?? info.bytes ?? 0, total));
                try { await client.uploadFrom(localUri.fsPath, remotePath); } finally { client.trackProgress(); }
            }, slot);
            return;
        }
        await this.withSftpClient(profile, async client => {
            const parent = posixDirname(remotePath);
            await client.mkdir(parent, true);
            const total = (await vscode.workspace.fs.stat(localUri)).size;
            await client.fastPut(localUri.fsPath, remotePath, { step: (transferred: number, _chunk: number, remoteTotal: number) => this.progress?.(transferred, remoteTotal || total) });
        }, slot);
    }

    async uploadDirectory(profile: SftpProfile, localUri: vscode.Uri, remotePath: string): Promise<void> {
        if (!this.isUploadAllowed(profile, localUri)) {
            this.logger.info(profile, `已按过滤规则跳过目录 ${localUri.fsPath}`);
            return;
        }
        this.logger.info(profile, `上传目录 ${localUri.fsPath} -> ${remotePath}`);
        const concurrency = this.uploadConcurrency(profile);
        const files: Array<{ local: vscode.Uri; remote: string }> = [];
        const directories: string[] = [];
        const walk = async (local: vscode.Uri, remote: string): Promise<void> => {
            const entries = await vscode.workspace.fs.readDirectory(local);
            for (const [name, type] of entries) {
                const childLocal = vscode.Uri.joinPath(local, name);
                const childRemote = joinRemote(remote, name);
                if ((type & vscode.FileType.Directory) !== 0) {
                    if (!this.isUploadAllowed(profile, childLocal)) {
                        this.logger.info(profile, `已按过滤规则跳过目录 ${childLocal.fsPath}`);
                        continue;
                    }
                    directories.push(childRemote);
                    await walk(childLocal, childRemote);
                } else if ((type & vscode.FileType.File) !== 0) {
                    files.push({ local: childLocal, remote: childRemote });
                }
            }
        };
        await walk(localUri, remotePath);
        // 先串行创建全部远端目录，避免并发 mkdir 同一路径冲突；再由各并发连接上传不同文件
        for (const directory of [remotePath, ...directories]) {
            await this.createDirectory(profile, directory);
        }
        // 连接规划：并发槽位连接仅在批量上传期间存在，多文件并发时按 min(并发配置, 文件数) 建独立连接，
        // 结束（含异常）后全部释放；单文件或并发=1 时直接复用主连接，与 Ctrl+S 保存上传同一条，不额外建连
        try {
            const slots = Math.min(concurrency, files.length);
            if (slots > 1) {
                await this.runPool(files, slots, (file, workerIndex) => this.upload(profile, file.local, file.remote, workerIndex));
            } else {
                for (const file of files) { await this.upload(profile, file.local, file.remote); }
            }
        } finally {
            await this.closeUploadSlotConnections(profile);
        }
    }

    /** 并发上传连接数（1 = 串行，上限 8，避免超过 SSH MaxSessions 限制）。 */
    uploadConcurrency(profile: SftpProfile): number {
        const value = vscode.workspace.getConfiguration('leidong-tools', profile.workspaceFolder.uri)
            .get<number>('remoteUploadConcurrency', 3);
        return Math.min(8, Math.max(1, Math.floor(value) || 1));
    }

    /** 固定并发数的任务池：workerIndex 可用作独立连接槽位。 */
    runPool<T>(items: T[], size: number, worker: (item: T, workerIndex: number) => Promise<void>): Promise<void> {
        let next = 0;
        const count = Math.max(1, Math.min(size, items.length));
        const runners = Array.from({ length: count }, async (_value, workerIndex) => {
            while (true) {
                const current = next++;
                if (current >= items.length) { break; }
                await worker(items[current], workerIndex);
            }
        });
        return Promise.all(runners).then(() => undefined);
    }

    isUploadAllowed(profile: SftpProfile, localUri: vscode.Uri): boolean {
        const configuration = vscode.workspace.getConfiguration('leidong-tools', profile.workspaceFolder.uri);
        const extensionValues = configuration.get<string[]>('remoteUploadExcludedExtensions', []);
        const regexValues = configuration.get<string[]>('remoteUploadExcludeRegex', []);
        const signature = JSON.stringify([extensionValues, regexValues]);
        let filters = this.uploadFilterCache.get(profile.workspaceFolder.uri.toString());
        if (!filters || filters.signature !== signature) {
            const extensions = new Set(extensionValues.map(value => value.trim().toLowerCase().replace(/^\./, '')).filter(Boolean));
            const regexes: RegExp[] = [];
            for (const pattern of regexValues) {
                if (!pattern.trim()) { continue; }
                try { regexes.push(new RegExp(pattern)); }
                catch (error) { this.logger.error(profile, `无效上传过滤正则 ${pattern}: ${messageOf(error)}`); }
            }
            filters = { signature, extensions, regexes };
            this.uploadFilterCache.set(profile.workspaceFolder.uri.toString(), filters);
        }
        const extension = path.extname(localUri.fsPath).toLowerCase().replace(/^\./, '');
        if (extension && filters.extensions.has(extension)) { return false; }
        const relativePath = path.relative(profile.workspaceFolder.uri.fsPath, localUri.fsPath).replace(/\\/g, '/');
        for (const regex of filters.regexes) { if (regex.test(relativePath)) { return false; } }
        return true;
    }

    async download(profile: SftpProfile, remotePath: string, localUri: vscode.Uri, directory: boolean): Promise<void> {
        this.logger.info(profile, `下载${directory ? '目录' : '文件'} ${remotePath} -> ${localUri.fsPath}`);
        if (isFtp(profile)) {
            await this.withFtpClient(profile, async client => {
                if (directory) {
                    await vscode.workspace.fs.createDirectory(localUri);
                    await client.downloadToDir(localUri.fsPath, remotePath);
                } else {
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(localUri.fsPath)));
                    const total = await client.size(remotePath).catch(() => 0);
                    client.trackProgress((info: any) => this.progress?.(info.bytesOverall ?? info.bytes ?? 0, total));
                    try { await client.downloadTo(localUri.fsPath, remotePath); } finally { client.trackProgress(); }
                }
            });
            return;
        }
        await this.withSftpClient(profile, async client => {
            if (directory) {
                await vscode.workspace.fs.createDirectory(localUri);
                await client.downloadDir(remotePath, localUri.fsPath);
            } else {
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(localUri.fsPath)));
                const stat = await client.stat(remotePath).catch(() => ({ size: 0 }));
                await client.fastGet(remotePath, localUri.fsPath, { step: (transferred: number, _chunk: number, total: number) => this.progress?.(transferred, total || stat.size) });
            }
        });
    }

    async createDirectory(profile: SftpProfile, remotePath: string): Promise<void> {
        this.logger.info(profile, `新建目录 ${remotePath}`);
        if (isFtp(profile)) {
            await this.withFtpClient(profile, client => client.ensureDir(remotePath));
            return;
        }
        await this.withSftpClient(profile, client => client.mkdir(remotePath, true));
    }

    async rename(profile: SftpProfile, source: string, target: string): Promise<void> {
        this.logger.info(profile, `重命名 ${source} -> ${target}`);
        if (isFtp(profile)) {
            await this.withFtpClient(profile, client => client.rename(source, target));
            return;
        }
        await this.withSftpClient(profile, client => client.rename(source, target));
    }

    async delete(profile: SftpProfile, remotePath: string, directory: boolean): Promise<void> {
        this.logger.info(profile, `删除${directory ? '目录' : '文件'} ${remotePath}`);
        if (isFtp(profile)) {
            await this.withFtpClient(profile, async client => {
                if (directory) { await client.removeDir(remotePath); } else { await client.remove(remotePath); }
            });
            return;
        }
        await this.withSftpClient(profile, async client => {
            if (directory) { await client.rmdir(remotePath, true); } else { await client.delete(remotePath); }
        });
    }

    private async withSftpClient<T>(profile: SftpProfile, action: (client: any) => Promise<T>, slot?: number): Promise<T> {
        const entry = await this.getSftpEntry(profile, slot);
        const key = connectionKey(profile.id, slot);
        return this.enqueue(entry, async () => {
            this.clearIdle(entry);
            try {
                if (!entry.connected) {
                    await this.connectSftp(profile, entry);
                }
                return await action(entry.client);
            } catch (error) {
                this.logger.error(profile, messageOf(error));
                await this.closeSftp(profile, entry, '连接异常，已释放');
                this.sftpConnections.delete(key);
                throw error;
            } finally {
                if (entry.connected) { this.scheduleSftpIdle(profile, entry, key); }
            }
        });
    }

    private async getSftpEntry(profile: SftpProfile, slot?: number): Promise<SftpConnectionEntry> {
        const key = connectionKey(profile.id, slot);
        const signature = profileSignature(profile);
        const existing = this.sftpConnections.get(key);
        if (existing?.signature === signature) { return existing; }
        if (existing) { await this.closeSftp(profile, existing, '配置已更新，旧连接已关闭'); }
        let entry!: SftpConnectionEntry;
        const client = new SftpClient(profile.name, {
            error: (error: Error) => {
                entry.connected = false;
                this.logger.error(profile, error.message);
                this.onStateChange?.();
            },
            end: () => {
                entry.connected = false;
                this.onStateChange?.();
            },
            close: () => {
                entry.connected = false;
                this.onStateChange?.();
            },
        });
        entry = { client, connected: false, signature, queue: Promise.resolve() };
        this.sftpConnections.set(key, entry);
        return entry;
    }

    private async connectSftp(profile: SftpProfile, entry: SftpConnectionEntry): Promise<void> {
        this.logger.info(profile, `正在连接 ${profile.protocol.toUpperCase()} ${profile.host}:${profile.port}`);
        const connectConfig: Record<string, unknown> = {
            host: profile.host,
            port: profile.port,
            username: profile.username,
            readyTimeout: 20000,
        };
        if (this.verboseProtocolLogging(profile)) {
            connectConfig.debug = (message: string) => this.logger.protocol(profile, message);
        }
        if (profile.password) { connectConfig.password = profile.password; }
        if (profile.privateKey) {
            const keyUri = resolveLocalPath(profile.workspaceFolder.uri, profile.privateKey);
            connectConfig.privateKey = Buffer.from(await vscode.workspace.fs.readFile(keyUri));
        }
        if (profile.passphrase) { connectConfig.passphrase = profile.passphrase; }
        await entry.client.connect(connectConfig);
        entry.connected = true;
        this.logger.info(profile, '连接成功，后续操作将复用此连接');
        this.onStateChange?.();
    }

    private scheduleSftpIdle(profile: SftpProfile, entry: SftpConnectionEntry, key: string): void {
        const timeout = this.idleTimeoutMs(profile);
        if (timeout <= 0) { return; } // 0 = 一直保持连接
        entry.idleTimer = setTimeout(() => {
            void this.enqueue(entry, async () => {
                await this.closeSftp(profile, entry, '空闲超时，连接已关闭');
                this.sftpConnections.delete(key);
            });
        }, timeout);
    }

    private async closeSftp(profile: SftpProfile, entry: SftpConnectionEntry, reason: string): Promise<void> {
        this.clearIdle(entry);
        if (!entry.connected) { return; }
        entry.connected = false;
        try { await entry.client.end(); } catch { /* Connection may already be closed. */ }
        this.logger.info(profile, reason);
        this.onStateChange?.();
    }

    private async withFtpClient<T>(profile: SftpProfile, action: (client: FtpClient) => Promise<T>, slot?: number): Promise<T> {
        const entry = await this.getFtpEntry(profile, slot);
        const key = connectionKey(profile.id, slot);
        return this.enqueue(entry, async () => {
            this.clearIdle(entry);
            try {
                if (entry.client.closed) { await this.connectFtp(profile, entry.client); }
                return await action(entry.client);
            } catch (error) {
                this.logger.error(profile, messageOf(error));
                this.closeFtp(profile, entry, '连接异常，已释放');
                this.ftpConnections.delete(key);
                throw error;
            } finally {
                if (!entry.client.closed) { this.scheduleFtpIdle(profile, entry, key); }
            }
        });
    }

    private async getFtpEntry(profile: SftpProfile, slot?: number): Promise<FtpConnectionEntry> {
        const key = connectionKey(profile.id, slot);
        const signature = profileSignature(profile);
        const existing = this.ftpConnections.get(key);
        if (existing?.signature === signature) { return existing; }
        if (existing) { this.closeFtp(profile, existing, '配置已更新，旧连接已关闭'); }
        const client = new FtpClient(20000);
        if (this.verboseProtocolLogging(profile)) {
            client.ftp.verbose = true;
            client.ftp.log = (message: string) => this.logger.protocol(profile, message);
        }
        const entry = { client, signature, queue: Promise.resolve() };
        this.ftpConnections.set(key, entry);
        return entry;
    }

    private async connectFtp(profile: SftpProfile, client: FtpClient): Promise<void> {
        this.logger.info(profile, `正在连接 ${profile.protocol.toUpperCase()} ${profile.host}:${profile.port}`);
        await client.access({
            host: profile.host,
            port: profile.port,
            user: profile.username,
            password: profile.password,
            secure: profile.secure,
            secureOptions: { rejectUnauthorized: profile.rejectUnauthorized },
        });
        this.logger.info(profile, '连接成功，后续操作将复用此连接');
        this.onStateChange?.();
    }

    private scheduleFtpIdle(profile: SftpProfile, entry: FtpConnectionEntry, key: string): void {
        const timeout = this.idleTimeoutMs(profile);
        if (timeout <= 0) { return; } // 0 = 一直保持连接
        entry.idleTimer = setTimeout(() => {
            void this.enqueue(entry, async () => {
                this.closeFtp(profile, entry, '空闲超时，连接已关闭');
                this.ftpConnections.delete(key);
            });
        }, timeout);
    }

    private closeFtp(profile: SftpProfile, entry: FtpConnectionEntry, reason: string): void {
        this.clearIdle(entry);
        if (entry.client.closed) { return; }
        entry.client.close();
        this.logger.info(profile, reason);
        this.onStateChange?.();
    }

    private async enqueue<T>(entry: { queue: Promise<void> }, action: () => Promise<T>): Promise<T> {
        const previous = entry.queue;
        let release!: () => void;
        entry.queue = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try { return await action(); } finally { release(); }
    }

    private clearIdle(entry: { idleTimer?: NodeJS.Timeout }): void {
        if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = undefined; }
    }

    /** 空闲断连超时（毫秒）：0 = 一直保持连接；>0 = 空闲指定秒数后断连。 */
    private idleTimeoutMs(profile: SftpProfile): number {
        const seconds = vscode.workspace.getConfiguration('leidong-tools', profile.workspaceFolder.uri)
            .get<number>('remoteConnectionIdleTimeout', 0);
        return seconds > 0 ? seconds * 1000 : 0;
    }

    private verboseProtocolLogging(profile: SftpProfile): boolean {
        return vscode.workspace.getConfiguration('leidong-tools', profile.workspaceFolder.uri)
            .get<boolean>('remoteVerboseProtocolLogging', false);
    }

    private async closeAll(): Promise<void> {
        for (const [id, entry] of this.sftpConnections) {
            this.clearIdle(entry);
            entry.connected = false;
            try { await entry.client.end(); } catch { /* Ignore shutdown errors. */ }
            this.sftpConnections.delete(id);
        }
        for (const [id, entry] of this.ftpConnections) {
            this.clearIdle(entry);
            entry.client.close();
            this.ftpConnections.delete(id);
        }
    }

    private async closeSftpById(id: string, entry: SftpConnectionEntry): Promise<void> {
        this.clearIdle(entry);
        entry.connected = false;
        try { await entry.client.end(); } catch { /* Ignore shutdown errors. */ }
        this.sftpConnections.delete(id);
    }
}

class SftpPreviewProvider implements vscode.FileSystemProvider {
    private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changed.event;
    private readonly targets = new Map<string, { profile: SftpProfile; remotePath: string }>();

    constructor(
        private readonly service: SftpService,
        private readonly configs: SftpConfigStore,
        private readonly activity: RemoteActivity,
        private readonly onSaved: (profile: SftpProfile, remotePath: string, size: number) => void,
    ) {}

    createUri(item: SftpTreeItem): vscode.Uri {
        const key = Buffer.from(item.profile.id).toString('base64url');
        const uri = vscode.Uri.from({ scheme: 'leidong-sftp', authority: key, path: item.remotePath });
        this.targets.set(uri.toString(), { profile: item.profile, remotePath: item.remotePath });
        return uri;
    }

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const target = await this.resolveTarget(uri);
        const stat = await this.service.stat(target.profile, target.remotePath);
        return { type: stat.directory ? vscode.FileType.Directory : vscode.FileType.File, ctime: 0, mtime: stat.mtime, size: stat.size };
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const target = await this.resolveTarget(uri);
        return this.service.read(target.profile, target.remotePath);
    }

    readDirectory(): never { throw vscode.FileSystemError.NoPermissions('远程预览为只读'); }
    createDirectory(): never { throw vscode.FileSystemError.NoPermissions('远程预览为只读'); }
    async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
        const target = await this.resolveTarget(uri);
        const finish = this.activity.begin(`保存远程文件 ${path.posix.basename(target.remotePath)}`);
        try {
            await this.service.write(target.profile, target.remotePath, content);
            this.onSaved(target.profile, target.remotePath, content.byteLength);
            this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
            finish(true);
        } catch (error) {
            finish(false);
            throw error;
        }
    }
    delete(): never { throw vscode.FileSystemError.NoPermissions('远程预览为只读'); }
    rename(): never { throw vscode.FileSystemError.NoPermissions('远程预览为只读'); }

    private async resolveTarget(uri: vscode.Uri): Promise<{ profile: SftpProfile; remotePath: string }> {
        const existing = this.targets.get(uri.toString());
        if (existing) { return existing; }
        const profiles = await this.configs.loadProfiles();
        const profile = profiles.find(item => Buffer.from(item.id).toString('base64url') === uri.authority);
        if (!profile) { throw vscode.FileSystemError.FileNotFound('远程连接配置已失效'); }
        const target = { profile, remotePath: uri.path };
        this.targets.set(uri.toString(), target);
        return target;
    }
}

class RemoteExplorerWebviewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'leidong-tools.sftpView';
    private view?: vscode.WebviewView;
    private readonly cache = new Map<string, any[]>();
    private readonly inFlight = new Map<string, Promise<any[]>>();
    /** 面板未加载/未就绪时暂存的终端联动请求，前端 ready 后补发。 */
    private pendingReveals: Array<{ profileId: string; remotePath: string }> = [];
    private viewReady = false;
    /** 已通知过“连接建立”的 profile，避免每次浏览都刷新面板。 */
    private readonly connectedNotified = new Set<string>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly extensionUri: vscode.Uri,
        private readonly configs: SftpConfigStore,
        private readonly service: SftpService,
        private readonly logger: RemoteLogger,
    ) {}

    async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'src', 'webview')] };
        const nonce = Date.now().toString(36);
        const templateUri = vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'remoteExplorer.html');
        const template = Buffer.from(await vscode.workspace.fs.readFile(templateUri)).toString('utf8');
        view.webview.html = template
            .replaceAll('{{cspSource}}', view.webview.cspSource)
            .replaceAll('{{nonce}}', nonce);
        view.webview.onDidReceiveMessage(message => {
            // 前端就绪后补发暂存的终端联动请求（postMessage 在 webview 加载完成前会丢失）
            if (message && typeof message === 'object' && (message as any).type === 'ready') {
                this.viewReady = true;
                const pending = this.pendingReveals;
                this.pendingReveals = [];
                for (const reveal of pending) {
                    void view.webview.postMessage({ type: 'reveal', profileId: reveal.profileId, remotePath: reveal.remotePath });
                }
            }
            void this.handleMessage(message).catch(error => {
                void vscode.window.showErrorMessage(`远程操作失败：${messageOf(error)}`);
            });
        });
    }

    /** 终端 cd 联动：让面板展开到指定远程目录。 */
    revealDirectory(profile: SftpProfile, remotePath: string): void {
        const reveal = { profileId: profile.id, remotePath };
        // 尽力发送（即使前端未 ready 也尝试，消息重复无害）
        if (this.view) {
            void this.view.webview.postMessage({ type: 'reveal', profileId: reveal.profileId, remotePath: reveal.remotePath });
        }
        // 前端未就绪时缓存（ready 后补发）；有界避免无限堆积
        if (!this.viewReady) {
            this.pendingReveals.push(reveal);
            if (this.pendingReveals.length > 5) { this.pendingReveals.shift(); }
        }
    }

    refresh(): void { this.cache.clear(); void this.postProfiles(true); }

    refreshProfiles(): void { void this.postProfiles(false); }

    invalidateDirectory(profile: SftpProfile, remotePath: string, change?: { removedPath?: string; oldPath?: string; newPath?: string }): void {
        this.cache.delete(this.cacheKey(profile.id, remotePath));
        void this.view?.webview.postMessage({ type: 'directoryChanged', profileId: profile.id, remotePath, ...change });
    }

    updateFile(profile: SftpProfile, remotePath: string, size: number): void {
        this.cache.delete(this.cacheKey(profile.id, posixDirname(remotePath)));
        void this.view?.webview.postMessage({ type: 'fileChanged', profileId: profile.id, remotePath, meta: formatSize(size) });
    }

    private async handleMessage(message: any): Promise<void> {
        if (message.type === 'revealResult') {
            // 终端联动诊断：查看“远程资源”日志可定位 reveal 链路
            this.logger.info(undefined, message.ok
                ? `面板联动定位成功: ${message.path}`
                : `面板联动定位失败(${message.reason}): ${message.path ?? ''}`);
            return;
        }
        if (message.type === 'ready') { await this.postProfiles(false); return; }
        if (message.type === 'refresh') { this.cache.clear(); await this.postProfiles(true); return; }
        if (message.type === 'command') { await vscode.commands.executeCommand(message.command); return; }
        if (message.type === 'openConfig') { await vscode.commands.executeCommand('leidong-tools.sftp.openConfig', message.workspaceUri); return; }
        if (message.type === 'clientError') { void vscode.window.showWarningMessage(message.message); return; }
        if (message.type === 'toggleWorkspaceUpload') {
            const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === message.workspaceUri);
            if (!folder) { return; }
            const configuration = vscode.workspace.getConfiguration('leidong-tools', folder.uri);
            await configuration.update('remoteUploadOnSaveEnabled', !configuration.get<boolean>('remoteUploadOnSaveEnabled', true), vscode.ConfigurationTarget.WorkspaceFolder);
            await this.postProfiles(false);
            return;
        }
        const profiles = await this.configs.loadProfiles(true);
        const profile = profiles.find(item => item.id === message.profileId || item.id === message.node?.profileId);
        if (!profile) { return; }
        if (message.type === 'list') {
            try {
                const items = await this.listCached(profile, message.remotePath, message.force === true);
                await this.view?.webview.postMessage({ type: 'response', requestId: message.requestId, items });
                // 浏览会按需建立连接；连接建立后刷新一次状态显示，避免“未连接却可展开”的误导
                if (this.service.isConnected(profile) && !this.connectedNotified.has(profile.id)) {
                    this.connectedNotified.add(profile.id);
                    this.refreshProfiles();
                }
            } catch (error) {
                void vscode.window.showErrorMessage(`${profile.protocol.toUpperCase()} 目录读取失败: ${messageOf(error)}`);
                await this.view?.webview.postMessage({ type: 'response', requestId: message.requestId, items: [] });
            }
            return;
        }
        if (message.type === 'action') {
            const node = message.node;
            const kind = node.kind as 'profile' | 'directory' | 'file';
            const item = new SftpTreeItem(profile, node.remotePath, kind, node.label, vscode.TreeItemCollapsibleState.None);
            const commands: Record<string, string> = {
                open: 'leidong-tools.sftp.open', preview: 'leidong-tools.sftp.preview', download: 'leidong-tools.sftp.download',
                uploadFile: 'leidong-tools.sftp.uploadFile', uploadFolder: 'leidong-tools.sftp.uploadFolder', uploadOverwrite: 'leidong-tools.sftp.uploadOverwrite', backupUpload: 'leidong-tools.sftp.backupUpload',
                createDirectory: 'leidong-tools.sftp.createDirectory', rename: 'leidong-tools.sftp.rename', delete: 'leidong-tools.sftp.delete',
                test: 'leidong-tools.sftp.testConnection', disconnect: 'leidong-tools.sftp.disconnect', toggleProfileAuto: 'leidong-tools.sftp.toggleProfileAutoUpload', selectAuto: 'leidong-tools.sftp.selectAutoUploadProfile',
            };
            if (message.action === 'copyPath') { await vscode.env.clipboard.writeText(node.remotePath); return; }
            if (message.action === 'refreshNode') {
                this.cache.delete(this.cacheKey(profile.id, node.remotePath));
                await this.view?.webview.postMessage({ type: 'directoryChanged', profileId: profile.id, remotePath: node.remotePath });
                return;
            }
            const command = commands[message.action];
            if (command) {
                await vscode.commands.executeCommand(command, item);
                if (message.action === 'disconnect') { this.connectedNotified.delete(profile.id); }
                if (message.action === 'test' || message.action === 'disconnect' || message.action === 'toggleProfileAuto' || message.action === 'selectAuto') { await this.postProfiles(false); }
            }
        }
    }

    private async postProfiles(resetDirectories = false): Promise<void> {
        const profiles = await this.configs.loadProfiles(true);
        const workspaces = (vscode.workspace.workspaceFolders ?? []).map(folder => {
            const folderProfiles = profiles.filter(profile => profile.workspaceFolder.uri.toString() === folder.uri.toString());
            const storedTargets = readAutoUploadTargets(this.context, folder);
            const activeTargets = new Set(storedTargets ?? folderProfiles.filter(profile => profile.uploadOnSave).map(profile => profile.id));
            const uploadOnSaveEnabled = vscode.workspace.getConfiguration('leidong-tools', folder.uri).get<boolean>('remoteUploadOnSaveEnabled', true);
            return {
                kind: 'workspace', nodeId: `workspace:${folder.uri.toString()}`, workspaceUri: folder.uri.toString(), label: folder.name,
                uploadOnSaveEnabled,
                children: folderProfiles.map(profile => {
                    const autoUploadSelected = profile.uploadOnSave && activeTargets.has(profile.id);
                    const autoUploadActive = uploadOnSaveEnabled && autoUploadSelected;
                    return {
                        profileId: profile.id, remotePath: profile.remotePath, kind: 'profile', label: profile.name,
                        meta: `${profile.protocol.toUpperCase()} · ${this.service.isConnected(profile) ? '已连接' : '未连接'} · 自动上传${autoUploadActive ? '开' : '关'}`,
                        workspaceUri: folder.uri.toString(), autoUploadActive, autoUploadSelected, profileUploadOnSave: profile.uploadOnSave,
                    };
                }),
            };
        });
        await this.view?.webview.postMessage({ type: 'profiles', items: workspaces, resetDirectories });
    }

    private cacheKey(profileId: string, remotePath: string): string { return `${profileId}|${remotePath}`; }

    private async listCached(profile: SftpProfile, remotePath: string, force: boolean): Promise<any[]> {
        const key = this.cacheKey(profile.id, remotePath);
        if (force) { this.cache.delete(key); }
        const cached = this.cache.get(key);
        if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
        const running = this.inFlight.get(key);
        if (running) { return running; }
        const request = this.service.list(profile, remotePath).then(entries => entries
            .filter(entry => entry.name !== '.' && entry.name !== '..')
            .sort((a, b) => (a.type === 'd' ? 0 : 1) - (b.type === 'd' ? 0 : 1) || a.name.localeCompare(b.name))
            .map(entry => ({ profileId: profile.id, remotePath: joinRemote(remotePath, entry.name), kind: entry.type === 'd' ? 'directory' : 'file', label: entry.name, meta: entry.type === 'd' ? '' : formatSize(entry.size) }))
        ).finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, request);
        const items = await request;
        this.cache.set(key, items);
        while (this.cache.size > 100) { this.cache.delete(this.cache.keys().next().value as string); }
        return items;
    }
}

export function registerSftpManager(context: vscode.ExtensionContext): void {
    const configs = new SftpConfigStore();
    const logger = new RemoteLogger();
    const activity = new RemoteActivity();
    // 连接建立/断开时刷新面板，保证“已连接/未连接”状态与实际一致
    let remoteProvider!: RemoteExplorerWebviewProvider;
    const service = new SftpService(
        logger,
        (transferred, total) => activity.report(transferred, total),
        () => remoteProvider.refreshProfiles(),
    );
    remoteProvider = new RemoteExplorerWebviewProvider(context, context.extensionUri, configs, service, logger);
    const preview = new SftpPreviewProvider(service, configs, activity, (profile, remotePath, size) => remoteProvider.updateFile(profile, remotePath, size));
    const viewRegistration = vscode.window.registerWebviewViewProvider(RemoteExplorerWebviewProvider.viewType, remoteProvider);
    registerRemoteTerminal(
        context,
        configs,
        (profile, directory) => remoteProvider.revealDirectory(profile, directory),
        createTerminalBuiltins(context, service, remoteProvider, activity),
    );

    const run = async (label: string, action: () => Promise<void>) => {
        const finish = activity.begin(label);
        logger.info(undefined, label);
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: label, cancellable: true }, async (_progress, token) => {
                token.onCancellationRequested(() => service.cancelActiveTransfers());
                await action();
            });
            logger.info(undefined, `${label}完成`);
            finish(true);
        } catch (error) {
            logger.error(undefined, `${label}失败: ${messageOf(error)}`);
            void vscode.window.showErrorMessage(`${label}失败: ${messageOf(error)}`);
            finish(false);
        }
    };

    interface AutoUploadState {
        document: vscode.TextDocument;
        generation: number;
        running: boolean;
        timer?: NodeJS.Timeout;
    }
    const autoUploads = new Map<string, AutoUploadState>();

    /** 自动上传目标（保存自动上传与外部修改上传共用同一套目标配置）。 */
    const resolveAutoUploadTargets = async (folder: vscode.WorkspaceFolder): Promise<SftpProfile[]> => {
        const profiles = (await configs.loadProfiles()).filter(profile =>
            profile.workspaceFolder.uri.toString() === folder.uri.toString() && profile.uploadOnSave,
        );
        const selected = readAutoUploadTargets(context, folder);
        return selected === undefined ? profiles : profiles.filter(profile => selected.includes(profile.id));
    };

    const flushAutoUpload = async (key: string, state: AutoUploadState): Promise<void> => {
        if (state.running) { return; }
        state.running = true;
        const runningGeneration = state.generation;
        const document = state.document;
        let succeeded = true;
        try {
            const folder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (!folder) { return; }
            const targets = await resolveAutoUploadTargets(folder);
            if (!targets.length) { return; }
            recentUploadUris.set(document.uri.toString(), Date.now());
            const finish = activity.begin(`正在自动上传 ${path.basename(document.uri.fsPath)} (${targets.length})`);
            logger.info(undefined, `保存自动上传 ${document.uri.fsPath} -> ${targets.map(profile => profile.name).join('、')}`);
            try {
                const results = await Promise.allSettled(targets.map(profile => uploadMappedFile(service, profile, document.uri, false)));
                results.forEach((result, index) => {
                    if (result.status === 'rejected') {
                        succeeded = false;
                        logger.error(targets[index], `自动上传失败: ${messageOf(result.reason)}`);
                        void vscode.window.showErrorMessage(`自动上传到 ${targets[index].name} 失败: ${messageOf(result.reason)}`);
                    } else {
                        logger.info(targets[index], '自动上传完成');
                        if (result.value) { remoteProvider.invalidateDirectory(targets[index], posixDirname(result.value)); }
                    }
                });
            } finally {
                finish(succeeded);
            }
        } finally {
            state.running = false;
            if (state.generation !== runningGeneration) {
                state.timer = setTimeout(() => { void flushAutoUpload(key, state); }, 300);
            } else {
                autoUploads.delete(key);
            }
        }
    };

    const scheduleAutoUpload = (document: vscode.TextDocument): void => {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder || !vscode.workspace.getConfiguration('leidong-tools', folder.uri).get<boolean>('remoteUploadOnSaveEnabled', true)) { return; }
        const key = document.uri.toString();
        let state = autoUploads.get(key);
        if (!state) {
            state = { document, generation: 0, running: false };
            autoUploads.set(key, state);
        }
        state.document = document;
        state.generation++;
        if (state.timer) { clearTimeout(state.timer); }
        state.timer = setTimeout(() => { void flushAutoUpload(key, state!); }, 300);
    };

    // ---- AI Agent / 外部程序修改文件的自动上传 ----
    // 监听磁盘变更（CLI 类 Agent 直接写盘不触发保存事件），防抖后按自动上传目标配置上传。
    // 不检查编辑器 dirty 状态：Agent 常以“编辑器挂起未保存 + bash 直接写盘”的方式改文件，
    // 只认磁盘内容；人工保存的上传由 2 秒去重窗口避免重复。
    const externalUploads = new Map<string, { timer?: NodeJS.Timeout }>();
    const recentUploadUris = new Map<string, number>();
    const warnedNoUploadTargets = new Set<string>();
    const UPLOAD_DEDUPE_MS = 2000;

    const flushExternalUpload = async (uri: vscode.Uri, state: { timer?: NodeJS.Timeout }): Promise<void> => {
        state.timer = undefined;
        try {
            const folder = vscode.workspace.getWorkspaceFolder(uri);
            if (!folder) { return; }
            const last = recentUploadUris.get(uri.toString());
            if (last !== undefined && Date.now() - last < UPLOAD_DEDUPE_MS) { return; }
            const targets = await resolveAutoUploadTargets(folder);
            if (!targets.length) {
                const key = folder.uri.toString();
                if (!warnedNoUploadTargets.has(key)) {
                    warnedNoUploadTargets.add(key);
                    void vscode.window.showWarningMessage('Agent 修改自动上传已开启，但当前工作区没有可用的自动上传目标（需在 sftp.json 配置中开启 uploadOnSave）');
                }
                return;
            }
            recentUploadUris.set(uri.toString(), Date.now());
            const finish = activity.begin(`外部修改上传 ${path.basename(uri.fsPath)} (${targets.length})`);
            logger.info(undefined, `外部修改自动上传 ${uri.fsPath} -> ${targets.map(profile => profile.name).join('、')}`);
            let succeeded = true;
            try {
                const results = await Promise.allSettled(targets.map(profile => uploadMappedFile(service, profile, uri, false)));
                results.forEach((result, index) => {
                    if (result.status === 'rejected') {
                        succeeded = false;
                        logger.error(targets[index], `外部修改上传失败: ${messageOf(result.reason)}`);
                    } else if (result.value) {
                        remoteProvider.invalidateDirectory(targets[index], posixDirname(result.value));
                    }
                });
            } finally {
                finish(succeeded);
            }
        } finally {
            if (!state.timer) { externalUploads.delete(uri.toString()); }
        }
    };

    const scheduleExternalUpload = (uri: vscode.Uri): void => {
        if (uri.scheme !== 'file') { return; }
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) { return; }
        const configuration = vscode.workspace.getConfiguration('leidong-tools', folder.uri);
        if (!configuration.get<boolean>('remoteUploadOnAgentChanges', false)) { return; }
        const key = uri.toString();
        let state = externalUploads.get(key);
        if (!state) {
            state = {};
            externalUploads.set(key, state);
        }
        if (state.timer) { clearTimeout(state.timer); }
        state.timer = setTimeout(() => { void flushExternalUpload(uri, state!); }, 500);
    };

    const externalWatcher = vscode.workspace.createFileSystemWatcher('**/*');

    context.subscriptions.push(
        viewRegistration,
        logger,
        activity,
        service,
        new vscode.Disposable(() => {
            for (const state of autoUploads.values()) {
                if (state.timer) { clearTimeout(state.timer); }
            }
            autoUploads.clear();
            for (const state of externalUploads.values()) {
                if (state.timer) { clearTimeout(state.timer); }
            }
            externalUploads.clear();
        }),
        vscode.workspace.registerFileSystemProvider('leidong-sftp', preview, { isReadonly: false, isCaseSensitive: true }),
        vscode.commands.registerCommand('leidong-tools.sftp.showLogs', () => logger.show()),
        vscode.commands.registerCommand('leidong-tools.sftp.toggleUploadOnSave', async () => {
            const folder = await chooseWorkspaceFolder();
            if (!folder) { return; }
            const configuration = vscode.workspace.getConfiguration('leidong-tools', folder.uri);
            const enabled = !configuration.get<boolean>('remoteUploadOnSaveEnabled', true);
            await configuration.update('remoteUploadOnSaveEnabled', enabled, vscode.ConfigurationTarget.WorkspaceFolder);
            remoteProvider.refreshProfiles();
            void vscode.window.showInformationMessage(`保存自动上传已${enabled ? '开启' : '关闭'}`);
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.toggleAgentUpload', async () => {
            const folder = await chooseWorkspaceFolder('选择要切换 Agent 修改自动上传的工作区');
            if (!folder) { return; }
            const configuration = vscode.workspace.getConfiguration('leidong-tools', folder.uri);
            const enabled = !configuration.get<boolean>('remoteUploadOnAgentChanges', false);
            await configuration.update('remoteUploadOnAgentChanges', enabled, vscode.ConfigurationTarget.WorkspaceFolder);
            void vscode.window.showInformationMessage(`Agent 修改自动上传已${enabled ? '开启' : '关闭'}（${folder.name}）：Agent/外部程序修改文件后自动上传`);
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.refresh', () => remoteProvider.refresh()),
        vscode.commands.registerCommand('leidong-tools.sftp.testConnection', async (item?: SftpTreeItem) => {
            if (!item) { return; }
            await run(`测试连接 ${item.profile.name}`, () => service.testConnection(item.profile));
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.testAllConnections', async () => {
            const profiles = await configs.loadProfiles(true);
            if (!profiles.length) {
                void vscode.window.showWarningMessage('未找到远程连接配置');
                return;
            }
            await run(`测试 ${profiles.length} 个远程连接`, async () => {
                const results = await Promise.allSettled(profiles.map(profile => service.testConnection(profile)));
                const failed = results.flatMap((result, index) => result.status === 'rejected' ? [`${profiles[index].name}: ${messageOf(result.reason)}`] : []);
                if (failed.length) { throw new Error(`失败 ${failed.length} 个：${failed.join('；')}`); }
                void vscode.window.showInformationMessage(`全部 ${profiles.length} 个远程连接测试成功`);
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.disconnect', async (item?: SftpTreeItem) => {
            if (!item) { return; }
            await service.disconnect(item.profile);
            void vscode.window.showInformationMessage(`已断开 ${item.profile.name}`);
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.openConfig', async (workspaceUri?: string) => {
            const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === workspaceUri) ?? await chooseWorkspaceFolder();
            if (!folder) { return; }
            const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'sftp.json');
            try {
                await vscode.workspace.fs.stat(uri);
            } catch {
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode'));
                const sample = [
                    { name: 'sftp-server', host: '127.0.0.1', protocol: 'sftp', port: 22, username: 'root', password: '', remotePath: '/var/www/html', uploadOnSave: false },
                    { name: 'ftp-server', host: '127.0.0.1', protocol: 'ftp', port: 21, username: 'anonymous', password: '', remotePath: '/', uploadOnSave: false },
                ];
                await vscode.workspace.fs.writeFile(uri, Buffer.from(`${JSON.stringify(sample, null, 4)}\n`));
            }
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.preview', async (item: SftpTreeItem) => {
            if (!item || item.kind !== 'file') { return; }
            await run('远程文件预览', async () => {
                await openRemoteFile(preview, item, false);
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.open', async (item: SftpTreeItem) => {
            if (!item || item.kind !== 'file') { return; }
            await run('打开远程文件', async () => {
                await openRemoteFile(preview, item, true);
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.download', async (item: SftpTreeItem) => {
            if (!item) { return; }
            const defaultUri = vscode.Uri.joinPath(item.profile.workspaceFolder.uri, path.basename(item.remotePath));
            const target = item.kind === 'directory' || item.kind === 'profile'
                ? (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri }))?.[0]
                : await vscode.window.showSaveDialog({ defaultUri });
            if (!target) { return; }
            const localUri = item.kind === 'directory' || item.kind === 'profile'
                ? vscode.Uri.joinPath(target, path.basename(item.remotePath))
                : target;
            await run('远程下载', async () => {
                await service.download(item.profile, item.remotePath, localUri, item.kind !== 'file');
                void vscode.window.showInformationMessage(`已下载：${path.basename(localUri.fsPath)}`);
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.upload', async (argument?: SftpTreeItem | vscode.Uri, selectionMode?: 'file' | 'folder') => {
            const item = argument instanceof SftpTreeItem ? argument : undefined;
            const resource = argument instanceof vscode.Uri ? argument : undefined;

            // 本地资源管理器触发（无远端目标节点）：按工作区映射路径上传（与保存自动上传一致）。
            // 此前走 joinRemote(remotePath, 文件名) 固定传到 remotePath 根目录，丢失子路径。
            if (!item && resource) {
                const profile = await pickProfile(configs, resource);
                if (!profile) { return; }
                await run(`上传 ${path.basename(resource.fsPath)} 到 ${profile.name}`, async () => {
                    const remotePath = mappedRemotePath(profile, resource);
                    const stat = await vscode.workspace.fs.stat(resource);
                    if ((stat.type & vscode.FileType.Directory) !== 0) {
                        await service.uploadDirectory(profile, resource, remotePath);
                    } else {
                        await service.upload(profile, resource, remotePath);
                    }
                    remoteProvider.invalidateDirectory(profile, posixDirname(remotePath));
                    void vscode.window.showInformationMessage(`已上传到 ${profile.name}: ${remotePath}`);
                });
                return;
            }

            const profile = item?.profile ?? await pickProfile(configs);
            if (!profile) { return; }
            const targetDirectory = item?.kind === 'directory' ? item.remotePath : item?.kind === 'profile' ? item.profile.remotePath : item?.kind === 'file' ? posixDirname(item.remotePath) : profile.remotePath;
            const sources = await vscode.window.showOpenDialog({
                canSelectFiles: selectionMode !== 'folder',
                canSelectFolders: selectionMode !== 'file',
                canSelectMany: selectionMode !== 'folder',
                title: selectionMode === 'folder' ? '选择要上传的文件夹' : selectionMode === 'file' ? '选择要上传的文件' : '选择要上传的文件或文件夹',
            });
            if (!sources?.length) { return; }
            await run('远程上传', async () => {
                for (const source of sources) {
                    const stat = await vscode.workspace.fs.stat(source);
                    const remote = joinRemote(targetDirectory, path.basename(source.fsPath));
                    if ((stat.type & vscode.FileType.Directory) !== 0) {
                        await service.uploadDirectory(profile, source, remote);
                    } else {
                        await service.upload(profile, source, remote);
                    }
                }
                remoteProvider.invalidateDirectory(profile, targetDirectory);
                void vscode.window.showInformationMessage(`已上传到 ${profile.name}: ${targetDirectory}`);
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.uploadFile', (argument?: SftpTreeItem | vscode.Uri) =>
            vscode.commands.executeCommand('leidong-tools.sftp.upload', argument, 'file')),
        vscode.commands.registerCommand('leidong-tools.sftp.uploadFolder', (argument?: SftpTreeItem | vscode.Uri) =>
            vscode.commands.executeCommand('leidong-tools.sftp.upload', argument, 'folder')),
        vscode.commands.registerCommand('leidong-tools.sftp.uploadLocalFolder', async (resource?: vscode.Uri, selectedResources?: vscode.Uri[]) => {
            const folders = await resolveExplorerFolders(resource, selectedResources);
            for (const localUri of folders) {
                const profile = await pickProfile(configs, localUri);
                if (!profile) { return; }
                const remotePath = mappedRemotePath(profile, localUri);
                await run(`上传文件夹 ${path.basename(localUri.fsPath)} 到 ${profile.name}`, async () => {
                    await service.uploadDirectory(profile, localUri, remotePath);
                    remoteProvider.invalidateDirectory(profile, remotePath);
                    remoteProvider.invalidateDirectory(profile, posixDirname(remotePath));
                    void vscode.window.showInformationMessage(`已上传：${path.basename(localUri.fsPath)} → ${profile.name}`);
                });
            }
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.downloadLocalFolder', async (resource?: vscode.Uri, selectedResources?: vscode.Uri[]) => {
            const folders = await resolveExplorerFolders(resource, selectedResources);
            for (const localUri of folders) {
                const profile = await pickProfile(configs, localUri);
                if (!profile) { return; }
                const remotePath = mappedRemotePath(profile, localUri);
                const dirtyDocuments = vscode.workspace.textDocuments.filter(document => document.isDirty && isUriInside(localUri, document.uri));
                if (dirtyDocuments.length) {
                    const answer = await vscode.window.showWarningMessage(
                        `“${path.basename(localUri.fsPath)}”中有 ${dirtyDocuments.length} 个未保存文件，继续下载将丢失这些修改并使用远端内容覆盖。是否继续？`,
                        { modal: true },
                        '覆盖并下载',
                    );
                    if (answer !== '覆盖并下载') { continue; }
                    await revertDirtyDocuments(dirtyDocuments);
                }
                await run(`下载文件夹 ${path.basename(localUri.fsPath)} 自 ${profile.name}`, async () => {
                    const remote = await service.stat(profile, remotePath);
                    if (!remote.directory) { throw new Error(`远端同名路径不是目录：${remotePath}`); }
                    await service.download(profile, remotePath, localUri, true);
                    void vscode.window.showInformationMessage(`已下载：${profile.name} → ${path.basename(localUri.fsPath)}`);
                });
            }
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.uploadOverwrite', async (item?: SftpTreeItem) => {
            if (!item || item.kind !== 'file') { return; }
            const source = (await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: `选择文件覆盖 ${item.label}` }))?.[0];
            if (!source) { return; }
            await run('上传覆盖远程文件', async () => {
                await service.upload(item.profile, source, item.remotePath);
                remoteProvider.invalidateDirectory(item.profile, posixDirname(item.remotePath));
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.uploadGitChanges', async () => {
            const folder = await chooseWorkspaceFolder('选择要上传 Git 变动的工作区');
            if (!folder) { return; }
            const profile = await pickProfile(configs, folder.uri);
            if (!profile) { return; }
            const collection = await collectGitChangedFiles(folder).catch(error => {
                void vscode.window.showErrorMessage(messageOf(error));
                return undefined;
            });
            if (!collection) { return; }
            if (!collection.files.length) {
                void vscode.window.showInformationMessage(`没有可上传的 Git 变动文件${collection.deletedCount ? `（${collection.deletedCount} 个已删除文件已跳过）` : ''}`);
                return;
            }
            await run(`一键上传 Git 变动到 ${profile.name}（${collection.files.length} 个文件）`, async () => {
                const result = await uploadGitChangeFiles(service, profile, collection.files);
                for (const remote of result.uploaded) { remoteProvider.invalidateDirectory(profile, posixDirname(remote)); }
                if (result.failures.length) {
                    throw new Error(`成功 ${result.uploaded.length} 个，失败 ${result.failures.length} 个：${result.failures.join('；')}`);
                }
                void vscode.window.showInformationMessage(
                    `已上传 ${result.uploaded.length} 个 Git 变动文件到 ${profile.name}` +
                    (result.skippedFilter ? `；${result.skippedFilter} 个被过滤规则跳过` : '') +
                    (collection.deletedCount ? `；${collection.deletedCount} 个已删除文件已跳过` : ''),
                );
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.uploadCurrentFile', async (resource?: vscode.Uri) => {
            const localUri = resource?.scheme === 'file' ? resource : vscode.window.activeTextEditor?.document.uri;
            if (!localUri || localUri.scheme !== 'file') {
                void vscode.window.showWarningMessage('没有可上传的本地文件');
                return;
            }
            const profile = await pickProfile(configs, localUri);
            if (!profile) { return; }
            await run(`正在上传到 ${profile.name}`, async () => {
                const uploaded = await uploadMappedFile(service, profile, localUri, true);
                if (uploaded) { remoteProvider.invalidateDirectory(profile, posixDirname(uploaded)); }
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.compareCurrentFile', async (resource?: vscode.Uri) => {
            const localUri = resource?.scheme === 'file' ? resource : vscode.window.activeTextEditor?.document.uri;
            if (!localUri || localUri.scheme !== 'file') {
                void vscode.window.showWarningMessage('没有可比较的本地文件');
                return;
            }
            const profile = await pickProfile(configs, localUri);
            if (!profile) { return; }
            const comparison = await compareMappedFile(service, profile, localUri);
            if (!comparison.remote) {
                void vscode.window.showInformationMessage(formatComparison(comparison), { modal: true });
                return;
            }
            const answer = await vscode.window.showInformationMessage(formatComparison(comparison), { modal: true }, '打开文本差异');
            if (answer === '打开文本差异') {
                const remoteItem = new SftpTreeItem(profile, comparison.remotePath, 'file', path.posix.basename(comparison.remotePath), vscode.TreeItemCollapsibleState.None);
                const remoteUri = preview.createUri(remoteItem);
                await vscode.commands.executeCommand('vscode.diff', localUri, remoteUri, `本地 ↔ ${profile.name}: ${path.basename(localUri.fsPath)}`);
            }
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.syncCurrentFile', async (resource?: vscode.Uri) => {
            const localUri = resource?.scheme === 'file' ? resource : vscode.window.activeTextEditor?.document.uri;
            if (!localUri || localUri.scheme !== 'file') {
                void vscode.window.showWarningMessage('没有可同步的本地文件');
                return;
            }
            const profile = await pickProfile(configs, localUri);
            if (!profile) { return; }
            const comparison = await compareMappedFile(service, profile, localUri);
            const actions: vscode.QuickPickItem[] = [
                { label: '上传本地文件', description: `覆盖远端 ${path.posix.basename(comparison.remotePath)}`, detail: formatComparison(comparison) },
                { label: '下载远程文件', description: `覆盖本地 ${path.basename(localUri.fsPath)}`, detail: formatComparison(comparison) },
            ];
            const action = await vscode.window.showQuickPick(actions, { placeHolder: '确认差异后选择同步方向' });
            if (!action) { return; }
            if (action.label === '上传本地文件') {
                await run(`同步上传到 ${profile.name}`, async () => {
                    await service.upload(profile, localUri, comparison.remotePath);
                    remoteProvider.invalidateDirectory(profile, posixDirname(comparison.remotePath));
                });
                return;
            }
            const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === localUri.toString());
            if (document?.isDirty) {
                const answer = await vscode.window.showWarningMessage('当前文件有未保存修改，下载将覆盖这些修改。是否继续？', { modal: true }, '覆盖并下载');
                if (answer !== '覆盖并下载') { return; }
            }
            await run(`同步下载自 ${profile.name}`, async () => {
                await service.download(profile, comparison.remotePath, localUri, false);
                if (document) {
                    await vscode.window.showTextDocument(document, { preview: false });
                    await vscode.commands.executeCommand('workbench.action.files.revert');
                }
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.backupUpload', async (argument?: SftpTreeItem | vscode.Uri) => {
            const remoteItem = argument instanceof SftpTreeItem ? argument : undefined;
            if (remoteItem && remoteItem.kind !== 'file') { return; }

            const localFromArgument = argument instanceof vscode.Uri && argument.scheme === 'file' ? argument : undefined;
            let profile = remoteItem?.profile;
            let remotePath = remoteItem?.remotePath;
            let localUri = localFromArgument;

            if (!profile) {
                localUri = localUri ?? vscode.window.activeTextEditor?.document.uri;
                if (!localUri || localUri.scheme !== 'file') {
                    void vscode.window.showWarningMessage('没有可备份上传的本地文件');
                    return;
                }
                profile = await pickProfile(configs, localUri);
                if (!profile) { return; }
                remotePath = mappedRemotePath(profile, localUri);
            } else {
                localUri = resolveLocalUriForRemoteItem(remoteItem!);
                if (!localUri || !(await isReadableFile(localUri))) {
                    const picked = (await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        title: `选择要上传到 ${path.posix.basename(remotePath!)} 的本地文件`,
                    }))?.[0];
                    if (!picked) { return; }
                    localUri = picked;
                }
            }

            const targetRemote = remotePath!;
            const targetProfile = profile;
            const sourceUri = localUri!;
            await run(`备份并上传 ${path.basename(sourceUri.fsPath)}`, async () => {
                const backupPath = await nextBackupRemotePath(service, targetProfile, targetRemote);
                await service.rename(targetProfile, targetRemote, backupPath);
                await service.upload(targetProfile, sourceUri, targetRemote);
                remoteProvider.invalidateDirectory(targetProfile, posixDirname(targetRemote), { oldPath: targetRemote, newPath: backupPath });
                void vscode.window.showInformationMessage(`已备份并上传：${path.basename(sourceUri.fsPath)}`);
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.downloadCurrentFile', async (resource?: vscode.Uri) => {
            const localUri = resource?.scheme === 'file' ? resource : vscode.window.activeTextEditor?.document.uri;
            if (!localUri || localUri.scheme !== 'file') {
                void vscode.window.showWarningMessage('没有可下载覆盖的本地文件');
                return;
            }
            const profile = await pickProfile(configs, localUri);
            if (!profile) { return; }
            const remotePath = mappedRemotePath(profile, localUri);
            const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === localUri.toString());
            if (document?.isDirty) {
                const answer = await vscode.window.showWarningMessage('当前文件有未保存修改，下载将覆盖这些修改。是否继续？', { modal: true }, '覆盖并下载');
                if (answer !== '覆盖并下载') { return; }
                await vscode.window.showTextDocument(document, { preview: false });
                await vscode.commands.executeCommand('workbench.action.files.revert');
            }
            await run(`正在从 ${profile.name} 下载`, async () => {
                await service.download(profile, remotePath, localUri, false);
                const opened = vscode.workspace.textDocuments.find(item => item.uri.toString() === localUri.toString());
                if (opened) {
                    await vscode.window.showTextDocument(opened, { preview: false });
                    await vscode.commands.executeCommand('workbench.action.files.revert');
                }
                void vscode.window.showInformationMessage(`已从 ${profile.name} 下载：${path.basename(localUri.fsPath)}`);
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.toggleProfileAutoUpload', async (item?: SftpTreeItem) => {
            if (!item) { return; }
            const profile = item.profile;
            if (!profile.uploadOnSave) {
                void vscode.window.showWarningMessage(`${profile.name} 的配置中 uploadOnSave 未开启，请先在 sftp.json 中设为 true`);
                return;
            }
            const folder = profile.workspaceFolder;
            const eligible = (await configs.loadProfiles(true)).filter(candidate =>
                candidate.workspaceFolder.uri.toString() === folder.uri.toString() && candidate.uploadOnSave,
            );
            const stored = readAutoUploadTargets(context, folder);
            const selected = new Set(stored ?? eligible.map(candidate => candidate.id));
            const enabled = !selected.has(profile.id);
            if (enabled) { selected.add(profile.id); } else { selected.delete(profile.id); }
            await context.workspaceState.update(autoUploadKey(folder), [...selected]);
            remoteProvider.refreshProfiles();
            void vscode.window.showInformationMessage(`${profile.name} 自动上传已${enabled ? '开启' : '关闭'}`);
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.selectAutoUploadProfile', async (item?: SftpTreeItem) => {
            const folder = item?.profile.workspaceFolder ?? await chooseWorkspaceFolder();
            if (!folder) { return; }
            const profiles = (await configs.loadProfiles(true)).filter(profile =>
                profile.workspaceFolder.uri.toString() === folder.uri.toString() && profile.uploadOnSave,
            );
            if (!profiles.length) {
                void vscode.window.showWarningMessage('当前工作区没有启用 uploadOnSave 的远程配置');
                return;
            }
            const stored = readAutoUploadTargets(context, folder);
            const selected = await vscode.window.showQuickPick(
                profiles.map(profile => ({
                    label: profile.name,
                    description: `${profile.protocol.toUpperCase()} · ${profile.host}${profile.remotePath}`,
                    picked: stored === undefined ? true : stored.includes(profile.id),
                    profile,
                })),
                { canPickMany: true, placeHolder: '选择保存时自动上传的目标（可多选）' },
            );
            if (!selected) { return; }
            await context.workspaceState.update(autoUploadKey(folder), selected.map(entry => entry.profile.id));
            remoteProvider.refreshProfiles();
            const names = selected.map(entry => entry.profile.name);
            void vscode.window.showInformationMessage(names.length ? `自动上传目标：${names.join('、')}` : '已关闭该工作区的保存自动上传');
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.createDirectory', async (item?: SftpTreeItem) => {
            if (!item || item.kind === 'file') { return; }
            const name = await vscode.window.showInputBox({ prompt: '输入新目录名称', validateInput: validateRemoteName });
            if (!name) { return; }
            await run('新建远程目录', async () => {
                const created = joinRemote(item.remotePath, name);
                await service.createDirectory(item.profile, created);
                remoteProvider.invalidateDirectory(item.profile, item.remotePath);
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.rename', async (item?: SftpTreeItem) => {
            if (!item || item.kind === 'profile') { return; }
            const currentName = path.posix.basename(item.remotePath);
            const name = await vscode.window.showInputBox({ prompt: '输入新名称', value: currentName, validateInput: validateRemoteName });
            if (!name || name === currentName) { return; }
            await run('远程重命名', async () => {
                const parent = posixDirname(item.remotePath);
                const target = joinRemote(parent, name);
                await service.rename(item.profile, item.remotePath, target);
                remoteProvider.invalidateDirectory(item.profile, parent, { oldPath: item.remotePath, newPath: target });
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.delete', async (item?: SftpTreeItem) => {
            if (!item || item.kind === 'profile') { return; }
            const answer = await vscode.window.showWarningMessage(
                `确定删除远程${item.kind === 'directory' ? '目录及其全部内容' : '文件'}“${path.posix.basename(item.remotePath)}”吗？`,
                { modal: true },
                '删除',
            );
            if (answer !== '删除') { return; }
            await run('远程删除', async () => {
                await service.delete(item.profile, item.remotePath, item.kind === 'directory');
                remoteProvider.invalidateDirectory(item.profile, posixDirname(item.remotePath), { removedPath: item.remotePath });
            });
        }),
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.uri.scheme !== 'file') { return; }
            scheduleAutoUpload(document);
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('leidong-tools.sftpConfigFiles') || event.affectsConfiguration('leidong-tools.remoteConfigFiles')) { remoteProvider.refresh(); }
            if (event.affectsConfiguration('leidong-tools.remoteVerboseProtocolLogging') || event.affectsConfiguration('leidong-tools.remoteConnectionIdleTimeout')) {
                service.resetConnections();
            }
        }),
    );

    const configWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/sftp.json');
    context.subscriptions.push(
        configWatcher,
        configWatcher.onDidCreate(() => remoteProvider.refresh()),
        configWatcher.onDidChange(() => remoteProvider.refresh()),
        configWatcher.onDidDelete(() => remoteProvider.refresh()),
    );
    context.subscriptions.push(
        externalWatcher,
        externalWatcher.onDidCreate(uri => scheduleExternalUpload(uri)),
        externalWatcher.onDidChange(uri => scheduleExternalUpload(uri)),
    );
}

/** 并发上传的连接槽位 key：主连接用 profile.id，上传槽位加 #uN 后缀。 */
function connectionKey(profileId: string, slot?: number): string {
    return slot === undefined ? profileId : `${profileId}#u${slot}`;
}

function isProfileConnectionKey(key: string, profileId: string): boolean {
    return key === profileId || key.startsWith(`${profileId}#`);
}

async function uploadMappedFile(service: SftpService, profile: SftpProfile, localUri: vscode.Uri, notify: boolean, slot?: number): Promise<string | undefined> {
    const remote = mappedRemotePath(profile, localUri);
    await service.upload(profile, localUri, remote, slot);
    if (notify) {
        void vscode.window.showInformationMessage(`已上传到 ${profile.name}: ${remote}`);
    }
    return remote;
}

interface MappedFileComparison {
    remotePath: string;
    local: { size: number; mtime: number };
    remote?: { size: number; mtime: number };
}

async function compareMappedFile(service: SftpService, profile: SftpProfile, localUri: vscode.Uri): Promise<MappedFileComparison> {
    const local = await vscode.workspace.fs.stat(localUri);
    if ((local.type & vscode.FileType.File) === 0) { throw new Error('只能比较文件'); }
    const remotePath = mappedRemotePath(profile, localUri);
    try {
        const remote = await service.stat(profile, remotePath);
        if (remote.directory) { throw new Error('远端同名路径是目录'); }
        return { remotePath, local: { size: local.size, mtime: local.mtime }, remote: { size: remote.size, mtime: remote.mtime } };
    } catch (error) {
        const message = messageOf(error);
        if (message === '远端同名路径是目录' || !/no such|not found|does not exist|ENOENT|550/i.test(message)) { throw error; }
        return { remotePath, local: { size: local.size, mtime: local.mtime } };
    }
}

function formatComparison(comparison: MappedFileComparison): string {
    const local = `本地 ${formatSize(comparison.local.size)} · ${formatTime(comparison.local.mtime)}`;
    if (!comparison.remote) { return `${local}；远端不存在，可直接上传。`; }
    const remote = `远端 ${formatSize(comparison.remote.size)} · ${formatTime(comparison.remote.mtime)}`;
    const sameSize = comparison.local.size === comparison.remote.size;
    const sameTime = comparison.local.mtime > 0 && comparison.remote.mtime > 0 && Math.abs(comparison.local.mtime - comparison.remote.mtime) < 2000;
    return `${local}；${remote}；${sameSize && sameTime ? '大小和时间一致' : '存在差异'}`;
}

function formatTime(value: number): string {
    return value > 0 ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
}

async function nextBackupRemotePath(service: SftpService, profile: SftpProfile, remotePath: string): Promise<string> {
    const preferred = `${remotePath}.dis`;
    if (!(await remoteExists(service, profile, preferred))) { return preferred; }
    const parsed = path.posix.parse(remotePath);
    const stamp = formatBackupStamp(new Date());
    return joinRemote(parsed.dir || '/', `${parsed.base}.${stamp}.dis`);
}

async function remoteExists(service: SftpService, profile: SftpProfile, remotePath: string): Promise<boolean> {
    try {
        await service.stat(profile, remotePath);
        return true;
    } catch {
        return false;
    }
}

function resolveLocalUriForRemoteItem(item: SftpTreeItem): vscode.Uri | undefined {
    const root = normalizeRemote(item.profile.remotePath);
    const remote = normalizeRemote(item.remotePath);
    if (remote !== root && !remote.startsWith(`${root}/`)) { return undefined; }
    const relative = remote === root ? '' : remote.slice(root.length + 1);
    if (!relative) { return undefined; }
    return vscode.Uri.joinPath(item.profile.workspaceFolder.uri, ...relative.split('/'));
}

async function isReadableFile(uri: vscode.Uri): Promise<boolean> {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        return (stat.type & vscode.FileType.File) !== 0;
    } catch {
        return false;
    }
}

function formatBackupStamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

const remoteImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.avif', '.svg']);

async function openRemoteFile(preview: SftpPreviewProvider, item: SftpTreeItem, pinned: boolean): Promise<void> {
    const uri = preview.createUri(item);
    if (remoteImageExtensions.has(path.posix.extname(item.remotePath).toLowerCase())) {
        try {
            await vscode.commands.executeCommand('vscode.openWith', uri, 'imagePreview.previewEditor', { preview: !pinned });
        } catch (error) {
            throw new Error(`无法使用 VS Code 图片预览打开 ${path.posix.basename(item.remotePath)}：${messageOf(error)}`);
        }
        return;
    }
    await vscode.commands.executeCommand('vscode.open', uri, { preview: !pinned });
}

function mappedRemotePath(profile: SftpProfile, localUri: vscode.Uri): string {
    const relative = path.relative(profile.workspaceFolder.uri.fsPath, localUri.fsPath);
    if (!relative) { return normalizeRemote(profile.remotePath); }
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('文件不在该配置所属的工作区中');
    }
    return joinRemote(profile.remotePath, relative.replace(/\\/g, '/'));
}

async function resolveExplorerFolders(resource?: vscode.Uri, selectedResources?: vscode.Uri[]): Promise<vscode.Uri[]> {
    const candidates = selectedResources?.length ? selectedResources : resource ? [resource] : [];
    const unique = [...new Map(candidates.filter(uri => uri.scheme === 'file').map(uri => [uri.toString(), uri])).values()];
    const folders: vscode.Uri[] = [];
    for (const uri of unique) {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) !== 0) { folders.push(uri); }
    }
    if (!folders.length) { void vscode.window.showWarningMessage('请在资源管理器中选择本地文件夹'); }
    return folders;
}

function isUriInside(folder: vscode.Uri, candidate: vscode.Uri): boolean {
    if (folder.scheme !== candidate.scheme) { return false; }
    const relative = path.relative(folder.fsPath, candidate.fsPath);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function revertDirtyDocuments(documents: vscode.TextDocument[]): Promise<void> {
    const original = vscode.window.activeTextEditor?.document.uri;
    for (const document of documents) {
        await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
        await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    if (original) {
        const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === original.toString());
        if (document) { await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false }); }
    }
}

async function pickProfile(configs: SftpConfigStore, localUri?: vscode.Uri): Promise<SftpProfile | undefined> {
    let profiles = await configs.loadProfiles(true);
    if (localUri) {
        const folder = vscode.workspace.getWorkspaceFolder(localUri);
        if (folder) {
            profiles = profiles.filter(profile => profile.workspaceFolder.uri.toString() === folder.uri.toString());
        }
    }
    if (!profiles.length) {
        void vscode.window.showWarningMessage('未找到 SFTP 配置，请创建 .vscode/sftp.json');
        return undefined;
    }
    if (profiles.length === 1) { return profiles[0]; }
    const picked = await vscode.window.showQuickPick(
        profiles.map(profile => ({ label: profile.name, description: `${profile.username}@${profile.host}${profile.remotePath}`, profile })),
        { placeHolder: '选择 SFTP 配置' },
    );
    return picked?.profile;
}

async function chooseWorkspaceFolder(placeHolder = '选择要创建 SFTP 配置的工作区'): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1) { return folders[0]; }
    const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder });
    return picked;
}

function autoUploadKey(folder: vscode.WorkspaceFolder): string {
    return `sftp.autoUploadProfile.${folder.uri.toString()}`;
}

function readAutoUploadTargets(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder): string[] | undefined {
    const stored = context.workspaceState.get<string | string[]>(autoUploadKey(folder));
    if (stored === undefined) { return undefined; }
    return Array.isArray(stored) ? stored : [stored];
}

function profileSignature(profile: SftpProfile): string {
    return JSON.stringify({
        host: profile.host,
        port: profile.port,
        protocol: profile.protocol,
        username: profile.username,
        password: profile.password,
        privateKey: profile.privateKey,
        passphrase: profile.passphrase,
        secure: profile.secure,
        rejectUnauthorized: profile.rejectUnauthorized,
    });
}

async function getGitApi(): Promise<GitApi | undefined> {
    const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!extension) { return undefined; }
    try {
        const exports = await extension.activate();
        return exports?.getAPI?.(1);
    } catch {
        return undefined;
    }
}

/**
 * 收集工作区 Git 变动文件（暂存 + 未暂存 + 合并冲突，含未跟踪新增）。
 * 已删除/目录（子模块）条目自动跳过；删除数量单独返回用于提示。
 */
async function collectGitChangedFiles(folder: vscode.WorkspaceFolder): Promise<{ files: vscode.Uri[]; deletedCount: number }> {
    const git = await getGitApi();
    if (!git) { throw new Error('未找到 VS Code Git 扩展，无法读取 Git 变动'); }
    const repo = git.repositories
        .filter(item => isUriInside(folder.uri, item.rootUri) || isUriInside(item.rootUri, folder.uri))
        .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    if (!repo) { throw new Error('当前工作区不是 Git 仓库'); }
    if (repo.state.HEAD === undefined) {
        // 仓库初始扫描未完成时 changes 为空，等待状态刷新（最多 3 秒）
        await new Promise<void>(resolve => {
            const subscription = repo.state.onDidChange(() => { clearTimeout(timer); subscription.dispose(); resolve(); });
            const timer = setTimeout(() => { subscription.dispose(); resolve(); }, 3000);
        });
    }
    const seen = new Set<string>();
    const files: vscode.Uri[] = [];
    let deletedCount = 0;
    const changes = [...repo.state.indexChanges, ...repo.state.workingTreeChanges, ...repo.state.mergeChanges];
    for (const change of changes) {
        const uri = change.renameUri ?? change.uri;
        const key = uri.toString();
        if (seen.has(key)) { continue; }
        seen.add(key);
        if (!isUriInside(folder.uri, uri)) { continue; }
        let stat: vscode.FileStat;
        try { stat = await vscode.workspace.fs.stat(uri); } catch { deletedCount++; continue; }
        if ((stat.type & vscode.FileType.File) === 0) { continue; }
        files.push(uri);
    }
    return { files, deletedCount };
}

/** 批量上传 Git 变动文件（复用 mappedRemotePath 映射与上传过滤规则），并发池 + 逐文件容错。 */
async function uploadGitChangeFiles(service: SftpService, profile: SftpProfile, files: vscode.Uri[]): Promise<{ uploaded: string[]; skippedFilter: number; failures: string[] }> {
    const uploaded: string[] = [];
    const failures: string[] = [];
    let skippedFilter = 0;
    const eligible = files.filter(file => {
        if (service.isUploadAllowed(profile, file)) { return true; }
        skippedFilter++;
        return false;
    });
    const uploadOne = async (file: vscode.Uri, slot?: number): Promise<void> => {
        try {
            const remote = await uploadMappedFile(service, profile, file, false, slot);
            if (remote) { uploaded.push(remote); }
        } catch (error) {
            failures.push(`${path.basename(file.fsPath)}: ${messageOf(error)}`);
        }
    };
    // 连接规划与 uploadDirectory 一致：多文件才开并发槽位连接，结束后释放；单文件/串行复用主连接
    try {
        const slots = Math.min(service.uploadConcurrency(profile), eligible.length);
        if (slots > 1) {
            await service.runPool(eligible, slots, uploadOne);
        } else {
            for (const file of eligible) { await uploadOne(file); }
        }
    } finally {
        await service.closeUploadSlotConnections(profile);
    }
    return { uploaded, skippedFilter, failures };
}

/**
 * 远程终端内置指令处理器（/download、/upload、/ls、/cat 等）。
 * 本地路径按“远端相对 remotePath 的差值 → 工作区对应路径”映射，
 * 与保存自动上传的映射规则一致。
 */
function createTerminalBuiltins(
    context: vscode.ExtensionContext,
    service: SftpService,
    remoteProvider: RemoteExplorerWebviewProvider,
    activity: RemoteActivity,
): RemoteTerminalBuiltins {
    const tmpDir = vscode.Uri.joinPath(context.globalStorageUri, 'terminal-tmp');
    const helpText = [
        '内置指令（在扩展本地执行，不发送到远端）：',
        '  /help                    显示本帮助',
        '  /pwd                     显示当前远程目录',
        '  /ls [路径]               列出远端目录',
        '  /download <文件>         下载远端文件到本地对应目录',
        '  /download-dir <目录>     下载远端目录到本地对应目录',
        '  /upload <文件>           上传本地文件到远端当前目录（本地不存在则跳过）',
        '  /upload-dir <目录>       上传本地目录到远端当前目录',
        '  /upgitchange             上传工作区 Git 变动（新增/修改）文件到远端对应路径',
        '  /open <文件>             下载远端文件并用编辑器打开',
        '  /cat <文件>              显示远端文件内容（上限 200KB）',
        '  /tail <文件> [行数]      显示远端文件末尾（默认 50 行，上限 2MB）',
        '  /mkdir <目录>            远端新建目录',
        '  /rm <路径>               删除远端文件或目录',
        '  /mv <源> <目标>          移动/重命名远端路径',
    ];

    const requireArg = (args: string[], label: string): string => {
        if (!args[0]) { throw new Error(`用法：/${label} <路径>`); }
        return args[0];
    };
    const resolveRemote = (cwd: string, arg: string): string => {
        return arg.startsWith('/') ? normalizeRemote(arg) : path.posix.resolve(cwd, arg);
    };
    const localForRemote = (profile: SftpProfile, remoteFile: string): vscode.Uri => {
        const relative = path.posix.relative(profile.remotePath, remoteFile);
        const parts = relative.replace(/\\/g, '/').split('/').filter(Boolean);
        return vscode.Uri.joinPath(profile.workspaceFolder.uri, ...parts);
    };
    const readRemoteText = async (profile: SftpProfile, remotePath: string, maxBytes: number, lines?: number): Promise<string> => {
        const stat = await service.stat(profile, remotePath);
        if (stat.size > maxBytes) { throw new Error(`文件过大（${formatSize(stat.size)}），上限 ${formatSize(maxBytes)}`); }
        await vscode.workspace.fs.createDirectory(tmpDir);
        const tmpFile = vscode.Uri.joinPath(tmpDir, `${Date.now().toString(36)}-${path.posix.basename(remotePath)}`);
        try {
            await service.download(profile, remotePath, tmpFile, false);
            const buffer = await vscode.workspace.fs.readFile(tmpFile);
            const text = Buffer.from(buffer).toString('utf8');
            if (lines === undefined) { return text; }
            return text.split(/\r?\n/).slice(-lines).join('\n');
        } finally {
            try { await vscode.workspace.fs.delete(tmpFile, { recursive: false }); } catch { /* 临时文件清理失败可忽略 */ }
        }
    };

    /**
     * 统一解析 run 的目标列表（支持多路径批量）：
     * args 全部视为目标路径（upload 系列为本地路径，其余为远端路径）
     */
    const resolveRunTargets = async (
        profile: SftpProfile,
        cwd: string,
        command: string,
        args: string[],
        requireArgFn: (args: string[], label: string) => string,
    ): Promise<string[]> => {
        const isLocal = command === 'upload' || command === 'upload-dir';
        if (args.length === 0) {
            requireArgFn(args, command);
            return [];
        }
        return args.map(arg => isLocal
            ? resolveLocalPath(profile.workspaceFolder.uri, arg).fsPath
            : resolveRemote(cwd, arg));
    };

    return {
        isBuiltin: (command: string) => BUILTIN_COMMANDS.has(command),
        async run(profile: SftpProfile, command: string, args: string[], cwd: string): Promise<string[] | undefined> {
            switch (command) {
                case 'help':
                    return helpText;
                case 'pwd':
                    return [cwd];
                case 'ls': {
                    const directory = resolveRemote(cwd, args[0] ?? '.');
                    const entries = await service.list(profile, directory);
                    return [`${directory}/`, ...entries.map(entry => entry.type === 'd' ? `${entry.name}/` : entry.name)];
                }
                case 'mkdir': {
                    const directory = resolveRemote(cwd, requireArg(args, 'mkdir'));
                    await service.createDirectory(profile, directory);
                    remoteProvider.invalidateDirectory(profile, posixDirname(directory));
                    return [`已创建目录 ${directory}`];
                }
                case 'rm': {
                    const targets = await resolveRunTargets(profile, cwd, command, args, requireArg);

                    const results: string[] = [];
                    for (const picked of targets) {
                        const target = picked.replace(/\/$/, '');
                        const stat = await service.stat(profile, target);
                        await service.delete(profile, target, stat.directory);
                        remoteProvider.invalidateDirectory(profile, posixDirname(target));
                        results.push(`已删除 ${target}`);
                    }
                    return results;
                }
                case 'mv': {
                    const source = resolveRemote(cwd, requireArg(args, 'mv'));
                    if (!args[1]) { throw new Error('用法：/mv <源> <目标>'); }
                    const target = resolveRemote(cwd, args[1]);
                    await service.rename(profile, source, target);
                    remoteProvider.invalidateDirectory(profile, posixDirname(source));
                    remoteProvider.invalidateDirectory(profile, posixDirname(target));
                    return [`已移动 ${source} -> ${target}`];
                }
                case 'download':
                case 'download-dir': {
                    const directory = command === 'download-dir';
                    const targets = await resolveRunTargets(profile, cwd, command, args, requireArg);

                    const results: string[] = [];
                    for (const picked of targets) {
                        const remote = picked.replace(/\/$/, '');
                        const local = localForRemote(profile, remote);
                        await service.download(profile, remote, local, directory);
                        if (directory) {
                            remoteProvider.invalidateDirectory(profile, posixDirname(remote));
                        } else {
                            remoteProvider.updateFile(profile, remote, (await vscode.workspace.fs.stat(local)).size);
                        }
                        results.push(`已下载 ${remote} -> ${local.fsPath}`);
                    }
                    return results;
                }
                case 'upload':
                case 'upload-dir': {
                    const directory = command === 'upload-dir';
                    const targets = await resolveRunTargets(profile, cwd, command, args, requireArg);

                    const results: string[] = [];
                    for (const picked of targets) {
                        const local = vscode.Uri.file(picked);
                        let size = 0;
                        try {
                            size = (await vscode.workspace.fs.stat(local)).size;
                        } catch {
                            results.push(`本地文件不存在，已跳过：${local.fsPath}`);
                            continue;
                        }
                        const remote = joinRemote(cwd, path.posix.basename(local.fsPath));
                        if (directory) {
                            await service.uploadDirectory(profile, local, remote);
                            remoteProvider.invalidateDirectory(profile, cwd);
                        } else {
                            await service.upload(profile, local, remote);
                            remoteProvider.updateFile(profile, remote, size);
                        }
                        results.push(`已上传 ${local.fsPath} -> ${remote}`);
                    }
                    return results;
                }
                case 'upgitchange': {
                    const collection = await collectGitChangedFiles(profile.workspaceFolder);
                    const deletedNote = collection.deletedCount ? `；${collection.deletedCount} 个已删除文件已跳过` : '';
                    if (!collection.files.length) { return [`没有可上传的 Git 变动文件${deletedNote}`]; }
                    const finish = activity.begin(`Git 变动上传到 ${profile.name}（${collection.files.length} 个）`);
                    try {
                        const result = await uploadGitChangeFiles(service, profile, collection.files);
                        for (const remote of result.uploaded) { remoteProvider.invalidateDirectory(profile, posixDirname(remote)); }
                        finish(result.failures.length === 0);
                        return [
                            `Git 变动文件 ${collection.files.length} 个：`,
                            ...result.uploaded.map(remote => `  已上传 -> ${remote}`),
                            ...result.failures.map(item => `  失败 ${item}`),
                            ...(result.skippedFilter ? [`  ${result.skippedFilter} 个文件被上传过滤规则跳过`] : []),
                            `完成：成功 ${result.uploaded.length}，失败 ${result.failures.length}${deletedNote}`,
                        ];
                    } catch (error) {
                        finish(false);
                        throw error;
                    }
                }
                case 'open': {
                    const targets = await resolveRunTargets(profile, cwd, command, args, requireArg);

                    const results: string[] = [];
                    for (const picked of targets) {
                        const remote = picked.replace(/\/$/, '');
                        const local = localForRemote(profile, remote);
                        await service.download(profile, remote, local, false);
                        remoteProvider.updateFile(profile, remote, (await vscode.workspace.fs.stat(local)).size);
                        await vscode.window.showTextDocument(local);
                        results.push(`已下载并打开 ${local.fsPath}`);
                    }
                    return results;
                }
                case 'cat': {
                    const targets = await resolveRunTargets(profile, cwd, command, args, requireArg);

                    if (targets.length > 1) { return ['/cat 一次只能查看一个文件']; }
                    const text = await readRemoteText(profile, targets[0].replace(/\/$/, ''), 200 * 1024);
                    return text.split(/\r?\n/);
                }
                case 'tail': {
                    const targets = await resolveRunTargets(profile, cwd, command, args, requireArg);

                    if (targets.length > 1) { return ['/tail 一次只能查看一个文件']; }
                    const lines = args[1] ? Math.max(1, Math.min(1000, Number.parseInt(args[1], 10) || 50)) : 50;
                    const text = await readRemoteText(profile, targets[0].replace(/\/$/, ''), 2 * 1024 * 1024, lines);
                    return text.split(/\r?\n/);
                }
                default:
                    return undefined;
            }
        },
    };
}

function isFtp(profile: SftpProfile): boolean {
    return profile.protocol === 'ftp' || profile.protocol === 'ftps';
}

function validateRemoteName(value: string): string | undefined {
    if (!value.trim()) { return '名称不能为空'; }
    if (value.includes('/') || value.includes('\\')) { return '名称不能包含路径分隔符'; }
    if (value === '.' || value === '..') { return '名称无效'; }
    return undefined;
}

function resolveLocalPath(root: vscode.Uri, value: string): vscode.Uri {
    return path.isAbsolute(value) ? vscode.Uri.file(value) : vscode.Uri.joinPath(root, ...value.replace(/\\/g, '/').split('/'));
}

function normalizeRemote(value: string): string {
    const normalized = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

function joinRemote(base: string, child: string): string {
    return `${normalizeRemote(base)}/${child.replace(/\\/g, '/').replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
}

function posixDirname(value: string): string {
    const index = value.lastIndexOf('/');
    return index <= 0 ? '/' : value.slice(0, index);
}

function formatSize(size = 0): string {
    if (size < 1024) { return `${size} B`; }
    if (size < 1024 * 1024) { return `${(size / 1024).toFixed(1)} KB`; }
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
