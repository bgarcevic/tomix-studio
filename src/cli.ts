import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Error thrown when a `tx` invocation fails or returns non-parseable output.
 */
export class CliError extends Error {
    constructor(
        message: string,
        public readonly exitCode: number | undefined,
        public readonly stderr: string,
        public readonly stdout: string
    ) {
        super(message);
        this.name = 'CliError';
    }
}

/**
 * Table summary row as emitted by `tx ls --output-format json` at the model root.
 */
export interface TableSummary {
    name: string;
    description?: string;
    isHidden?: boolean;
    dataCategory?: string;
    lineageTag?: string;
    columns: number;
    measures: number;
    hierarchies: number;
    partitions: number;
    refreshPolicy?: unknown;
    defaultDetailRowsExpression?: unknown;
}

/**
 * Column row from `tx ls <table> --output-format json`.
 */
export interface ColumnDoc {
    name: string;
    description?: string;
    sourceColumn?: string;
    dataType?: string;
    isHidden?: boolean;
    formatString?: string;
    displayFolder?: string;
    sortByColumn?: string | null;
    summarizeBy?: string;
    lineageTag?: string;
}

/**
 * Measure row from `tx ls <table> --type measure --output-format json`.
 */
export interface MeasureDoc {
    name: string;
    description?: string;
    expression?: string | null;
    formatString?: string;
    isHidden?: boolean;
    displayFolder?: string;
    dataType?: string;
    detailRowsExpression?: string | null;
    formatStringExpression?: string | null;
    kpi?: unknown;
    lineageTag?: string;
}

/**
 * Partition row from `tx ls <table> --type partition --output-format json`.
 */
export interface PartitionDoc {
    name: string;
    mode?: string;
    dataType?: string;
    source?: string | null;
    description?: string;
}

/**
 * Hierarchy row from `tx ls <table> --type hierarchy --output-format json`.
 */
export interface HierarchyDoc {
    name: string;
    description?: string;
    isHidden?: boolean;
    displayFolder?: string;
    lineageTag?: string;
}

/**
 * Typed row (relationship / culture) from `tx ls --type <T> --output-format json`.
 */
export interface TypedDoc {
    type: string;
    path: string;
    name: string;
    description?: string;
    isHidden?: boolean;
    detail?: string | null;
    expression?: string | null;
}

/**
 * Connection state as emitted by `tx connect --output-format json`.
 */
export interface ConnectionInfo {
    active: boolean;
    connection: {
        database?: string;
        model?: string;
        local?: boolean;
        workspace?: string;
        workspaceAuth?: string;
    };
}

/**
 * Resolves the `tx` executable path. Honors `tomix-studio.cliPath` setting,
 * otherwise relies on PATH lookup (Windows: `tx.cmd`).
 *
 * On Windows, dotnet tool shims are `.cmd` batch files. Spawning those requires
 * `shell: true` which mangles arguments containing spaces. To avoid that, we
 * pierce the `.cmd` wrapper to find the underlying `.exe` so we can spawn it
 * directly with proper argument quoting.
 */
export class CliResolver {
    private cached: string | undefined;
    private cachedKey: string | undefined;

    resolve(): string {
        const configPath = vscode.workspace.getConfiguration('tomix-studio').get<string>('cliPath') || '';
        const key = configPath || '<path>';

        if (this.cachedKey === key && this.cached) {
            return this.cached;
        }

        const shimPath = configPath ? this.resolveExplicit(configPath) : this.resolveFromPath();
        const resolved = this.resolveExecutable(shimPath);
        this.cached = resolved;
        this.cachedKey = key;
        return resolved;
    }

    /**
     * Given a `.cmd`/`.bat` shim or a direct executable path, returns the
     * underlying `.exe` when possible so we can spawn without a shell.
     */
    private resolveExecutable(shimPath: string): string {
        if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(shimPath)) {
            return shimPath;
        }

        const exePath = this.extractExeFromCmd(shimPath);
        return exePath && fs.existsSync(exePath) ? exePath : shimPath;
    }

    /**
     * Reads a `.cmd`/`.bat` shim and extracts the `.exe` path it wraps.
     * Handles the common dotnet/Spectre shim pattern: `"%~dp0<path>.exe" %*`.
     */
    private extractExeFromCmd(cmdPath: string): string | undefined {
        let content: string;
        try {
            content = fs.readFileSync(cmdPath, 'utf8');
        } catch {
            return undefined;
        }

        const cmdDir = path.dirname(cmdPath);
        const lines = content.split(/\r?\n/);

        for (const line of lines) {
            const match = line.match(/"([^"]*\.exe)"/i);
            if (!match) {
                continue;
            }

            const rawPath = match[1];
            const expanded = rawPath.replace(/%~dp0/gi, cmdDir + path.sep).replace(/%~/gi, cmdDir);
            const normalized = path.normalize(expanded);
            if (/\.exe$/i.test(normalized)) {
                return normalized;
            }
        }

        return undefined;
    }

    private resolveExplicit(candidate: string): string {
        if (!fs.existsSync(candidate)) {
            throw new CliError(
                `tx CLI not found at configured path: ${candidate}`,
                undefined,
                '',
                ''
            );
        }
        return candidate;
    }

    private resolveFromPath(): string {
        const name = process.platform === 'win32' ? 'tx.cmd' : 'tx';
        const paths = (process.env.PATH || '').split(path.delimiter);
        for (const dir of paths) {
            if (!dir) {
                continue;
            }
            const candidate = path.join(dir, name);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        throw new CliError(
            `tx CLI not found on PATH. Install it (e.g. \`dotnet tool install -g tomix\`) or set "tomix-studio.cliPath".`,
            undefined,
            '',
            ''
        );
    }
}

