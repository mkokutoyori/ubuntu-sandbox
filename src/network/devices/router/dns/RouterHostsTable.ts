/**
 * RouterHostsTable — vendor-neutral static-hostname registry.
 *
 * Cisco IOS `ip host pc1 10.0.0.1` and Huawei VRP `ip host pc1
 * 10.0.0.1` both register a name → IP mapping that local CLI verbs
 * (ping, traceroute, ssh, stelnet) consult before falling back to
 * DNS. This model class is the single store consulted by both shells.
 *
 * Entries are name-keyed (case-insensitive) and aliases for the same
 * IP are allowed — looking up by name returns the first declared IP.
 */

export interface RouterHostsEntry {
  readonly name: string;
  readonly ip: string;
}

export class RouterHostsTable {
  private readonly byName = new Map<string, string>();

  upsert(name: string, ip: string): void {
    this.byName.set(name.toLowerCase(), ip);
  }

  remove(name: string): boolean {
    return this.byName.delete(name.toLowerCase());
  }

  resolve(name: string): string | null {
    return this.byName.get(name.toLowerCase()) ?? null;
  }

  entries(): readonly RouterHostsEntry[] {
    return Array.from(this.byName.entries()).map(([name, ip]) =>
      Object.freeze({ name, ip }),
    );
  }

  clear(): void {
    this.byName.clear();
  }

  /** Cisco show running-config block — one `ip host <name> <ip>` per entry. */
  renderCisco(): string[] {
    return this.entries().map(e => `ip host ${e.name} ${e.ip}`);
  }

  /** Huawei display current-configuration block — same shape on VRP. */
  renderHuawei(): string[] {
    return this.entries().map(e => `ip host ${e.name} ${e.ip}`);
  }
}
