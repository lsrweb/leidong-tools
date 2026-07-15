/**
 * VS Code Extension Main Entry Point
 * Unitools - 雷动三千开发工具集
 */
import * as vscode from 'vscode';

// Import modular components
import { registerCommands } from './core/commands';
import { registerProviders } from './core/providers';
import { registerIndexLifecycle } from './managers/indexManager';
import { initVueDiagnostics } from './providers/vueDiagnosticsProvider';
import { activate as activateCustomEndpoint, deactivate as deactivateCustomEndpoint } from './copilotByok/runtime';

/**
 * Extension activation function
 */
export async function activate(context: vscode.ExtensionContext) {
    console.log('🚀 Extension "unitools" is now active!');

    // Register all commands and get fileWatchManager
    const fileWatchManager = registerCommands(context);

    // Register all language providers with fileWatchManager
    registerProviders(context, fileWatchManager);

    // Register index lifecycle manager (build on open/visible, clear on close)
    registerIndexLifecycle(context);

    // Register Vue diagnostics (unused variables, template expression checks)
    initVueDiagnostics(context);

    // Registers the BYOK provider shown in Copilot Chat's model picker.
    await activateCustomEndpoint(context);


    console.log('✅ All commands and providers registered successfully!');
}

/**
 * Extension deactivation function
 */
export async function deactivate() {
    await deactivateCustomEndpoint();
    console.log('👋 Extension "unitools" deactivated');
}
