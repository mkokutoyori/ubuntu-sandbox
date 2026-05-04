/**
 * ISftpFileSystem — minimal virtual-filesystem contract for SFTP sessions.
 *
 * Abstracts away Linux vs Windows filesystem differences so that
 * SftpSession can work with both VirtualFileSystem (Linux) and
 * WindowsFileSystem (Windows) through their respective adapters.
 *
 * Path convention:
 *   - Linux adapters use POSIX paths  (/home/user/file.txt)
 *   - Windows adapters use POSIX-over-drive paths  (/C:/Users/User/file.txt)
 *     mirroring the behaviour of OpenSSH Server for Windows.
 */

export interface ISftpFileSystem {
  /** Resolve a (possibly relative) path against cwd into an absolute path. */
  normalizePath(path: string, cwd: string): string;

  /** Return 'file', 'directory', or null if the path does not exist. */
  getEntryType(path: string): 'file' | 'directory' | null;

  /** List directory contents, or null if path does not exist / is not a dir. */
  listDirectory(path: string): Array<{ name: string }> | null;

  readFile(path: string): string | null;

  writeFile(path: string, content: string): void;

  exists(path: string): boolean;

  /** Create all intermediate directories (no-op if already exists). */
  mkdirp(path: string): void;

  /** Delete a regular file. Returns false if missing or is a directory. */
  deleteFile(path: string): boolean;

  /** Remove an empty directory. Returns false if not empty or missing. */
  rmdir(path: string): boolean;

  /** Move / rename. Returns false on failure. */
  rename(src: string, dst: string): boolean;
}

/**
 * ISftpUserAuth — password authentication and home-directory resolution.
 * Abstracted from Linux/Windows differences.
 */
export interface ISftpUserAuth {
  checkPassword(username: string, password: string): boolean;
  /** Home directory in the format the adapter uses (POSIX or POSIX-over-drive). */
  getHomeDirectory(username: string): string;
}
