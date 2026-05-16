/**
 * KnownHostsStore — immutable, pure, in-memory representation of known_hosts.
 *
 * Reference: DESIGN-SSH-SFTP.md section 5.
 */

import { SshHostKey } from '../SshHostKey';
import {
  formatKnownHostsEntry,
  hashKnownHostsToken,
  isHashedKnownHostsToken,
  matchHashedHost,
  parseKnownHostsLine,
} from '../SshPureUtils';

export class KnownHostsStore {
  private constructor(
    private readonly entries: ReadonlyMap<string, SshHostKey>,
  ) {}

  static readonly empty: KnownHostsStore = new KnownHostsStore(new Map());

  get(host: string): SshHostKey | undefined {
    const direct = this.entries.get(host);
    if (direct) return direct;
    for (const [token, key] of this.entries) {
      if (isHashedKnownHostsToken(token) && matchHashedHost(token, host)) {
        return key;
      }
    }
    return undefined;
  }

  has(host: string): boolean {
    return this.get(host) !== undefined;
  }

  /**
   * Returns a new instance with the host added/replaced. Pure.
   *
   * When `hashed` is true, the host token is stored in the OpenSSH
   * `|1|<salt>|<hash>` shape, mirroring `ssh-keyscan -H` / `HashKnownHosts yes`.
   */
  with(host: string, key: SshHostKey, opts: { hashed?: boolean } = {}): KnownHostsStore {
    const token = opts.hashed ? hashKnownHostsToken(host) : host;
    const next = new Map(this.entries);
    // Drop any pre-existing entry referring to the same host (plain or hashed).
    for (const existing of next.keys()) {
      if (existing === host) next.delete(existing);
      else if (isHashedKnownHostsToken(existing) && matchHashedHost(existing, host)) {
        next.delete(existing);
      }
    }
    next.set(token, key);
    return new KnownHostsStore(next);
  }

  without(host: string): KnownHostsStore {
    const next = new Map(this.entries);
    let changed = false;
    for (const existing of [...next.keys()]) {
      if (existing === host) {
        next.delete(existing);
        changed = true;
      } else if (isHashedKnownHostsToken(existing) && matchHashedHost(existing, host)) {
        next.delete(existing);
        changed = true;
      }
    }
    return changed ? new KnownHostsStore(next) : this;
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
