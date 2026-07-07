import * as vscode from 'vscode';

import {
    CliError,
    ColumnDoc,
    HierarchyDoc,
    MeasureDoc,
    PartitionDoc,
    TableSummary,
    TomixCliClient,
    TypedDoc
} from './cli';

/**
 * Discriminated union of all nodes that can appear in the explorer tree.
 * Lazy variant: containers carry the minimum context needed for the next `tx` call.
 */
export type TreeNode =
    | { readonly type: 'tables'; readonly modelPath: string }
    | { readonly type: 'relationships'; readonly modelPath: string }
    | { readonly type: 'cultures'; readonly modelPath: string }
    | { readonly type: 'table'; readonly modelPath: string; readonly data: TableSummary }
    | { readonly type: 'columns'; readonly modelPath: string; readonly parentTable: string }
    | { readonly type: 'measures'; readonly modelPath: string; readonly parentTable: string }
    | { readonly type: 'partitions'; readonly modelPath: string; readonly parentTable: string }
    | { readonly type: 'hierarchies'; readonly modelPath: string; readonly parentTable: string }
    | { readonly type: 'column'; readonly modelPath: string; readonly parentTable: string; readonly data: ColumnDoc }
    | { readonly type: 'measure'; readonly modelPath: string; readonly parentTable: string; readonly data: MeasureDoc }
    | { readonly type: 'partition'; readonly modelPath: string; readonly parentTable: string; readonly data: PartitionDoc }
    | { readonly type: 'hierarchy'; readonly modelPath: string; readonly parentTable: string; readonly data: HierarchyDoc }
    | { readonly type: 'relationship'; readonly modelPath: string; readonly data: TypedDoc }
    | { readonly type: 'culture'; readonly modelPath: string; readonly data: TypedDoc }
    | { readonly type: 'loading' }
    | { readonly type: 'error'; readonly message: string };

/**
 * Union of nodes whose click should open a TMDL declaration in the editor.
 * Excludes containers and transient loading/error placeholders.
 */
export type OpenableTreeNode = Extract<
    TreeNode,
    {
        type:
            | 'table'
            | 'column'
            | 'measure'
            | 'partition'
            | 'hierarchy'
            | 'relationship'
            | 'culture';
    }
>;

/**
 * Provides explorer tree data by issuing `tx ls` / `tx ls --type T` calls on demand.
 */
