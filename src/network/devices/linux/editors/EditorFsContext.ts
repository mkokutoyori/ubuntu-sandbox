/**
 * Filesystem/shell seam used by the headless editor engines (NanoEngine,
 * VimEngine). Mirrors the LinuxCommand/LinuxCommandContext separation
 * already used by src/network/devices/linux/commands/: engines never touch
 * LinuxMachine/VirtualFileSystem directly, so they can be unit-tested with
 * a plain in-memory fake and wired to the real VFS in production via a
 * thin adapter.
 */
export interface EditorFsContext {
  /** Resolve a (possibly relative) path against the current working directory. */
  resolvePath(path: string): string;
  /** Read a file's content, or null if it doesn't exist. */
  readFile(path: string): string | null;
  /** Write a file's content, creating it if necessary. Returns success. */
  writeFile(path: string, content: string): boolean;
  /** Whether a file exists at this (already-resolved) path. */
  exists(path: string): boolean;
  /** Delete a file. Returns whether a file was actually removed. */
  deleteFile(path: string): boolean;
  /**
   * Run a shell command synchronously and return its stdout. Used by
   * vim's `:!cmd`, `:r !cmd` and `:%!cmd` filter pipelines.
   */
  runShellCommand(cmd: string): string;
}
