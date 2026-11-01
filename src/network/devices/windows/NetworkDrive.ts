import type { SmbConnection } from './server/smb/SmbClient';
import type { NetUseEntry } from './WinNetUse';
import type { RemoteVolume } from './RemoteVolume';

export class NetworkDrive implements RemoteVolume {
  constructor(
    private readonly entry: NetUseEntry,
    private readonly revive: (entry: NetUseEntry) => SmbConnection | string,
  ) {}

  get remote(): string {
    return this.entry.remote;
  }

  private through<T extends { ok: boolean }>(operate: (connection: SmbConnection) => T): T | { ok: boolean; error: string } {
    const held = this.entry.connection;
    const connection = held !== undefined && held.isConnected() ? held : this.revive(this.entry);
    if (typeof connection === 'string') return { ok: false, error: connection };
    const result = operate(connection);
    if (result.ok || connection.isConnected()) return result;
    const redialled = this.revive(this.entry);
    return typeof redialled === 'string' ? { ok: false, error: redialled } : operate(redialled);
  }

  stat(path: string): ReturnType<RemoteVolume['stat']> { return this.through(connection => connection.stat(path)); }
  list(path: string): ReturnType<RemoteVolume['list']> { return this.through(connection => connection.list(path)); }
  read(path: string): ReturnType<RemoteVolume['read']> { return this.through(connection => connection.read(path)); }
  write(path: string, content: string): ReturnType<RemoteVolume['write']> { return this.through(connection => connection.write(path, content)); }
  mkdir(path: string): ReturnType<RemoteVolume['mkdir']> { return this.through(connection => connection.mkdir(path)); }
  remove(path: string): ReturnType<RemoteVolume['remove']> { return this.through(connection => connection.remove(path)); }
  removeDirectory(path: string): ReturnType<RemoteVolume['removeDirectory']> { return this.through(connection => connection.removeDirectory(path)); }
  rename(path: string, target: string, replace = false): ReturnType<RemoteVolume['rename']> { return this.through(connection => connection.rename(path, target, replace)); }
  setAttributes(path: string, attributes: string[]): ReturnType<RemoteVolume['setAttributes']> { return this.through(connection => connection.setAttributes(path, attributes)); }
  setModified(path: string, modified: number): ReturnType<RemoteVolume['setModified']> { return this.through(connection => connection.setModified(path, modified)); }
  volumeInfo(): ReturnType<RemoteVolume['volumeInfo']> { return this.through(connection => connection.volumeInfo()); }
}
