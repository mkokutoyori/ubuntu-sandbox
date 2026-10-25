/**
 * Filesystem/shell seam used by the headless editor engines (NanoEngine,
 * VimEngine). Mirrors the LinuxCommand/LinuxCommandContext separation
 * already used by src/network/devices/linux/commands/: engines never touch
 * LinuxMachine/VirtualFileSystem directly, so they can be unit-tested with
 * a plain in-memory fake and wired to the real VFS in production via a
 * thin adapter.
 */
export interface EditorIdentity {
  readonly user: string;
  readonly host: string;
  readonly pid: number;
}

export type EditorPathKind = 'missing' | 'file' | 'directory' | 'device' | 'fifo';

export interface ChildShellRun {
  readonly output: string;
  readonly status: number;
}

export interface EditorFsContext {
  identity?(): EditorIdentity;
  /** Resolve a (possibly relative) path against the current working directory. */
  resolvePath(path: string): string;
  /** Read a file's content, or null if it doesn't exist. */
  readFile(path: string): string | null;
  /** Write a file's content, creating it if necessary. Returns success. */
  writeFile(path: string, content: string): boolean;
  kindOf?(path: string): EditorPathKind;
  isReadOnly?(path: string): boolean;
  canonicalPath?(path: string): string | null;
  listDirectory?(path: string): string[] | null;
  /** Whether a file exists at this (already-resolved) path. */
  exists(path: string): boolean;
  /** Delete a file. Returns whether a file was actually removed. */
  deleteFile(path: string): boolean;
  /**
   * Run a shell command synchronously and return its stdout. Used by
   * vim's `:!cmd` and `:r !cmd`.
   */
  runShellCommand(cmd: string): string;
  /**
   * Run a shell command with `input` piped to its stdin and return its
   * stdout. Used by vim's `:%!cmd` buffer filter (e.g. `:%!sort`).
   */
  filterThroughShell(cmd: string, input: string): string;
  runChildShell?(cmd: string, stdin?: string, workingDirectory?: string): ChildShellRun;
}
