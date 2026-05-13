/**
 * SshKnownHosts — I/O boundary that persists a KnownHostsStore in the VFS.
 *
 * Reference: DESIGN-SSH-SFTP.md section 5.
 */

import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type { SshHostKey } from '../SshHostKey';
import { KnownHostsStore } from './KnownHostsStore';

const DEFAULT_MODE = 0o644;

export class SshKnownHosts {
  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly path: string,
    private readonly uid: number,
    private readonly gid: number,
    private readonly umask: number = 0o022,
  ) {}

  load(): KnownHostsStore {
    const content = this.vfs.readFile(this.path);
    if (content === null) return KnownHostsStore.empty;
    return KnownHostsStore.parse(content);
  }

  save(store: KnownHostsStore): void {
    this.vfs.writeFile(
      this.path,
      store.serialize() + '\n',
      this.uid,
      this.gid,
      this.umask,
    );
    this.vfs.chmod(this.path, DEFAULT_MODE);
  }

  addHost(host: string, key: SshHostKey, opts: { hashed?: boolean } = {}): void {
    const store = this.load().with(host, key, opts);
    this.save(store);
  }
}
