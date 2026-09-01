import * as path from 'path';
import * as vscode from 'vscode';
import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import type { SftpConfigStore, SftpProfile } from './sftpManager';

const terminalProfileId = 'leidong-tools.remoteTerminal';
const commonCommands = [
    'cd', 'ls', 'pwd', 'cat', 'less', 'grep', 'find', 'head', 'tail', 'mkdir', 'touch', 'cp', 'mv', 'rm',
    'chmod', 'chown', 'tar', 'zip', 'unzip', 'git', 'npm', 'pnpm', 'yarn', 'node', 'python', 'php', 'composer',
    'vim', 'vi', 'nano', 'top', 'ps', 'kill', 'curl', 'wget', 'ssh', 'exit', 'clear',
];
const pathCommands = new Set(['cd', 'ls', 'cat', 'less', 'head', 'tail', 'grep', 'find', 'vim', 'vi', 'nano', 'rm', 'cp', 'mv', 'mkdir', 'touch']);

/** 内置斜杠指令（不发送给远端 shell，由扩展本地执行）。 */
export const BUILTIN_COMMANDS = new Set([
    'help', 'ls', 'pwd', 'download', 'download-dir', 'upload', 'upload-dir', 'upgitchange',
    'mkdir', 'rm', 'mv', 'cat', 'tail', 'open',
]);

/** 内置指令说明（用于 / 指令选择器）。 */
const BUILTIN_DESCRIPTIONS: Record<string, string> = {
    'help': '显示所有内置指令',
    'ls': '列出远端目录',
    'pwd': '显示当前远程目录',
    'download': '下载远端文件到本地对应目录',
    'download-dir': '下载远端目录到本地对应目录',
    'upload': '上传本地文件到远端当前目录',
    'upload-dir': '上传本地目录到远端当前目录',
    'upgitchange': '上传工作区 Git 变动（新增/修改）文件到远端对应路径',
    'open': '下载远端文件并用编辑器打开',
    'cat': '显示远端文件内容',
    'tail': '显示远端文件末尾',
    'mkdir': '远端新建目录',
    'rm': '删除远端文件或目录',
    'mv': '移动/重命名远端路径',
};

/** 需要参数的内置指令（选择器选中后注入命令等待输入参数）。 */
const BUILTIN_NEEDS_ARG = new Set(['download', 'download-dir', 'upload', 'upload-dir', 'open', 'cat', 'tail', 'mkdir', 'rm', 'mv']);

/** 内置指令处理器：返回输出行；命令不存在时返回 undefined（按普通命令发送）。 */
export interface RemoteTerminalBuiltins {
    isBuiltin(command: string): boolean;
    run(profile: SftpProfile, command: string, args: string[], currentDirectory: string): Promise<string[] | undefined>;
}

