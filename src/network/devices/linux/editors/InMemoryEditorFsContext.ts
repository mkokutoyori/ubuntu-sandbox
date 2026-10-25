import type { ChildShellRun, EditorFsContext, EditorIdentity, EditorPathKind } from './EditorFsContext';

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

const DEVICE_PATHS: ReadonlySet<string> = new Set(['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/tty']);

export class InMemoryEditorFsContext implements EditorFsContext {
  private files = new Map<string, string>();
  private modes = new Map<string, number>();
  private strictDirectories = false;
  private shellLog: string[] = [];
  private shellHandler: (cmd: string) => string;
  private filterHandler?: (cmd: string, input: string) => string;
  private childShell?: (cmd: string, stdin: string | undefined, workingDirectory: string | undefined) => ChildShellRun;

  constructor(
    initial: Record<string, string> = {},
    shellHandler: (cmd: string) => string = () => '',
    filterHandler?: (cmd: string, input: string) => string,
    private readonly workingDirectory = '/tmp',
  ) {
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, content);
    }
    this.shellHandler = shellHandler;
    this.filterHandler = filterHandler;
  }

  fileNames(): string[] {
    return [...this.files.keys()];
  }

  identity(): EditorIdentity {
    return { user: 'root', host: 'vm', pid: 4321 };
  }

  resolvePath(path: string): string {
    return this.normalize(path.startsWith('/') ? path : `${this.workingDirectory}/${path}`);
  }

  readFile(path: string): string | null {
    const p = this.resolvePath(path);
    return this.files.has(p) ? this.files.get(p)! : null;
  }

  writeFile(path: string, content: string): boolean {
    const target = this.resolvePath(path);
    if (this.strictDirectories && this.kindOf(target.slice(0, target.lastIndexOf('/')) || '/') !== 'directory') return false;
    this.files.set(target, content);
    return true;
  }

  refuseWritesIntoMissingDirectories(): void {
    this.strictDirectories = true;
  }

  exists(path: string): boolean {
    return this.files.has(this.resolvePath(path));
  }

  kindOf(path: string): EditorPathKind {
    const resolved = this.resolvePath(path);
    if (this.files.has(resolved)) return 'file';
    if (DEVICE_PATHS.has(resolved)) return 'device';
    if (resolved === '/' || resolved === '/tmp' || resolved === this.workingDirectory || this.workingDirectory.startsWith(`${resolved}/`)) return 'directory';
    const prefix = `${resolved}/`;
    return [...this.files.keys()].some((name) => name.startsWith(prefix)) ? 'directory' : 'missing';
  }

  listDirectory(path: string): string[] | null {
    const resolved = this.resolvePath(path);
    if (this.kindOf(resolved) !== 'directory') return null;
    const prefix = resolved === '/' ? '/' : `${resolved}/`;
    const names = new Set<string>();
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split('/')[0]);
    }
    return [...names];
  }

  setMode(path: string, mode: number): void {
    this.modes.set(this.resolvePath(path), mode);
  }

  isReadOnly(path: string): boolean {
    const mode = this.modes.get(this.resolvePath(path));
    return mode !== undefined && (mode & 0o222) === 0;
  }

  private normalize(path: string): string {
    const parts: string[] = [];
    for (const part of path.split('/')) {
      if (part === '..') parts.pop();
      else if (part !== '' && part !== '.') parts.push(part);
    }
    return `/${parts.join('/')}`;
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

  runChildShell(cmd: string, stdin?: string, workingDirectory?: string): ChildShellRun {
    if (this.childShell) return this.childShell(cmd, stdin, workingDirectory);
    return { output: stdin === undefined ? this.runShellCommand(cmd) : this.filterThroughShell(cmd, stdin), status: 0 };
  }

  useChildShell(handler: (cmd: string, stdin: string | undefined, workingDirectory: string | undefined) => ChildShellRun): void {
    this.childShell = handler;
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
