import * as vscode from 'vscode';
import * as path from 'path';
import { Writable } from 'stream';
import { Client as FtpClient, FileType as FtpFileType } from 'basic-ftp';

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
        public readonly kind: 'profile' | 'directory' | 'file' | 'loadMore',
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        description?: string,
        public readonly parent?: SftpTreeItem,
    ) {
        super(label, collapsibleState);
        this.description = description;
        this.contextValue = `remote-${kind}`;
        this.iconPath = new vscode.ThemeIcon(kind === 'profile' ? 'remote' : kind === 'directory' ? 'folder' : kind === 'loadMore' ? 'more' : 'file');
        if (kind === 'file') {
            this.command = {
                command: 'leidong-tools.sftp.preview',
                title: '预览远程文件',
                arguments: [this],
            };
        } else if (kind === 'loadMore') {
            this.command = { command: 'leidong-tools.sftp.loadMore', title: '加载更多远程文件', arguments: [this] };
        }
        this.tooltip = kind === 'profile'
            ? `${profile.protocol.toUpperCase()} · ${profile.username}@${profile.host}:${profile.port}${profile.remotePath}`
            : remotePath;
    }
}

class SftpConfigStore {
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

    constructor(private readonly logger: RemoteLogger) {}

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

    async upload(profile: SftpProfile, localUri: vscode.Uri, remotePath: string): Promise<void> {
        if (!this.isUploadAllowed(profile, localUri)) {
            this.logger.info(profile, `已按过滤规则跳过 ${localUri.fsPath}`);
            return;
        }
        this.logger.info(profile, `上传文件 ${localUri.fsPath} -> ${remotePath}`);
        if (isFtp(profile)) {
            await this.withFtpClient(profile, async client => {
                await client.ensureDir(posixDirname(remotePath));
                await client.uploadFrom(localUri.fsPath, remotePath);
            });
            return;
        }
        await this.withSftpClient(profile, async client => {
            const parent = posixDirname(remotePath);
            await client.mkdir(parent, true);
            await client.fastPut(localUri.fsPath, remotePath);
        });
    }