/** Interactive shells use a dedicated SSH client and never block SFTP transfers. */
export function registerRemoteTerminal(
    context: vscode.ExtensionContext,
    configs: SftpConfigStore,
    onDirectoryChange?: (profile: SftpProfile, directory: string) => void,
    builtins?: RemoteTerminalBuiltins,
): void {
    let activeTerminal: RemoteSshTerminal | undefined;
    const recordHistory = (profile: SftpProfile, command: string): void => {
        const trimmed = command.trim();
        if (!trimmed) { return; }
        const key = `remoteTerminal.history.${profile.id}`;
        const previous = context.workspaceState.get<string[]>(key, []).filter(item => item !== trimmed);
        void context.workspaceState.update(key, [trimmed, ...previous].slice(0, 100));
    };
    const create = (profile: SftpProfile): vscode.TerminalProfile => createTerminalProfile(
        profile,
        terminal => { activeTerminal = terminal; },
        recordHistory,
        onDirectoryChange ? (directory: string) => onDirectoryChange(profile, directory) : undefined,
        builtins ? (command: string, args: string[], cwd: string) => builtins.run(profile, command, args, cwd) : undefined,
    );
    const provider: vscode.TerminalProfileProvider = {
        provideTerminalProfile: async (token) => {
            const profile = await pickTerminalProfile(configs, token);
            return profile ? create(profile) : undefined;
        },
    };

    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider(terminalProfileId, provider),
        vscode.commands.registerCommand('leidong-tools.remoteTerminal.open', async () => {
            const profile = await pickTerminalProfile(configs);
            if (!profile) { return; }
            const terminal = vscode.window.createTerminal(create(profile).options);
            terminal.show();
        }),
        vscode.commands.registerCommand('leidong-tools.remoteTerminal.runSavedCommand', async () => {
            if (!activeTerminal?.isOpen) {
                void vscode.window.showWarningMessage('请先打开一个雷动远程终端');
                return;
            }
            const configuration = vscode.workspace.getConfiguration('leidong-tools', activeTerminal.profile.workspaceFolder.uri);
            const favorites = configuration.get<string[]>('remoteTerminalFavoriteCommands', []);
            const history = context.workspaceState.get<string[]>(`remoteTerminal.history.${activeTerminal.profile.id}`, []);
            const picked = await vscode.window.showQuickPick([
                ...favorites.map(command => ({ label: command, description: '收藏命令' })),
                ...history.filter(command => !favorites.includes(command)).map(command => ({ label: command, description: '历史命令' })),
            ], { placeHolder: '选择要在当前远程终端执行的命令' });
            if (picked) { activeTerminal.runCommand(picked.label); }
        }),
    );
}

function createTerminalProfile(
    profile: SftpProfile,
    onCreated: (terminal: RemoteSshTerminal) => void,
    onCommandSubmitted: (profile: SftpProfile, command: string) => void,
    onDirectoryChange?: (directory: string) => void,
    runBuiltin?: (command: string, args: string[], currentDirectory: string) => Promise<string[] | undefined>,
): vscode.TerminalProfile {
    const terminal = new RemoteSshTerminal(profile, onCommandSubmitted, onDirectoryChange, runBuiltin);
    onCreated(terminal);
    return new vscode.TerminalProfile({
        name: `远程终端: ${profile.name}`,
        iconPath: new vscode.ThemeIcon('terminal'),
        pty: terminal,
        isTransient: true,
    });
}

async function pickTerminalProfile(configs: SftpConfigStore, token?: vscode.CancellationToken): Promise<SftpProfile | undefined> {
    const allProfiles = await configs.loadProfiles(true);
    if (token?.isCancellationRequested) { return undefined; }
    const sshProfiles = allProfiles.filter(profile => profile.protocol === 'sftp' || profile.protocol === 'ssh');
    if (!sshProfiles.length) {
        const hasFtp = allProfiles.some(profile => profile.protocol === 'ftp' || profile.protocol === 'ftps');
        void vscode.window.showWarningMessage(hasFtp
            ? 'FTP/FTPS 不支持交互式终端，请使用 SFTP 或 SSH 配置。'
            : '未找到 SSH/SFTP 配置，请先创建 .vscode/sftp.json。');
        return undefined;
    }
    if (sshProfiles.length === 1) { return sshProfiles[0]; }
    const picked = await vscode.window.showQuickPick(
        sshProfiles.map(profile => ({
            label: profile.name,
            description: `${profile.username}@${profile.host}:${profile.port}`,
            detail: `打开后进入 ${profile.remotePath}`,
            profile,
        })),
        { placeHolder: '选择要打开的远程终端配置' },
        token,
    );
    return picked?.profile;
}

class RemoteSshTerminal implements vscode.Pseudoterminal, vscode.Disposable {
    private readonly writeEmitter = new vscode.EventEmitter<string>();
    private readonly closeEmitter = new vscode.EventEmitter<number | void>();
    private readonly nameEmitter = new vscode.EventEmitter<string>();
    private client?: Client;
    private channel?: ClientChannel;
    private dimensions: vscode.TerminalDimensions = { columns: 80, rows: 30 };
    private bufferedInput = '';
    private inputLine = '';
    private currentDirectory: string;
    private ghostText = '';
    private completionTimer?: NodeJS.Timeout;
    private completionGeneration = 0;
    /** 输入行处于内置指令模式（以 / 开头）时缓冲字符，回车统一决策，避免脏字符透传远端。 */
    private builtinBuffered = false;
    private readonly directoryCache = new Map<string, { entries: string[]; expiresAt: number }>();
    private closed = false;

