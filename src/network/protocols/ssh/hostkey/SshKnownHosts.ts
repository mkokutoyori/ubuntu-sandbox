/**
 * SshKnownHosts — I/O boundary that persists a KnownHostsStore in the VFS.
 *
 * Reference: DESIGN-SSH-SFTP.md section 5.
 */

import type { ISshLocalFs } from '../ISshLocalFs';
import type { SshHostKey } from '../SshHostKey';
import { hashKnownHostsToken, formatKnownHostsEntry } from '../SshPureUtils';
import { appendKnownHostsLine, withoutHost } from './KnownHostsText';
import { KnownHostsStore } from './KnownHostsStore';

const DEFAULT_MODE = 0o644;

export class SshKnownHosts {
  constructor(
    private readonly vfs: ISshLocalFs,
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
    const token = opts.hashed ? hashKnownHostsToken(host) : host;
    const kept = withoutHost(this.vfs.readFile(this.path) ?? '', host);
    this.vfs.writeFile(
      this.path,
      appendKnownHostsLine(kept, formatKnownHostsEntry(token, key)),
      this.uid,
      this.gid,
      this.umask,
    );
    this.vfs.chmod(this.path, DEFAULT_MODE);
  }
}
