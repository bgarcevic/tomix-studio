import * as fs from 'fs';
import * as path from 'path';

import type { TreeNode } from './explorer';

export interface ObjectLocation {
    filePath: string;
    lineNumber?: number;
}

const TABLE_DIR_NAMES = ['tables'];

/**
 * Resolves the TMDL definition folder for a model.
 * Returns the `definition/` subfolder if present, otherwise the model path itself.
 */
export function resolveDefinitionFolder(modelPath: string): string {
    const definitionPath = path.join(modelPath, 'definition');
    try {
        if (fs.statSync(definitionPath).isDirectory()) {
            return definitionPath;
        }
    } catch {
        // Not a directory or doesn't exist; fall through.
    }
    return modelPath;
}

/**
 * Resolves the source file and declaration line for an explorer tree node.
 *
 * The `tx` JSON does not include `file` / `lineNumber`, so this module infers them
 * from TMDL sharding conventions and a header scan of the candidate file.
 *
 * Returns `{ filePath }` with no line when the declaration can't be located.
 */
export function resolveObjectLocation(modelPath: string, node: TreeNode): ObjectLocation | undefined {
    const definitionFolder = resolveDefinitionFolder(modelPath);

    if (node.type === 'table') {
        return resolveByName(definitionFolder, 'table', node.data.name, [
            ...candidateTableFiles(definitionFolder, node.data.name)
        ]);
    }

    if (
        node.type === 'column' ||
        node.type === 'measure' ||
        node.type === 'partition' ||
        node.type === 'hierarchy'
    ) {
        const childKind = node.type;
        const candidates = [
            ...candidateTableFiles(definitionFolder, node.parentTable),
            ...candidateShardedChildFiles(definitionFolder, node.parentTable, childKind, node.data.name)
        ];
        return resolveByName(definitionFolder, childKind, node.data.name, candidates);
    }

    if (node.type === 'relationship') {
        const relationshipsFile = path.join(definitionFolder, 'relationships.tmdl');
        const guid = extractRelationshipGuid(node.data.path);
        if (guid) {
            const line = findDeclarationLine(relationshipsFile, 'relationship', guid, { matchExact: true });
            return line !== undefined
                ? { filePath: relationshipsFile, lineNumber: line }
                : { filePath: relationshipsFile };
        }
        return { filePath: relationshipsFile };
    }

    if (node.type === 'culture') {
        const cultureName = extractCultureName(node.data.path) ?? node.data.name;
        const file = path.join(definitionFolder, 'cultures', `${cultureName}.tmdl`);
        return fs.existsSync(file) ? { filePath: file, lineNumber: 1 } : { filePath: file };
    }

    return undefined;
}

/**
 * Resolves the source file and declaration line for a search result described
 * by its `tx find` object type (e.g. "Measure", "Column") and object path
 * (e.g. "Table/Child"). Decouples navigation from the tree-node shape so that
 * search hits — which are not tree nodes — can still be opened.
 */
export function resolveLocationByPath(
    modelPath: string,
    objectType: string,
    objectPath: string
): ObjectLocation | undefined {
    const definitionFolder = resolveDefinitionFolder(modelPath);
    const kind = objectType.trim().toLowerCase();
    const segments = objectPath.split('/');

    if (kind === 'table') {
        const tableName = segments[0];
        return resolveByName(definitionFolder, 'table', tableName, candidateTableFiles(definitionFolder, tableName));
    }

    if (kind === 'column' || kind === 'measure' || kind === 'partition' || kind === 'hierarchy') {
        const tableName = segments[0];
        const childName = segments.slice(1).join('/') || segments[0];
        const candidates = [
            ...candidateTableFiles(definitionFolder, tableName),
            ...candidateShardedChildFiles(definitionFolder, tableName, kind, childName)
        ];
        return resolveByName(definitionFolder, kind, childName, candidates);
    }

    if (kind === 'relationship') {
        const relationshipsFile = path.join(definitionFolder, 'relationships.tmdl');
        const guid = segments.length > 1 ? segments[segments.length - 1] : undefined;
        if (guid) {
            const line = findDeclarationLine(relationshipsFile, 'relationship', guid, { matchExact: true });
            return line !== undefined
                ? { filePath: relationshipsFile, lineNumber: line }
                : { filePath: relationshipsFile };
        }
        return { filePath: relationshipsFile };
    }

    if (kind === 'culture') {
        const cultureName = segments[segments.length - 1] || objectPath;
        const file = path.join(definitionFolder, 'cultures', `${cultureName}.tmdl`);
        return fs.existsSync(file) ? { filePath: file, lineNumber: 1 } : { filePath: file };
    }

    return undefined;
}