export class TabularTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    /**
     * In-flight child requests keyed by element identity. Allows returning a
     * `loading` placeholder on the first `getChildren` call and refreshing once
     * the CLI responds.
     */
    private readonly pending = new Map<string, Promise<TreeNode[]>>();

    private modelPath: string | undefined;

    constructor(
        private readonly cli: TomixCliClient,
        private readonly logger: vscode.OutputChannel
    ) {}

    setModelPath(modelPath: string | undefined): void {
        this.modelPath = modelPath;
        this.pending.clear();
        this.refresh();
    }

    getModelPath(): string | undefined {
        return this.modelPath;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return createTreeItem(element);
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!this.modelPath) {
            return [];
        }

        if (!element) {
            return this.getRootChildren(this.modelPath);
        }

        return this.getElementChildren(element);
    }

    private getRootChildren(modelPath: string): TreeNode[] {
        return [
            { type: 'tables', modelPath },
            { type: 'relationships', modelPath },
            { type: 'cultures', modelPath }
        ];
    }

    private async getElementChildren(element: TreeNode): Promise<TreeNode[]> {
        switch (element.type) {
            case 'tables':
                return this.fetchTables(element.modelPath);
            case 'table':
                return this.getTableChildGroups(element);
            case 'columns':
                return this.fetchChildren(element.modelPath, element.parentTable, 'column');
            case 'measures':
                return this.fetchChildren(element.modelPath, element.parentTable, 'measure');
            case 'partitions':
                return this.fetchChildren(element.modelPath, element.parentTable, 'partition');
            case 'hierarchies':
                return this.fetchChildren(element.modelPath, element.parentTable, 'hierarchy');
            case 'relationships':
                return this.fetchRelationships(element.modelPath);
            case 'cultures':
                return this.fetchCultures(element.modelPath);
            default:
                return [];
        }
    }

    private async fetchTables(modelPath: string): Promise<TreeNode[]> {
        try {
            const tables = await this.cli.listRoot();
            return tables
                .sort(compareByName)
                .map(table => ({ type: 'table' as const, modelPath, data: table }));
        } catch (error) {
            return [errorNode('Failed to list tables', error)];
        }
    }

    private getTableChildGroups(table: { type: 'table'; modelPath: string; data: TableSummary }): TreeNode[] {
        const groups: TreeNode[] = [];
        const summary = table.data;
        const modelPath = table.modelPath;
        const parentTable = summary.name;

        if (summary.columns > 0) {
            groups.push({ type: 'columns', modelPath, parentTable });
        }
        if (summary.measures > 0) {
            groups.push({ type: 'measures', modelPath, parentTable });
        }
        if (summary.partitions > 0) {
            groups.push({ type: 'partitions', modelPath, parentTable });
        }
        if (summary.hierarchies > 0) {
            groups.push({ type: 'hierarchies', modelPath, parentTable });
        }

        return groups.length > 0
            ? groups
            : [
                {
                    type: 'error',
                    message: 'No child groups reported by tx for this table.'
                }
            ];
    }

    private async fetchChildren(
        modelPath: string,
        parentTable: string,
        kind: 'column' | 'measure' | 'partition' | 'hierarchy'
    ): Promise<TreeNode[]> {
        try {
            switch (kind) {
                case 'column': {
                    const docs = await this.cli.listTableChildren<ColumnDoc>(parentTable, 'column');
                    return docs.sort(compareByName).map(data => ({ type: 'column' as const, modelPath, parentTable, data }));
                }
                case 'measure': {
                    const docs = await this.cli.listTableChildren<MeasureDoc>(parentTable, 'measure');
                    return docs.sort(compareByName).map(data => ({ type: 'measure' as const, modelPath, parentTable, data }));
                }
                case 'partition': {
                    const docs = await this.cli.listTableChildren<PartitionDoc>(parentTable, 'partition');
                    return docs.sort(compareByName).map(data => ({ type: 'partition' as const, modelPath, parentTable, data }));
                }
                case 'hierarchy': {
                    const docs = await this.cli.listTableChildren<HierarchyDoc>(parentTable, 'hierarchy');
                    return docs.sort(compareByName).map(data => ({ type: 'hierarchy' as const, modelPath, parentTable, data }));
                }
            }
        } catch (error) {
            return [errorNode(`Failed to list ${kind}s`, error)];
        }
    }

    private async fetchRelationships(modelPath: string): Promise<TreeNode[]> {
        try {
            const docs = await this.cli.listByType('relationship');
            return docs.sort(compareByName).map(data => ({ type: 'relationship' as const, modelPath, data }));
        } catch (error) {
            return [errorNode('Failed to list relationships', error)];
        }
    }

    private async fetchCultures(modelPath: string): Promise<TreeNode[]> {
        try {
            const docs = await this.cli.listByType('culture');
            return docs.sort(compareByName).map(data => ({ type: 'culture' as const, modelPath, data }));
        } catch (error) {
            return [errorNode('Failed to list cultures', error)];
        }
    }
}

/**
 * Builds the VS Code TreeItem for a node: label, icon, collapsibility, tooltip, click command.
 */
