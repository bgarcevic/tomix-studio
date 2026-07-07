import * as vscode from 'vscode';

import {
    registerCloseModelCommand,
    registerOpenFileAtLineCommand,
    registerSelectFolderCommand
} from './commands';
import { CliResolver, TomixCliClient } from './cli';
import { TabularTreeProvider } from './explorer';

const VIEW_ID = 'tomix-studio.explorer';
const CONTEXT_MODEL_OPEN = 'tomix-studio.modelOpen';

export function activate(context: vscode.ExtensionContext) {
    const logger = vscode.window.createOutputChannel('tomix studio', { log: true });
    context.subscriptions.push(logger);

    const resolver = new CliResolver();
    const cli = new TomixCliClient(resolver, logger);
    const treeProvider = new TabularTreeProvider(cli, logger);

    const treeView = vscode.window.createTreeView(VIEW_ID, {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(treeView);

    context.subscriptions.push(registerSelectFolderCommand(cli, treeProvider));
    context.subscriptions.push(registerCloseModelCommand(cli, treeProvider));
    context.subscriptions.push(registerOpenFileAtLineCommand());

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('tomix-studio.cliPath')) {
                treeProvider.refresh();
            }
        })
    );

    // Restore from the active `tx connect` session (single source of truth).
    cli.getConnection().then(async conn => {
        if (conn.active && conn.connection.model) {
            treeProvider.setModelPath(conn.connection.model);
            await vscode.commands.executeCommand('setContext', CONTEXT_MODEL_OPEN, true);
        }
    }).catch(error => {
        logger.appendLine(`No active tx session to restore: ${error instanceof Error ? error.message : String(error)}`);
    });
}

export function deactivate() {}
