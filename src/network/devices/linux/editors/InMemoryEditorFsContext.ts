import type { EditorFsContext } from './EditorFsContext';

/**
 * Minimal in-memory EditorFsContext for unit tests. Not used in
 * production (see src/terminal/sessions/LinuxEditorFsContext.ts for the
 * real VirtualFileSystem-backed adapter).
 */
/** Minimal built-in filters so unit tests exercise `:%!cmd` without a custom handler. */
function builtinFilter(cmd: string, input: string): string | null {
  const trimmed = cmd.trim();
  // Real `sort`/`uniq`/`tac` operate on newline-terminated records — the
  // trailing newline is a separator, not an empty final record.
  const body = input.endsWith('\n') ? input.slice(0, -1) : input;
  const lines = body.split('\n');
  if (trimmed === 'sort') return [...lines].sort().join('\n') + '\n';
  if (trimmed === 'sort -r') return [...lines].sort().reverse().join('\n') + '\n';
  if (trimmed === 'uniq') return lines.filter((l, i) => i === 0 || l !== lines[i - 1]).join('\n') + '\n';
  if (trimmed === 'tac') return [...lines].reverse().join('\n') + '\n';
  return null;
}

export class InMemoryEditorFsContext implements EditorFsContext {
  private files = new Map<string, string>();
  private shellLog: string[] = [];
  private shellHandler: (cmd: string) => string;
  private filterHandler?: (cmd: string, input: string) => string;

  constructor(
    initial: Record<string, string> = {},
    shellHandler: (cmd: string) => string = () => '',
    filterHandler?: (cmd: string, input: string) => string,
  ) {
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, content);
    }
    this.shellHandler = shellHandler;
    this.filterHandler = filterHandler;
  }

  resolvePath(path: string): string {
    if (path.startsWith('/')) return path;
    return `/tmp/${path}`;
  }

  readFile(path: string): string | null {
    const p = this.resolvePath(path);
    return this.files.has(p) ? this.files.get(p)! : null;
  }

  writeFile(path: string, content: string): boolean {
    this.files.set(this.resolvePath(path), content);
    return true;
  }

  exists(path: string): boolean {
    return this.files.has(this.resolvePath(path));
  }

  deleteFile(path: string): boolean {
    return this.files.delete(this.resolvePath(path));
  }

  runShellCommand(cmd: string): string {
    this.shellLog.push(cmd);
    return this.shellHandler(cmd);
  }

  filterThroughShell(cmd: string, input: string): string {
    this.shellLog.push(`${cmd} (filter)`);
    if (this.filterHandler) return this.filterHandler(cmd, input);
    return builtinFilter(cmd, input) ?? input;
  }

  /** Test helper: inspect every path currently present in the fake FS. */
  listPaths(): string[] {
    return [...this.files.keys()];
  }

  /** Test helper: shell commands issued via `:!`/`:r !`/`:%!`. */
  get shellCommandsRun(): readonly string[] {
    return this.shellLog;
  }
}
