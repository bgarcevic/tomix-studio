import * as vscode from 'vscode';

import { CliError, SearchMatch, TomixCliClient } from './cli';
import { OpenableTreeNode, TabularTreeProvider } from './explorer';
import { ObjectLocation, resolveLocationByPath, resolveObjectLocation } from './tmdlLocator';

export const COMMANDS = {
    selectFolder: 'tomix-studio.selectFolder',
    closeModel: 'tomix-studio.closeModel',
    openFileAtLine: 'tomix-studio.openFileAtLine',
    search: 'tomix-studio.search'
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

        await openObjectLocation(location);
    });
}

/**
 * `tomix-studio.search` — prompts for a search term, runs `tx find` over the
 * active model, and presents matches in a QuickPick. Selecting a match opens
 * the TMDL file at the object's declaration.
 */
export function registerSearchCommand(
    cli: TomixCliClient,
    treeProvider: TabularTreeProvider
): vscode.Disposable {
    return vscode.commands.registerCommand(COMMANDS.search, async () => {
        const modelPath = treeProvider.getModelPath();
        if (!modelPath) {
            vscode.window.showWarningMessage('Open a model before searching.');
            return;
        }

        const pattern = await vscode.window.showInputBox({
            title: 'Search Model',
            prompt: 'tx find across the active model',
            placeHolder: 'Search term (names, expressions, descriptions, …)'
        });
        if (!pattern) {
            return;
        }

        let response;
        try {
            response = await cli.find(pattern);
        } catch (error) {
            const message = error instanceof CliError
                ? error.message
                : error instanceof Error
                    ? error.message
                    : String(error);
            vscode.window.showErrorMessage(`Search failed: ${message}`);
            return;
        }

        if (response.matchCount === 0) {
            vscode.window.showInformationMessage(`No matches for "${pattern}".`);
            return;
        }

        const items: SearchQuickPickItem[] = response.matches.map(match => ({
            match,
            label: lastPathSegment(match.objectPath),
            description: parentPath(match.objectPath),
            detail: `${match.property}: "${match.matchedText}"`,
            iconPath: iconForObjectType(match.objectType)
        }));

        const picked = await vscode.window.showQuickPick(items, {
            title: `${response.matchCount} match${response.matchCount === 1 ? '' : 'es'} for "${pattern}"`,
            placeHolder: 'Select a match to open',
            matchOnDescription: true,
            matchOnDetail: true
        });
        if (!picked) {
            return;
        }

        const location = resolveLocationByPath(modelPath, picked.match.objectType, picked.match.objectPath);
        if (!location) {
            vscode.window.showWarningMessage(
                `Could not resolve TMDL location for ${picked.match.objectType} "${picked.match.objectPath}".`
            );
            return;
        }

        await openObjectLocation(location);
        await treeProvider.revealSearchResult(picked.match.objectType, picked.match.objectPath);
    });
}

interface SearchQuickPickItem extends vscode.QuickPickItem {
    match: SearchMatch;
}

async function openObjectLocation(location: ObjectLocation): Promise<void> {
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
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showWarningMessage(`Could not open TMDL file: ${message}`);
    }
}

function lastPathSegment(objectPath: string): string {
    const segments = objectPath.split('/');
    return segments[segments.length - 1] || objectPath;
}

function parentPath(objectPath: string): string {
    const index = objectPath.lastIndexOf('/');
    return index > 0 ? objectPath.slice(0, index) : '';
}

function iconForObjectType(objectType: string): vscode.ThemeIcon {
    switch (objectType.trim().toLowerCase()) {
        case 'table': return new vscode.ThemeIcon('table');
        case 'measure': return new vscode.ThemeIcon('symbol-function');
        case 'column': return new vscode.ThemeIcon('symbol-field');
        case 'partition': return new vscode.ThemeIcon('symbol-array');
        case 'hierarchy': return new vscode.ThemeIcon('symbol-structure');
        case 'relationship': return new vscode.ThemeIcon('link');
        case 'culture': return new vscode.ThemeIcon('file');
        default: return new vscode.ThemeIcon('symbol-misc');
    }
}