function resolveByName(
    definitionFolder: string,
    kind: 'table' | 'column' | 'measure' | 'partition' | 'hierarchy',
    name: string,
    candidates: string[]
): ObjectLocation | undefined {
    for (const file of candidates) {
        if (!fs.existsSync(file)) {
            continue;
        }
        const line = findDeclarationLine(file, kind, name);
        if (line !== undefined) {
            return { filePath: file, lineNumber: line };
        }
    }

    if (candidates.length > 0) {
        return { filePath: candidates[0] };
    }

    return { filePath: definitionFolder };
}

function candidateTableFiles(definitionFolder: string, tableName: string): string[] {
    const quoted = quoteIfNeeded(tableName);
    const direct = TABLE_DIR_NAMES.map(dir => path.join(definitionFolder, dir, `${quoted}.tmdl`));
    const sharded = TABLE_DIR_NAMES.map(dir => path.join(definitionFolder, dir, quoted, 'table.tmdl'));
    return [...direct, ...sharded];
}

function candidateShardedChildFiles(
    definitionFolder: string,
    tableName: string,
    childKind: 'column' | 'measure' | 'partition' | 'hierarchy',
    childName: string
): string[] {
    const quotedTable = quoteIfNeeded(tableName);
    const quotedChild = quoteIfNeeded(childName);
    const childDir = `${childKind}s`;
    return TABLE_DIR_NAMES.flatMap(dir =>
        path.join(definitionFolder, dir, quotedTable, childDir).length > 0
            ? [path.join(definitionFolder, dir, quotedTable, childDir, `${quotedChild}.tmdl`)]
            : []
    );
}

/**
 * Scans a TMDL file for an object declaration header matching `kind <name>`.
 * Returns the 1-based line number, or undefined.
 *
 * TMDL headers:
 *   table <Name>
 *   table '<Quoted Name>'
 *   column <Name>
 *   measure '<Name>' = <expr>
 *   partition <Name> = <expr>
 *   hierarchy <Name>
 *   relationship <guid>          (matchExact compares the raw token)
 */
function findDeclarationLine(
    filePath: string,
    kind: string,
    name: string,
    options: { matchExact?: boolean } = {}
): number | undefined {
    let content: string;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return undefined;
    }

    const lines = content.split(/\r?\n/);
    const pattern = buildHeaderPattern(kind);
    const target = normalizeName(name);

    for (let i = 0; i < lines.length; i += 1) {
        const match = lines[i].match(pattern);
        if (!match) {
            continue;
        }
        const candidate = options.matchExact ? match[1] : normalizeName(match[1]);
        if (options.matchExact ? match[1] === name : candidate === target) {
            return i + 1;
        }
    }
    return undefined;
}

function buildHeaderPattern(kind: string): RegExp {
    // Leading whitespace permitted (child objects are indented one tab under their table).
    // Name is either single-quoted (with '' escaping) or a bare token up to whitespace/=.
    // Bare matching is intentionally permissive ([^\s=]+) so it handles non-ASCII
    // identifiers (e.g. "Belægning") and hyphenated GUIDs (relationship declarations).
    return new RegExp(`^\\s*${escapeRegex(kind)}\\s+('(?:[^']|'')*'|[^\\s=]+)`);
}

function quoteIfNeeded(name: string): string {
    // File names that need quoting contain spaces or characters that would split a path segment.
    if (/[\s/\\]/.test(name)) {
        return name;
    }
    return name;
}

function extractRelationshipGuid(pathValue: string): string | undefined {
    const segments = pathValue.split('/');
    return segments.length > 1 ? segments[segments.length - 1] : undefined;
}

function extractCultureName(pathValue: string): string | undefined {
    const segments = pathValue.split('/');
    return segments.length > 1 ? segments[segments.length - 1] : undefined;
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeName(value: string): string {
    let result = value.trim();
    if (result.startsWith("'") && result.endsWith("'") && result.length >= 2) {
        result = result.slice(1, -1);
    }
    return result.replace(/''/g, "'").trim().toLowerCase();
}
