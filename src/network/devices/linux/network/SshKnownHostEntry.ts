/**
 * SshKnownHostEntry — a real entry in ~/.ssh/known_hosts.
 *
 * Each line of known_hosts is a (hostnames, marker?, key-type, base64-
 * key, comment?) tuple. We model it as a rich class so the simulator
 * can:
 *   - record host-key changes for the "REMOTE HOST IDENTIFICATION HAS
 *     CHANGED!" detection,
 *   - reason about cert-authority and revoked markers (@cert-authority,
 *     @revoked) even though we don't enforce them today,
 *   - serialize/deserialize a known_hosts file deterministically.
 *
 * Attributes mirror what real OpenSSH exposes via `ssh-keygen -F` /
 * `ssh-keyscan` / `ssh -G`, even when the simulator does not yet
 * consume every field — future features (HashKnownHosts, certificate
 * trust, host-key rotation alerts) can rely on them.
 */

export type SshHostKeyType =
  | 'ssh-rsa'
  | 'ssh-dss'
  | 'ssh-ed25519'
  | 'ecdsa-sha2-nistp256'
  | 'ecdsa-sha2-nistp384'
  | 'ecdsa-sha2-nistp521';

export type KnownHostMarker = '@cert-authority' | '@revoked' | null;

export interface SshKnownHostInit {
  hostnames: string[];
  keyType: SshHostKeyType;
  /** Base64 of the public key material (without the algorithm prefix). */
  publicKey: string;
  marker?: KnownHostMarker;
  comment?: string;
  hashed?: boolean;
}

export class SshKnownHostEntry {
  hostnames: string[];
  keyType: SshHostKeyType;
  publicKey: string;
  marker: KnownHostMarker;
  comment: string;
  hashed: boolean;
  /** UTC timestamp the entry was first observed (used by `last seen`). */
  firstSeen: Date = new Date();
  /** Timestamp of the most recent successful match. */
  lastSeen: Date = new Date();

  constructor(init: SshKnownHostInit) {
    this.hostnames = [...init.hostnames];
    this.keyType = init.keyType;
    this.publicKey = init.publicKey;
    this.marker = init.marker ?? null;
    this.comment = init.comment ?? '';
    this.hashed = init.hashed ?? false;
  }

  /** True when this entry applies to the given hostname/IP. */
  matches(hostOrIp: string): boolean {
    return this.hostnames.some(h => h.toLowerCase() === hostOrIp.toLowerCase());
  }

  /** Serialize back to a line of known_hosts. */
  toLine(): string {
    const parts: string[] = [];
    if (this.marker) parts.push(this.marker);
    parts.push(this.hostnames.join(','));
    parts.push(this.keyType);
    parts.push(this.publicKey);
    if (this.comment) parts.push(this.comment);
    return parts.join(' ');
  }

  /** Parse a single line; null on malformed input or comment. */
  static parse(line: string): SshKnownHostEntry | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;
    const tokens = trimmed.split(/\s+/);
    let i = 0;
    let marker: KnownHostMarker = null;
    if (tokens[0] === '@cert-authority' || tokens[0] === '@revoked') {
      marker = tokens[0] as KnownHostMarker;
      i++;
    }
    if (tokens.length - i < 3) return null;
    const hostnames = tokens[i++].split(',');
    const keyType = tokens[i++] as SshHostKeyType;
    const publicKey = tokens[i++];
    const comment = tokens.slice(i).join(' ');
    return new SshKnownHostEntry({
      hostnames, keyType, publicKey, marker, comment,
      hashed: hostnames[0].startsWith('|1|'),
    });
  }

  /** Serialise an entire collection back to file contents. */
  static serializeFile(entries: SshKnownHostEntry[]): string {
    if (entries.length === 0) return '';
    return entries.map(e => e.toLine()).join('\n') + '\n';
  }

  /** Parse an entire file. Bad lines are dropped silently. */
  static parseFile(content: string): SshKnownHostEntry[] {
    return content.split('\n')
      .map(l => SshKnownHostEntry.parse(l))
      .filter((e): e is SshKnownHostEntry => e !== null);
  }
}
