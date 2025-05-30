/**
 * VS Code Extension Main Entry Point
 * Unitools - 雷动三千开发工具集
 */
import * as vscode from 'vscode';

// Import modular components
import { registerCommands } from './core/commands';
import { registerProviders } from './core/providers';

/**
 * Extension activation function
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 Extension "unitools" is now active!');

    // Register all commands
    registerCommands(context);

    // Register all language providers
    registerProviders(context);

    console.log('✅ All commands and providers registered successfully!');
}

/**
 * Extension deactivation function
 */
export function deactivate() {
    console.log('👋 Extension "unitools" deactivated');
}
