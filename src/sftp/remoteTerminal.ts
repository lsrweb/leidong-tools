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

/** Interactive shells use a dedicated SSH client and never block SFTP transfers. */
export function registerRemoteTerminal(context: vscode.ExtensionContext, configs: SftpConfigStore): void {
    const provider: vscode.TerminalProfileProvider = {
        provideTerminalProfile: async (token) => {
            const profile = await pickTerminalProfile(configs, token);
            return profile ? createTerminalProfile(profile) : undefined;
        },
    };

    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider(terminalProfileId, provider),
        vscode.commands.registerCommand('leidong-tools.remoteTerminal.open', async () => {
            const profile = await pickTerminalProfile(configs);
            if (!profile) { return; }
            const terminal = vscode.window.createTerminal(createTerminalProfile(profile).options);
            terminal.show();
        }),
    );
}

function createTerminalProfile(profile: SftpProfile): vscode.TerminalProfile {
    return new vscode.TerminalProfile({
        name: `远程终端: ${profile.name}`,
        iconPath: new vscode.ThemeIcon('terminal'),
        pty: new RemoteSshTerminal(profile),
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
    private readonly directoryCache = new Map<string, { entries: string[]; expiresAt: number }>();
    private closed = false;

    readonly onDidWrite = this.writeEmitter.event;
    readonly onDidClose = this.closeEmitter.event;
    readonly onDidChangeName = this.nameEmitter.event;

    constructor(private readonly profile: SftpProfile) {
        this.currentDirectory = profile.remotePath;
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
        this.trackInput(data);
        this.sendInput(data);
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
        const lastToken = line.slice(Math.max(line.lastIndexOf(' '), line.lastIndexOf('\t')) + 1);
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
        this.currentDirectory = target.startsWith('/')
            ? path.posix.normalize(target)
            : path.posix.resolve(this.currentDirectory, target);
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
