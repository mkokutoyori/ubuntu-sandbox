/**
 * RouterSshKnownHosts — vendor-neutral known-hosts store for outbound
 * SSH sessions opened FROM a Cisco/Huawei device. Mirrors what a real
 * router's `ip ssh known-hosts` / `display ssh server session` table
 * captures: one entry per (host, key-type), populated after the first
 * successful outbound TOFU handshake.
 */

export interface RouterSshKnownHostEntry {
  readonly host: string;
  readonly keyType: string;
  readonly publicKey: string;
  readonly addedAt: number;
}

export class RouterSshKnownHosts {
  private readonly entries: RouterSshKnownHostEntry[] = [];

  add(entry: { host: string; keyType: string; publicKey: string }): void {
    if (this.entries.some(e => e.host === entry.host && e.keyType === entry.keyType)) return;
    this.entries.push(Object.freeze({ ...entry, addedAt: Date.now() }));
  }

  list(): readonly RouterSshKnownHostEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries.length = 0;
  }

  /** Cisco `show ip ssh known-hosts` output (Address  Key fingerprint). */
  renderCisco(): string {
    if (this.entries.length === 0) {
      return 'Address          Key fingerprint                                   Type';
    }
    const header = 'Address          Key fingerprint                                   Type';
    const rows = this.entries.map(e =>
      `${e.host.padEnd(17)}${e.publicKey.slice(0, 50).padEnd(51)}${e.keyType}`,
    );
    return [header, ...rows].join('\n');
  }
}
