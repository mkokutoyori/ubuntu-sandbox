/**
 * KnownHostsStore — immutable, pure, in-memory representation of known_hosts.
 *
 * Reference: DESIGN-SSH-SFTP.md section 5.
 */

import { SshHostKey } from '../SshHostKey';
import {
  formatKnownHostsEntry,
  parseKnownHostsLine,
} from '../SshPureUtils';

export class KnownHostsStore {
  private constructor(
    private readonly entries: ReadonlyMap<string, SshHostKey>,
  ) {}

  static readonly empty: KnownHostsStore = new KnownHostsStore(new Map());

  get(host: string): SshHostKey | undefined {
    return this.entries.get(host);
  }

  has(host: string): boolean {
    return this.entries.has(host);
  }

  /** Returns a new instance with the host added/replaced. Pure. */
  with(host: string, key: SshHostKey): KnownHostsStore {
    const next = new Map(this.entries);
    next.set(host, key);
    return new KnownHostsStore(next);
  }

  without(host: string): KnownHostsStore {
    if (!this.entries.has(host)) return this;
    const next = new Map(this.entries);
    next.delete(host);
    return new KnownHostsStore(next);
  }

  static parse(content: string): KnownHostsStore {
    const map = new Map<string, SshHostKey>();
    for (const line of content.split('\n')) {
      const parsed = parseKnownHostsLine(line);
      if (parsed) map.set(parsed.host, parsed.key);
    }
    return new KnownHostsStore(map);
  }

  serialize(): string {
    return [...this.entries.entries()]
      .map(([host, key]) => formatKnownHostsEntry(host, key))
      .join('\n');
  }
}
