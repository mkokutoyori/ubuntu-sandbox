import type { EditorFsContext } from './EditorFsContext';

/**
 * Minimal in-memory EditorFsContext for unit tests. Not used in
 * production (see src/terminal/sessions/LinuxEditorFsContext.ts for the
 * real VirtualFileSystem-backed adapter).
 */
export class InMemoryEditorFsContext implements EditorFsContext {
  private files = new Map<string, string>();
  private shellLog: string[] = [];
  private shellHandler: (cmd: string) => string;

  constructor(
    initial: Record<string, string> = {},
    shellHandler: (cmd: string) => string = () => '',
  ) {
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, content);
    }
    this.shellHandler = shellHandler;
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

  /** Test helper: inspect every path currently present in the fake FS. */
  listPaths(): string[] {
    return [...this.files.keys()];
  }

  /** Test helper: shell commands issued via `:!`/`:r !`/`:%!`. */
  get shellCommandsRun(): readonly string[] {
    return this.shellLog;
  }
}