export function createTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.type) {
        case 'loading':
            return new vscode.TreeItem('Loading…', vscode.TreeItemCollapsibleState.None);
        case 'error': {
            const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
            item.tooltip = node.message;
            item.iconPath = new vscode.ThemeIcon('error');
            item.contextValue = 'error';
            return item;
        }
        case 'tables':
            return container('Tables', 'folder');
        case 'relationships':
            return container('Relationships', 'folder');
        case 'cultures':
            return container('Cultures', 'folder');
        case 'columns':
            return container('Columns', 'folder');
        case 'measures':
            return container('Measures', 'folder');
        case 'partitions':
            return container('Partitions', 'folder');
        case 'hierarchies':
            return container('Hierarchies', 'folder');
        case 'table': {
            const data = node.data;
            const label = data.isHidden ? `${data.name} (hidden)` : data.name;
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
            item.iconPath = new vscode.ThemeIcon('table');
            item.tooltip = buildTableTooltip(data);
            item.contextValue = 'table';
            item.command = openCommand(node);
            return item;
        }
        case 'column': {
            const data = node.data;
            const label = data.isHidden ? `${data.name} (hidden)` : data.name;
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('symbol-field');
            item.tooltip = `${data.name} (${data.dataType || 'Unknown'})${data.formatString ? ` [${data.formatString}]` : ''}`;
            item.contextValue = 'column';
            item.command = openCommand(node);
            return item;
        }
        case 'measure': {
            const data = node.data;
            const label = data.isHidden ? `${data.name} (hidden)` : data.name;
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('symbol-function');
            item.tooltip = `${data.name}${data.formatString ? ` [${data.formatString}]` : ''}`;
            item.contextValue = 'measure';
            item.command = openCommand(node);
            return item;
        }
        case 'partition': {
            const data = node.data;
            const item = new vscode.TreeItem(data.name, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('symbol-array');
            item.tooltip = `${data.name} (${data.mode || 'Unknown'})`;
            item.contextValue = 'partition';
            item.command = openCommand(node);
            return item;
        }
        case 'hierarchy': {
            const data = node.data;
            const label = data.isHidden ? `${data.name} (hidden)` : data.name;
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('symbol-structure');
            item.tooltip = data.name;
            item.contextValue = 'hierarchy';
            item.command = openCommand(node);
            return item;
        }
        case 'relationship': {
            const data = node.data;
            const label = data.detail || data.name;
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('link');
            item.tooltip = data.detail || data.name;
            item.contextValue = 'relationship';
            item.command = openCommand(node);
            return item;
        }
        case 'culture': {
            const data = node.data;
            const item = new vscode.TreeItem(data.name, vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('file');
            item.tooltip = data.name;
            item.contextValue = 'culture';
            item.command = openCommand(node);
            return item;
        }
    }
}

function container(label: string, icon: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = new vscode.ThemeIcon(icon);
    item.contextValue = 'container';
    return item;
}

function buildTableTooltip(data: TableSummary): string {
    const parts = [
        `${data.name}`,
        `${String(data.columns)} columns`,
        `${String(data.measures)} measures`,
        `${String(data.hierarchies)} hierarchies`,
        `${String(data.partitions)} partitions`
    ];
    if (data.isHidden) {
        parts.push('hidden');
    }
    return parts.join(' · ');
}

function openCommand(node: TreeNode): vscode.Command | undefined {
    // Only attach a click command to leaf-ish nodes that have a backing TMDL declaration.
    switch (node.type) {
        case 'table':
        case 'column':
        case 'measure':
        case 'partition':
        case 'hierarchy':
        case 'relationship':
        case 'culture':
            return {
                command: 'tomix-studio.openFileAtLine',
                title: 'Open in TMDL',
                arguments: [node as OpenableTreeNode]
            };
        default:
            return undefined;
    }
}

function errorNode(prefix: string, error: unknown): TreeNode {
    const message = error instanceof CliError
        ? `${prefix}: ${error.message}`
        : error instanceof Error
            ? `${prefix}: ${error.message}`
            : `${prefix}: ${String(error)}`;
    return { type: 'error', message };
}

function compareByName<T extends { name: string }>(left: T, right: T): number {
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
}