    async uploadDirectory(profile: SftpProfile, localUri: vscode.Uri, remotePath: string): Promise<void> {
        if (!this.isUploadAllowed(profile, localUri)) {
            this.logger.info(profile, `已按过滤规则跳过目录 ${localUri.fsPath}`);
            return;
        }
        this.logger.info(profile, `上传目录 ${localUri.fsPath} -> ${remotePath}`);
        await this.createDirectory(profile, remotePath);
        const entries = await vscode.workspace.fs.readDirectory(localUri);
        for (const [name, type] of entries) {
            const childLocal = vscode.Uri.joinPath(localUri, name);
            const childRemote = joinRemote(remotePath, name);
            if ((type & vscode.FileType.Directory) !== 0) {
                await this.uploadDirectory(profile, childLocal, childRemote);
            } else if ((type & vscode.FileType.File) !== 0) {
                await this.upload(profile, childLocal, childRemote);
            }
        }
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
                    await client.downloadTo(localUri.fsPath, remotePath);
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
                await client.fastGet(remotePath, localUri.fsPath);
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

    private async withSftpClient<T>(profile: SftpProfile, action: (client: any) => Promise<T>): Promise<T> {
        const entry = await this.getSftpEntry(profile);
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
                this.sftpConnections.delete(profile.id);
                throw error;
            } finally {
                if (entry.connected) { this.scheduleSftpIdle(profile, entry); }
            }
        });
    }

    private async getSftpEntry(profile: SftpProfile): Promise<SftpConnectionEntry> {
        const signature = profileSignature(profile);
        const existing = this.sftpConnections.get(profile.id);
        if (existing?.signature === signature) { return existing; }
        if (existing) { await this.closeSftp(profile, existing, '配置已更新，旧连接已关闭'); }
        let entry!: SftpConnectionEntry;
        const client = new SftpClient(profile.name, {
            error: (error: Error) => {
                entry.connected = false;
                this.logger.error(profile, error.message);
            },
            end: () => { entry.connected = false; },
            close: () => { entry.connected = false; },
        });
        entry = { client, connected: false, signature, queue: Promise.resolve() };
        this.sftpConnections.set(profile.id, entry);
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
    }

    private scheduleSftpIdle(profile: SftpProfile, entry: SftpConnectionEntry): void {
        entry.idleTimer = setTimeout(() => {
            void this.enqueue(entry, async () => {
                await this.closeSftp(profile, entry, '空闲超时，连接已关闭');
                this.sftpConnections.delete(profile.id);
            });
        }, this.idleTimeoutMs(profile));
    }

    private async closeSftp(profile: SftpProfile, entry: SftpConnectionEntry, reason: string): Promise<void> {
        this.clearIdle(entry);
        if (!entry.connected) { return; }
        entry.connected = false;
        try { await entry.client.end(); } catch { /* Connection may already be closed. */ }
        this.logger.info(profile, reason);
    }

    private async withFtpClient<T>(profile: SftpProfile, action: (client: FtpClient) => Promise<T>): Promise<T> {
        const entry = await this.getFtpEntry(profile);
        return this.enqueue(entry, async () => {
            this.clearIdle(entry);
            try {
                if (entry.client.closed) { await this.connectFtp(profile, entry.client); }
                return await action(entry.client);
            } catch (error) {
                this.logger.error(profile, messageOf(error));
                this.closeFtp(profile, entry, '连接异常，已释放');
                this.ftpConnections.delete(profile.id);
                throw error;
            } finally {
                if (!entry.client.closed) { this.scheduleFtpIdle(profile, entry); }
            }
        });
    }

    private async getFtpEntry(profile: SftpProfile): Promise<FtpConnectionEntry> {
        const signature = profileSignature(profile);
        const existing = this.ftpConnections.get(profile.id);
        if (existing?.signature === signature) { return existing; }
        if (existing) { this.closeFtp(profile, existing, '配置已更新，旧连接已关闭'); }
        const client = new FtpClient(20000);
        if (this.verboseProtocolLogging(profile)) {
            client.ftp.verbose = true;
            client.ftp.log = (message: string) => this.logger.protocol(profile, message);
        }
        const entry = { client, signature, queue: Promise.resolve() };
        this.ftpConnections.set(profile.id, entry);
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
    }

    private scheduleFtpIdle(profile: SftpProfile, entry: FtpConnectionEntry): void {
        entry.idleTimer = setTimeout(() => {
            void this.enqueue(entry, async () => {
                this.closeFtp(profile, entry, '空闲超时，连接已关闭');
                this.ftpConnections.delete(profile.id);
            });
        }, this.idleTimeoutMs(profile));
    }

    private closeFtp(profile: SftpProfile, entry: FtpConnectionEntry, reason: string): void {
        this.clearIdle(entry);
        if (entry.client.closed) { return; }
        entry.client.close();
        this.logger.info(profile, reason);
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

    private idleTimeoutMs(profile: SftpProfile): number {
        const seconds = vscode.workspace.getConfiguration('leidong-tools', profile.workspaceFolder.uri)
            .get<number>('remoteConnectionIdleTimeout', 60);
        return Math.max(10, seconds) * 1000;
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

class SftpTreeProvider implements vscode.TreeDataProvider<SftpTreeItem> {
    private readonly changed = new vscode.EventEmitter<SftpTreeItem | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private profiles: SftpProfile[] = [];
    private readonly directoryCache = new Map<string, { entries: RemoteEntry[]; visible: number; loadedAt: number }>();

    constructor(private readonly configs: SftpConfigStore, private readonly service: SftpService) {}

    refresh(): void {
        this.profiles = [];
        this.directoryCache.clear();
        this.changed.fire(undefined);
    }

    loadMore(item: SftpTreeItem): void {
        const parent = item.parent;
        if (!parent) { return; }
        const cached = this.directoryCache.get(this.cacheKey(parent));
        if (!cached) { return; }
        cached.visible = Math.min(cached.entries.length, cached.visible + this.pageSize(parent.profile));
        this.changed.fire(parent);
    }

    getTreeItem(element: SftpTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SftpTreeItem): Promise<SftpTreeItem[]> {
        if (!element) {
            this.profiles = await this.configs.loadProfiles(true);
            return this.profiles.map(profile => new SftpTreeItem(
                profile,
                profile.remotePath,
                'profile',
                profile.name,
                vscode.TreeItemCollapsibleState.Collapsed,
                `${profile.protocol.toUpperCase()} · ${profile.host} · ${path.basename(profile.configUri.fsPath)}`,
            ));
        }
        if (element.kind === 'file' || element.kind === 'loadMore') {
            return [];
        }
        try {
            const key = this.cacheKey(element);
            let cached = this.directoryCache.get(key);
            if (!cached || Date.now() - cached.loadedAt > 30000) {
                const entries = (await this.service.list(element.profile, element.remotePath))
                    .filter(entry => entry.name !== '.' && entry.name !== '..')
                    .sort((a, b) => (a.type === 'd' ? 0 : 1) - (b.type === 'd' ? 0 : 1) || a.name.localeCompare(b.name));
                cached = { entries, visible: Math.min(entries.length, this.pageSize(element.profile)), loadedAt: Date.now() };
                this.directoryCache.set(key, cached);
            }
            const items = cached.entries
                .slice(0, cached.visible)
                .map(entry => {
                    const directory = entry.type === 'd';
                    return new SftpTreeItem(
                        element.profile,
                        joinRemote(element.remotePath, entry.name),
                        directory ? 'directory' : 'file',
                        entry.name,
                        directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                        directory ? undefined : formatSize(entry.size),
                    );
                });
            if (cached.visible < cached.entries.length) {
                items.push(new SftpTreeItem(
                    element.profile,
                    element.remotePath,
                    'loadMore',
                    `加载更多（${cached.visible}/${cached.entries.length}）`,
                    vscode.TreeItemCollapsibleState.None,
                    undefined,
                    element,
                ));
            }
            return items;
        } catch (error) {
            void vscode.window.showErrorMessage(`${element.profile.protocol.toUpperCase()} 目录读取失败: ${messageOf(error)}`);
            return [];
        }
    }

    private cacheKey(item: SftpTreeItem): string {
        return `${item.profile.id}|${item.remotePath}`;
    }

    private pageSize(profile: SftpProfile): number {
        const value = vscode.workspace.getConfiguration('leidong-tools', profile.workspaceFolder.uri)
            .get<number>('remoteDirectoryPageSize', 200);
        return Math.max(50, Math.min(1000, value));
    }
}

class SftpPreviewProvider implements vscode.FileSystemProvider {
    private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changed.event;
    private readonly targets = new Map<string, { profile: SftpProfile; remotePath: string }>();

    constructor(private readonly service: SftpService) {}

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
        const content = await this.readFile(uri);
        return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: content.byteLength };
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const target = this.targets.get(uri.toString());
        if (!target) {
            throw vscode.FileSystemError.FileNotFound('远程预览信息已失效，请重新打开文件');
        }
        return this.service.read(target.profile, target.remotePath);
    }

    readDirectory(): never { throw vscode.FileSystemError.NoPermissions('远程预览为只读'); }
    createDirectory(): never { throw vscode.FileSystemError.NoPermissions('远程预览为只读'); }
    writeFile(): never { throw vscode.FileSystemError.NoPermissions('远程预览为只读'); }
    delete(): never { throw vscode.FileSystemError.NoPermissions('远程预览为只读'); }
    rename(): never { throw vscode.FileSystemError.NoPermissions('远程预览为只读'); }
}

class RemoteExplorerWebviewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'leidong-tools.sftpView';
    private view?: vscode.WebviewView;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly configs: SftpConfigStore,
        private readonly service: SftpService,
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'src', 'webview')] };
        const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'remoteExplorer.js'));
        const style = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'remoteExplorer.css'));
        const nonce = Date.now().toString(36);
        view.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body><div class="remote-toolbar"><button id="refresh">刷新</button><button id="config">配置</button><button id="logs">日志</button></div><div id="remote-root"></div><div id="remote-empty" class="remote-empty">未找到远程配置</div><script nonce="${nonce}" src="${script}"></script></body></html>`;
        view.webview.onDidReceiveMessage(message => { void this.handleMessage(message); });
    }

    refresh(): void { void this.postProfiles(); }

    private async handleMessage(message: any): Promise<void> {
        if (message.type === 'ready' || message.type === 'refresh') { await this.postProfiles(); return; }
        if (message.type === 'command') { await vscode.commands.executeCommand(message.command); return; }
        const profiles = await this.configs.loadProfiles(true);
        const profile = profiles.find(item => item.id === message.profileId || item.id === message.node?.profileId);
        if (!profile) { return; }
        if (message.type === 'list') {
            try {
                const entries = await this.service.list(profile, message.remotePath);
                const items = entries.filter(entry => entry.name !== '.' && entry.name !== '..')
                    .sort((a, b) => (a.type === 'd' ? 0 : 1) - (b.type === 'd' ? 0 : 1) || a.name.localeCompare(b.name))
                    .map(entry => ({ profileId: profile.id, remotePath: joinRemote(message.remotePath, entry.name), kind: entry.type === 'd' ? 'directory' : 'file', label: entry.name, meta: entry.type === 'd' ? '' : formatSize(entry.size) }));
                await this.view?.webview.postMessage({ type: 'response', requestId: message.requestId, items });
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
            const command = message.action === 'preview' ? 'leidong-tools.sftp.preview'
                : message.action === 'download' ? 'leidong-tools.sftp.download'
                    : message.action === 'uploadFolder' ? 'leidong-tools.sftp.uploadFolder'
                        : 'leidong-tools.sftp.uploadFile';
            await vscode.commands.executeCommand(command, item);
        }
    }

    private async postProfiles(): Promise<void> {
        const profiles = await this.configs.loadProfiles(true);
        await this.view?.webview.postMessage({ type: 'profiles', items: profiles.map(profile => ({ profileId: profile.id, remotePath: profile.remotePath, kind: 'profile', label: profile.name, meta: profile.protocol.toUpperCase() })) });
    }
}

export function registerSftpManager(context: vscode.ExtensionContext): void {
    const configs = new SftpConfigStore();
    const logger = new RemoteLogger();
    const activity = new RemoteActivity();
    const service = new SftpService(logger);
    const remoteProvider = new RemoteExplorerWebviewProvider(context.extensionUri, configs, service);
    const preview = new SftpPreviewProvider(service);
    const viewRegistration = vscode.window.registerWebviewViewProvider(RemoteExplorerWebviewProvider.viewType, remoteProvider);

    const run = async (label: string, action: () => Promise<void>) => {
        const finish = activity.begin(label);
        logger.info(undefined, label);
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: label }, action);
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

    const flushAutoUpload = async (key: string, state: AutoUploadState): Promise<void> => {
        if (state.running) { return; }
        state.running = true;
        const runningGeneration = state.generation;
        const document = state.document;
        let succeeded = true;
        try {
            const folder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (!folder) { return; }
            const profiles = (await configs.loadProfiles()).filter(profile =>
                profile.workspaceFolder.uri.toString() === folder.uri.toString() && profile.uploadOnSave,
            );
            const selected = readAutoUploadTargets(context, folder);
            const targets = selected === undefined ? profiles : profiles.filter(profile => selected.includes(profile.id));
            if (!targets.length) { return; }
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
        }),
        vscode.workspace.registerFileSystemProvider('leidong-sftp', preview, { isReadonly: true, isCaseSensitive: true }),
        vscode.commands.registerCommand('leidong-tools.sftp.showLogs', () => logger.show()),
        vscode.commands.registerCommand('leidong-tools.sftp.refresh', () => remoteProvider.refresh()),
        vscode.commands.registerCommand('leidong-tools.sftp.openConfig', async () => {
            const folder = await chooseWorkspaceFolder();
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
                await vscode.commands.executeCommand('vscode.open', preview.createUri(item), { preview: true });
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
                void vscode.window.showInformationMessage(`已下载到 ${localUri.fsPath}`);
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.upload', async (argument?: SftpTreeItem | vscode.Uri, selectionMode?: 'file' | 'folder') => {
            const item = argument instanceof SftpTreeItem ? argument : undefined;
            const resource = argument instanceof vscode.Uri ? argument : undefined;
            const profile = item?.profile ?? await pickProfile(configs);
            if (!profile) { return; }
            const targetDirectory = item?.kind === 'directory' ? item.remotePath : item?.kind === 'profile' ? item.profile.remotePath : profile.remotePath;
            const sources = resource ? [resource] : await vscode.window.showOpenDialog({
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
                remoteProvider.refresh();
                void vscode.window.showInformationMessage(`已上传到 ${profile.name}: ${targetDirectory}`);
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.uploadFile', (argument?: SftpTreeItem | vscode.Uri) =>
            vscode.commands.executeCommand('leidong-tools.sftp.upload', argument, 'file')),
        vscode.commands.registerCommand('leidong-tools.sftp.uploadFolder', (argument?: SftpTreeItem | vscode.Uri) =>
            vscode.commands.executeCommand('leidong-tools.sftp.upload', argument, 'folder')),
        vscode.commands.registerCommand('leidong-tools.sftp.uploadCurrentFile', async (resource?: vscode.Uri) => {
            const localUri = resource?.scheme === 'file' ? resource : vscode.window.activeTextEditor?.document.uri;
            if (!localUri || localUri.scheme !== 'file') {
                void vscode.window.showWarningMessage('没有可上传的本地文件');
                return;
            }
            const profile = await pickProfile(configs, localUri);
            if (!profile) { return; }
            await run(`正在上传到 ${profile.name}`, async () => {
                await uploadMappedFile(service, profile, localUri, true);
                remoteProvider.refresh();
            });
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
            const names = selected.map(entry => entry.profile.name);
            void vscode.window.showInformationMessage(names.length ? `自动上传目标：${names.join('、')}` : '已关闭该工作区的保存自动上传');
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.createDirectory', async (item?: SftpTreeItem) => {
            if (!item || item.kind === 'file') { return; }
            const name = await vscode.window.showInputBox({ prompt: '输入新目录名称', validateInput: validateRemoteName });
            if (!name) { return; }
            await run('新建远程目录', async () => {
                await service.createDirectory(item.profile, joinRemote(item.remotePath, name));
                remoteProvider.refresh();
            });
        }),
        vscode.commands.registerCommand('leidong-tools.sftp.rename', async (item?: SftpTreeItem) => {
            if (!item || item.kind === 'profile') { return; }
            const currentName = path.posix.basename(item.remotePath);
            const name = await vscode.window.showInputBox({ prompt: '输入新名称', value: currentName, validateInput: validateRemoteName });
            if (!name || name === currentName) { return; }
            await run('远程重命名', async () => {
                await service.rename(item.profile, item.remotePath, joinRemote(posixDirname(item.remotePath), name));
                remoteProvider.refresh();
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
                remoteProvider.refresh();
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
}

async function uploadMappedFile(service: SftpService, profile: SftpProfile, localUri: vscode.Uri, notify: boolean): Promise<void> {
    const relative = path.relative(profile.workspaceFolder.uri.fsPath, localUri.fsPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('文件不在该配置所属的工作区中');
    }
    const remote = joinRemote(profile.remotePath, relative.replace(/\\/g, '/'));
    await service.upload(profile, localUri, remote);
    if (notify) {
        void vscode.window.showInformationMessage(`已上传到 ${profile.name}: ${remote}`);
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

async function chooseWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1) { return folders[0]; }
    const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择要创建 SFTP 配置的工作区' });
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
