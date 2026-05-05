/**
 * SshUserContext — immutable representation of the authenticated user.
 *
 * Carries the data needed to enforce POSIX permissions on the server side.
 * Pure: no I/O, no mutation.
 *
 * Reference: DESIGN-SSH-SFTP.md section 3.
 */

export class SshUserContext {
  constructor(
    public readonly username: string,
    public readonly uid: number,
    public readonly gid: number,
    public readonly groups: readonly number[],
    public readonly homeDirectory: string,
  ) {}

  isRoot(): boolean {
    return this.uid === 0;
  }

  canRead(mode: number, fileUid: number, fileGid: number): boolean {
    if (this.isRoot()) return true;
    if (this.uid === fileUid) return (mode & 0o400) !== 0;
    if (this.belongsToGroup(fileGid)) return (mode & 0o040) !== 0;
    return (mode & 0o004) !== 0;
  }

  canWrite(mode: number, fileUid: number, fileGid: number): boolean {
    if (this.isRoot()) return true;
    if (this.uid === fileUid) return (mode & 0o200) !== 0;
    if (this.belongsToGroup(fileGid)) return (mode & 0o020) !== 0;
    return (mode & 0o002) !== 0;
  }

  canExecute(mode: number, fileUid: number, fileGid: number): boolean {
    if (this.isRoot()) return true;
    if (this.uid === fileUid) return (mode & 0o100) !== 0;
    if (this.belongsToGroup(fileGid)) return (mode & 0o010) !== 0;
    return (mode & 0o001) !== 0;
  }

  private belongsToGroup(gid: number): boolean {
    return this.gid === gid || this.groups.includes(gid);
  }
}