/**
 * Spawns the `tx` CLI with `--output-format json` and parses stdout.
 * Uses the active `tx connect` session — no `--model` flag is passed.
 */
export class TomixCliClient {
    constructor(
        private readonly resolver: CliResolver,
        private readonly logger: vscode.OutputChannel
    ) {}

    /**
     * `tx connect <target>` — sets the active CLI session.
     * Returns the resulting connection info (includes the resolved local model path).
     */
    async connect(target: string): Promise<ConnectionInfo> {
        return this.runJson<ConnectionInfo>(['connect', target]);
    }

    /**
     * `tx connect` (no args) — returns the current active connection, if any.
     */
    async getConnection(): Promise<ConnectionInfo> {
        return this.runJson<ConnectionInfo>(['connect']);
    }

    /**
     * `tx connect --clear` — clears the active CLI session.
     */
    async clearConnection(): Promise<void> {
        await this.runJson<ConnectionInfo>(['connect', '--clear']);
    }

    /**
     * `tx ls --output-format json` → table summaries.
     */
    async listRoot(): Promise<TableSummary[]> {
        return this.runJson<TableSummary[]>(['ls']);
    }

    /**
     * `tx ls <table> [--type T] --output-format json`.
     * When `type` is omitted, `tx` returns columns by default.
     */
    async listTableChildren<T = unknown>(
        table: string,
        type?: 'column' | 'measure' | 'partition' | 'hierarchy'
    ): Promise<T[]> {
        const args = ['ls', table];
        if (type) {
            args.push('--type', type);
        }
        return this.runJson<T[]>(args);
    }

    /**
     * `tx ls --type <T> --output-format json` for top-level typed sections.
     */
    async listByType(type: 'relationship' | 'culture'): Promise<TypedDoc[]> {
        return this.runJson<TypedDoc[]>(['ls', '--type', type]);
    }

    private async runJson<T>(args: string[]): Promise<T> {
        const fullArgs = [
            ...args,
            '--output-format', 'json',
            '--error-format', 'json',
            '--non-interactive',
            '--quiet'
        ];

        const exe = this.resolver.resolve();
        const stdout = await this.spawn(exe, fullArgs);

        try {
            return JSON.parse(stdout) as T;
        } catch (error) {
            throw new CliError(
                `Failed to parse tx output as JSON (${error instanceof Error ? error.message : String(error)}).`,
                undefined,
                '',
                stdout
            );
        }
    }

    private spawn(exe: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            // CliResolver normally pierces .cmd shims to the underlying .exe so we
            // can spawn directly (shell:false) with proper arg-array quoting.
            // The shell fallback is kept for the rare case where .exe resolution fails.
            const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
            const child = useShell
                ? cp.spawn(`${quote(exe)} ${args.map(quote).join(' ')}`, { windowsHide: true, shell: true })
                : cp.spawn(exe, args, { windowsHide: true });

            let stdout = '';
            let stderr = '';

            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');

            child.stdout.on('data', (chunk: string) => {
                stdout += chunk;
            });
            child.stderr.on('data', (chunk: string) => {
                stderr += chunk;
            });

            child.on('error', (error: NodeJS.ErrnoException) => {
                reject(new CliError(
                    `Failed to launch tx CLI: ${error.message}`,
                    undefined,
                    stderr,
                    stdout
                ));
            });

            child.on('close', (code: number | null) => {
                if (code === 0) {
                    this.logger.appendLine(`$ tx ${args.join(' ')}`);
                    resolve(stdout);
                    return;
                }

                const message = this.extractErrorMessage(stderr) || stderr.trim() || `tx exited with code ${String(code)}.`;
                this.logger.appendLine(`$ tx ${args.join(' ')}`);
                this.logger.appendLine(`  exit=${String(code)}`);
                if (stderr.trim()) {
                    this.logger.appendLine(`  stderr: ${stderr.trim()}`);
                }
                reject(new CliError(message, code ?? undefined, stderr, stdout));
            });
        });
    }

    private extractErrorMessage(stderr: string): string | undefined {
        const trimmed = stderr.trim();
        if (!trimmed) {
            return undefined;
        }

        try {
            const parsed = JSON.parse(trimmed) as { message?: string; error?: string } | Array<{ message?: string }>;
            if (Array.isArray(parsed)) {
                return parsed.map(entry => entry.message).filter(Boolean).join('\n') || undefined;
            }
            return parsed.message || parsed.error || undefined;
        } catch {
            return undefined;
        }
    }
}

/**
 * Quotes a single shell argument for Windows cmd.exe. Wraps in double quotes
 * whenever the value contains whitespace or characters that cmd treats specially.
 */
function quote(value: string): string {
    if (value === '') {
        return '""';
    }
    if (!/[\s"&|<>^()%!]/.test(value)) {
        return value;
    }
    return `"${value.replace(/"/g, '""')}"`;
}
