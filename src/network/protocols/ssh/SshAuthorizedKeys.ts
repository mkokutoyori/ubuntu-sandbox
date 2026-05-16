/**
 * SshAuthorizedKeys — read/write helper for ~/.ssh/authorized_keys.
 *
 * Reference: BRD-SSH-SFTP.md SSH-03-R5/R6/R7.
 */

import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import {
  type AuthorizedKey,
  parseAuthorizedKeysLine,
} from './SshPureUtils';

const DEFAULT_MODE = 0o600;
const DEFAULT_UMASK = 0o022;

export class SshAuthorizedKeys {
  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly path: string,
    private readonly uid: number,
    private readonly gid: number,
  ) {}

  /** Parse the file and return all authorized keys. */
  list(): readonly AuthorizedKey[] {
    const content = this.vfs.readFile(this.path);
    if (!content) return [];
    const out: AuthorizedKey[] = [];
    for (const line of content.split('\n')) {
      const parsed = parseAuthorizedKeysLine(line);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /** True if the given public-key material is authorised. */
  contains(publicKeyMaterial: string): boolean {
    return this.list().some((k) => k.material === publicKeyMaterial);
  }

  /** Append a key (no-op if already present). */
  add(key: AuthorizedKey): void {
    if (this.contains(key.material)) return;
    const existing = this.vfs.readFile(this.path) ?? '';
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    const line = `${key.algorithm} ${key.material}${key.comment ? ' ' + key.comment : ''}\n`;
    this.vfs.writeFile(
      this.path,
      existing + sep + line,
      this.uid,
      this.gid,
      DEFAULT_UMASK,
    );
    this.vfs.chmod(this.path, DEFAULT_MODE);
  }

  /** Remove every line whose material matches. Returns the count removed. */
  remove(publicKeyMaterial: string): number {
    const content = this.vfs.readFile(this.path);
    if (!content) return 0;
    const lines = content.split('\n');
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      const parsed = parseAuthorizedKeysLine(line);
      if (parsed && parsed.material === publicKeyMaterial) {
        removed += 1;
        continue;
      }
      kept.push(line);
    }
    if (removed > 0) {
      this.vfs.writeFile(
        this.path,
        kept.join('\n'),
        this.uid,
        this.gid,
        DEFAULT_UMASK,
      );
    }
    return removed;
  }
}