    readonly onDidWrite = this.writeEmitter.event;
    readonly onDidClose = this.closeEmitter.event;
    readonly onDidChangeName = this.nameEmitter.event;

    constructor(
        readonly profile: SftpProfile,
        private readonly onCommandSubmitted: (profile: SftpProfile, command: string) => void,
        private readonly onDirectoryChange?: (directory: string) => void,
        private readonly runBuiltin?: (command: string, args: string[], currentDirectory: string) => Promise<string[] | undefined>,
    ) {
        this.currentDirectory = profile.remotePath;
    }

    get isOpen(): boolean { return !this.closed && !!this.channel; }

    runCommand(command: string): void {
        if (!this.isOpen || !command.trim()) { return; }
        this.clearGhost();
        this.trackInput(`${command}\n`);
        this.sendInput(`${command}\n`);
    }

    open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        if (initialDimensions) { this.dimensions = initialDimensions; }
        this.nameEmitter.fire(`远程终端: ${this.profile.name}`);
        this.write(`\x1b[90m正在连接 ${this.profile.username}@${this.profile.host}:${this.profile.port}...\x1b[0m\r\n`);
        void this.connect();
    }

    close(): void { this.shutdown(); }

    handleInput(data: string): void {
        if (data === '\t' && this.ghostText) {
            const accepted = this.ghostText;
            this.clearGhost();
            this.inputLine += accepted;
            this.sendInput(accepted);
            this.scheduleCompletion();
            return;
        }
        this.clearGhost();

        // 本地内置指令没有远端进程可中断。之前 Ctrl+C 会先经过 trackInput 清空
        // inputLine，再落入 builtinBuffered 分支，留下一个“半截”输入状态，下一
        // 次输入时就可能把选择器重绘到错误的光标位置。先在这里一次性清理本地行。
        if (data === '\x03' || data === '\x15') {
            if (this.builtinBuffered || this.inputLine.trim().startsWith('/')) {
                this.inputLine = '';
                this.builtinBuffered = false;
                this.clearCompletionTimer();
                this.write('\r\x1b[2K');
            } else {
                // 普通远端命令仍需把中断键发送给远端 Shell。
                this.trackInput(data);
                this.sendInput(data);
            }
            return;
        }

        const containsEnter = data.includes('\r') || data.includes('\n');
        if (containsEnter) {
            const fullLine = this.inputLine;
            if (this.tryInterceptBuiltin(data)) { return; }
            this.trackInput(data);
            if (this.builtinBuffered) {
                // 内置模式下缓冲的字符此时补发（不是内置指令，按普通命令发送）
                // 先清掉本地回显，远端 shell 会重新回显整行
                this.builtinBuffered = false;
                this.write('\r\x1b[2K');
                this.sendInput(fullLine + '\r');
            } else {
                this.sendInput(data);
            }
            return;
        }

        // 非回车：内置指令模式缓冲字符并本地回显，其余实时发送（保持远端 shell 交互）
        this.trackInput(data);
        const isBuiltinMode = this.isBuiltinMode(this.inputLine);
        if (isBuiltinMode) {
            this.builtinBuffered = true;
            this.echoLocal(data);
        } else if (this.builtinBuffered) {
            // 退出内置模式：清掉本地回显后补发缓冲内容（避免与远端回显重复）
            this.builtinBuffered = false;
            this.write('\r\x1b[2K');
            this.sendInput(this.inputLine);
        } else {
            this.sendInput(data);
        }
    }

    /** 内置指令模式的本地回显：缓冲的字符不发送远端，需要自行显示（远端 TTY 不会回显）。 */
    private echoLocal(data: string): void {
        if (data === '\x7f' || data === '\b') {
            // 退格：擦除上一个字符
            this.write('\b \b');
        } else if (data === '\x03' || data === '\x15') {
            // Ctrl+C / Ctrl+U：清空当前输入行（远端没有命令在跑，无需转发）
            this.write('\r\x1b[2K');
        } else if (!data.includes('\x1b')) {
            // 普通可打印字符（含空格）：直接显示
            this.write(data);
        }
    }

    /** 输入行是否处于内置指令模式（以 / 开头；带空格时首词必须命中内置指令）。 */
    private isBuiltinMode(line: string): boolean {
        const trimmed = line.trim();
        if (!trimmed.startsWith('/')) { return false; }
        if (!trimmed.includes(' ')) { return true; }
        const firstToken = trimmed.split(/\s+/)[0].slice(1);
        return BUILTIN_COMMANDS.has(firstToken);
    }

    /** 清空当前终端行并注入文本（不发送远端）。 */
    private injectCommandLine(text: string): void {
        this.clearGhost();
        this.clearCompletionTimer();
        this.write(`\r\x1b[2K`);
        this.inputLine = text;
        this.builtinBuffered = Boolean(text);
        if (text) {
            this.write(text);
            this.scheduleCompletion();
        }
    }

    private async executeBuiltin(command: string, args: string[], cwd: string): Promise<void> {
        if (!this.runBuiltin) { return; }
        try {
            const output = await this.runBuiltin(command, args, cwd);
            if (output && output.length > 0) {
                this.write(`\r\n${output.join('\r\n')}\r\n`);
            }
        } catch (error) {
            this.write(`\r\n\x1b[31m${messageOf(error)}\x1b[0m\r\n`);
        }
    }

    /**
     * 拦截 `/xxx` 内置指令（回车时判断）：不发送给远端 shell，
     * 由扩展本地执行并把输出行写回终端。
     */
    private tryInterceptBuiltin(data: string): boolean {
        if ((!data.includes('\r') && !data.includes('\n')) || !this.runBuiltin) { return false; }
        const fullLine = this.inputLine.trim();
        if (!fullLine.startsWith('/')) { return false; }
        const match = fullLine.match(/^\/(\w+)(?:\s+(.*))?$/);
        if (!match) { return false; }
        const [, command] = match;
        if (!BUILTIN_COMMANDS.has(command)) { return false; }

        const args = match[2] ? match[2].trim().split(/\s+/) : [];
        this.inputLine = '';
        this.builtinBuffered = false;
        this.clearCompletionTimer();
        this.onCommandSubmitted(this.profile, fullLine);
        void this.runBuiltin(command, args, this.currentDirectory)
            .then(output => {
                if (output === undefined) {
                    // 处理器不识别（理论上不会发生）：按普通命令发送
                    this.sendInput(data);
                    return;
                }
                if (output.length > 0) {
                    this.write(`\r\n${output.join('\r\n')}\r\n`);
                }
            })
            .catch(error => {
                this.write(`\r\n\x1b[31m${messageOf(error)}\x1b[0m\r\n`);
            });
        return true;
    }

    setDimensions(dimensions: vscode.TerminalDimensions): void {
        this.dimensions = dimensions;
        this.channel?.setWindow(dimensions.rows, dimensions.columns, 0, 0);
    }

    dispose(): void {
        this.shutdown();
        this.writeEmitter.dispose();
        this.closeEmitter.dispose();
        this.nameEmitter.dispose();
    }

    private async connect(): Promise<void> {
        try {
            const config = await this.createConnectConfig();
            if (this.closed) { return; }
            const client = this.client = new Client();
            client.on('ready', () => this.openShell(client));
            client.on('error', error => this.fail(`连接失败：${error.message}`));
            client.on('close', () => this.finish());
            client.connect(config);
        } catch (error) {
            this.fail(`读取连接配置失败：${messageOf(error)}`);
        }
    }

    private openShell(client: Client): void {
        client.shell({
            term: 'xterm-256color',
            cols: this.dimensions.columns,
            rows: this.dimensions.rows,
        }, (error, channel) => {
            if (error) { this.fail(`无法打开远程 Shell：${error.message}`); return; }
            if (this.closed) { channel.close(); return; }
            this.channel = channel;
            channel.on('data', (data: Buffer) => this.writeRemoteOutput(data.toString()));
            channel.stderr.on('data', (data: Buffer) => this.writeRemoteOutput(data.toString()));
            channel.on('close', () => this.finish());
            this.write(`\x1b[90m已连接，当前目录：${this.profile.remotePath}\x1b[0m\r\n`);
            channel.write(`cd ${shellQuote(this.profile.remotePath)}\n`);
            if (this.bufferedInput) {
                channel.write(this.bufferedInput);
                this.bufferedInput = '';
            }
        });
    }

    private async createConnectConfig(): Promise<ConnectConfig> {
        const config: ConnectConfig = {
            host: this.profile.host,
            port: this.profile.port,
            username: this.profile.username,
            readyTimeout: 20000,
            keepaliveInterval: 15000,
            keepaliveCountMax: 3,
        };
        if (this.profile.password) { config.password = this.profile.password; }
        if (this.profile.privateKey) {
            const keyUri = path.isAbsolute(this.profile.privateKey)
                ? vscode.Uri.file(this.profile.privateKey)
                : vscode.Uri.joinPath(this.profile.workspaceFolder.uri, ...this.profile.privateKey.replace(/\\/g, '/').split('/'));
            config.privateKey = Buffer.from(await vscode.workspace.fs.readFile(keyUri));
        }
        if (this.profile.passphrase) { config.passphrase = this.profile.passphrase; }
        return config;
    }

    private fail(message: string): void {
        if (this.closed) { return; }
        this.write(`\x1b[31m${message}\x1b[0m\r\n`);
        this.finish(1);
    }

    private finish(exitCode?: number): void {
        if (this.closed) { return; }
        this.closed = true;
        this.clearCompletionTimer();
        this.channel = undefined;
        try { this.client?.end(); } catch { /* Connection may already be closed. */ }
        this.closeEmitter.fire(exitCode);
    }

    private shutdown(): void {
        if (this.closed) { return; }
        this.closed = true;
        this.clearCompletionTimer();
        try { this.channel?.close(); } catch { /* Shell may already be closed. */ }
        try { this.client?.end(); } catch { /* Client may already be closed. */ }
        this.channel = undefined;
    }

    private write(value: string): void {
        if (!this.closed) { this.writeEmitter.fire(value); }
    }

    private sendInput(data: string): void {
        if (this.channel) { this.channel.write(data); } else { this.bufferedInput += data; }
    }

    private writeRemoteOutput(value: string): void {
        this.clearGhost();
        this.write(value);
    }

    private trackInput(data: string): void {
        if (data === '\x03' || data === '\x15') {
            this.inputLine = '';
            this.clearCompletionTimer();
            return;
        }
        if (data === '\x7f' || data === '\b') {
            this.inputLine = this.inputLine.slice(0, -1);
            this.scheduleCompletion();
            return;
        }
        if (data.includes('\r') || data.includes('\n')) {
            const lines = data.split(/\r?\n|\r/);
            this.onCommandSubmitted(this.profile, this.inputLine);
            this.updateDirectoryFromCommand(this.inputLine);
            this.inputLine = lines[lines.length - 1] || '';
            this.clearCompletionTimer();
            return;
        }
        // Cursor movement and other terminal escape sequences cannot be safely
        // mirrored here, so they simply dismiss the ghost suggestion.
        if (data.includes('\x1b')) { this.clearCompletionTimer(); return; }
        if (/^[\x20-\x7e]+$/.test(data)) {
            this.inputLine += data;
            this.scheduleCompletion();
        }
    }

    private scheduleCompletion(): void {
        this.clearCompletionTimer();
        const line = this.inputLine;
        if (!line.trim() || !this.channel || this.closed) { return; }
        const generation = ++this.completionGeneration;
        this.completionTimer = setTimeout(() => {
            void this.resolveSuggestion(line).then(suggestion => {
                if (generation !== this.completionGeneration || this.inputLine !== line || this.closed || !suggestion) { return; }
                this.showGhost(suggestion);
            }).catch(() => { /* Completion is best-effort and must not affect the shell. */ });
        }, 180);
    }

    private clearCompletionTimer(): void {
        this.completionGeneration++;
        if (this.completionTimer) { clearTimeout(this.completionTimer); this.completionTimer = undefined; }
    }

    private async resolveSuggestion(line: string): Promise<string | undefined> {
        const trimmed = line.trim();
        // 内置指令补全：/up → /upload（Tab 接受）；/ 指令列表由选择器提供
        if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
            const prefix = trimmed.slice(1);
            const candidate = [...BUILTIN_COMMANDS].find(command => command.startsWith(prefix) && command !== prefix);
            return candidate ? candidate.slice(prefix.length) : undefined;
        }
        const lastToken = line.slice(Math.max(line.lastIndexOf(' '), line.lastIndexOf('\t')) + 1);
        // @ 文件选择器模式：交给选择器，不走路径补全
        if (lastToken.startsWith('@')) { return undefined; }
        const words = line.trim().split(/\s+/);
        if (words.length === 1 && !/[/\\.]/.test(lastToken)) {
            return commonCommands.find(command => command.startsWith(lastToken) && command !== lastToken)?.slice(lastToken.length);
        }
        if (!this.isPathContext(words, lastToken)) { return undefined; }
        const candidate = await this.findDirectoryCandidate(lastToken);
        return candidate?.slice(lastToken.length);
    }

    private isPathContext(words: string[], token: string): boolean {
        return token.includes('/') || token.startsWith('.') || (words.length > 1 && pathCommands.has(words[0]));
    }

    private async findDirectoryCandidate(token: string): Promise<string | undefined> {
        const base = path.posix.dirname(token || '.');
        const prefix = token === '' ? '' : path.posix.basename(token);
        const directory = token.startsWith('/')
            ? path.posix.normalize(base)
            : path.posix.resolve(this.currentDirectory, base);
        const entries = await this.listDirectory(directory);
        const entry = entries.find(name => name.startsWith(prefix) && name !== prefix);
        if (!entry) { return undefined; }
        return base === '.' ? entry : `${base.replace(/\/$/, '')}/${entry}`;
    }

    private async listDirectory(directory: string): Promise<string[]> {
        const cached = this.directoryCache.get(directory);
        if (cached && cached.expiresAt > Date.now()) { return cached.entries; }
        const client = this.client;
        if (!client || this.closed) { return []; }
        return new Promise(resolve => {
            let output = '';
            client.exec(`cd ${shellQuote(directory)} && LC_ALL=C ls -1Ap`, (error, channel) => {
                if (error) { resolve([]); return; }
                channel.on('data', (data: Buffer) => { output += data.toString(); });
                channel.on('close', () => {
                    const entries = output.split(/\r?\n/).filter(Boolean);
                    this.directoryCache.set(directory, { entries, expiresAt: Date.now() + 2000 });
                    resolve(entries);
                });
                channel.stderr.on('data', () => undefined);
            });
        });
    }

    private showGhost(suffix: string): void {
        if (!suffix || this.ghostText) { return; }
        this.ghostText = suffix;
        this.write(`\x1b[90m${suffix}\x1b[0m`);
    }

    private clearGhost(): void {
        if (!this.ghostText) { return; }
        const width = Math.max(1, [...this.ghostText].length);
        this.ghostText = '';
        this.write(`\x1b[${width}D\x1b[0K`);
    }

    private updateDirectoryFromCommand(line: string): void {
        const match = line.trim().match(/^cd\s+(?:--\s+)?(.+)$/);
        if (!match) { return; }
        const target = unquoteShellToken(match[1].trim());
        if (!target || target.startsWith('~') || /[|&;$`]/.test(target)) { return; }
        const previous = this.currentDirectory;
        this.currentDirectory = target.startsWith('/')
            ? path.posix.normalize(target)
            : path.posix.resolve(this.currentDirectory, target);
        if (this.currentDirectory !== previous) {
            this.onDirectoryChange?.(this.currentDirectory);
        }
    }
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function unquoteShellToken(value: string): string | undefined {
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
        return value.slice(1, -1);
    }
    return /^[^\s]+$/.test(value) ? value : undefined;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
