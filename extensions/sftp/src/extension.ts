import * as vscode from 'vscode';
import { registerSftpManager } from './sftp/sftpManager';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('🚀 "leidong-sftp" is now active!');
    registerSftpManager(context);
}

export async function deactivate(): Promise<void> {}
