import * as vscode from 'vscode';

import { CliError, TomixCliClient } from './cli';
import { OpenableTreeNode, TabularTreeProvider } from './explorer';
import { resolveObjectLocation } from './tmdlLocator';

export const COMMANDS = {
    selectFolder: 'tomix-studio.selectFolder',
    closeModel: 'tomix-studio.closeModel',
    openFileAtLine: 'tomix-studio.openFileAtLine'
} as const;

/**
 * `tomix-studio.selectFolder` — prompts the user for a TMDL folder or .bim file,
 * runs `tx connect <path>` to set the active CLI session, and activates it in the explorer.
 */
export function registerSelectFolderCommand(
    cli: TomixCliClient,
    treeProvider: TabularTreeProvider
): vscode.Disposable {
    return vscode.commands.registerCommand(COMMANDS.selectFolder, async () => {
        const uri = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: true,
            canSelectMany: false,
            title: 'Select tomix model (TMDL folder, .bim, or .tmdl)',
            openLabel: 'Select Model'
        });

        if (!uri || uri.length === 0) {
            return;
        }

        const pickedPath = uri[0].fsPath;
        try {
            const conn = await cli.connect(pickedPath);
            const modelPath = conn.connection.model || pickedPath;
            treeProvider.setModelPath(modelPath);
            await vscode.commands.executeCommand('setContext', 'tomix-studio.modelOpen', true);
        } catch (error) {
            const message = error instanceof CliError
                ? error.message
                : error instanceof Error
                    ? error.message
                    : String(error);
            vscode.window.showErrorMessage(`Failed to connect: ${message}`);
        }
    });
}

/**
 * `tomix-studio.closeModel` — clears the active CLI session and the explorer.
 */
export function registerCloseModelCommand(
    cli: TomixCliClient,
    treeProvider: TabularTreeProvider
): vscode.Disposable {
    return vscode.commands.registerCommand(COMMANDS.closeModel, async () => {
        try {
            await cli.clearConnection();
        } catch {
            // Session may already be cleared or CLI unavailable — still clear the tree.
        }
        treeProvider.setModelPath(undefined);
        await vscode.commands.executeCommand('setContext', 'tomix-studio.modelOpen', false);
    });
}

/**
 * `tomix-studio.openFileAtLine` — resolves a tree node to its TMDL declaration
 * file and line, then opens the editor at that location.
 */
export function registerOpenFileAtLineCommand(): vscode.Disposable {
    return vscode.commands.registerCommand(COMMANDS.openFileAtLine, async (node: OpenableTreeNode) => {
        const modelPath = node.modelPath;
        if (!modelPath) {
            return;
        }

        const location = resolveObjectLocation(modelPath, node);
        if (!location) {
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(location.filePath);
            const selection = location.lineNumber && location.lineNumber > 0
                ? new vscode.Range(
                    new vscode.Position(location.lineNumber - 1, 0),
                    new vscode.Position(location.lineNumber - 1, 0)
                )
                : undefined;
            await vscode.window.showTextDocument(document, { selection });
        } catch (error) {
            const message = error instanceof CliError
                ? error.message
                : error instanceof Error
                    ? error.message
                    : String(error);
            vscode.window.showWarningMessage(`Could not open TMDL file: ${message}`);
        }
    });
}
