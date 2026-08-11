export interface RouterHostsEntry {
  readonly name: string;
  readonly ip: string;
  readonly ips: readonly string[];
  readonly permanent: boolean;
  readonly ageSeconds: number;
}

interface Entree {
  nom: string;
  ips: string[];
  permanent: boolean;
  poseeA: number;
}

export class RouterHostsTable {
  private readonly byName = new Map<string, Entree>();
  private readonly maintenant: () => number;

  constructor(maintenant: () => number = Date.now) {
    this.maintenant = maintenant;
  }

  upsert(name: string, ip: string | string[], permanent = true): void {
    const ips = Array.isArray(ip) ? [...ip] : [ip];
    this.byName.set(name.toLowerCase(), {
      nom: name, ips, permanent, poseeA: this.maintenant(),
    });
  }

  remove(name: string): boolean {
    return this.byName.delete(name.toLowerCase());
  }

  resolve(name: string): string | null {
    return this.byName.get(name.toLowerCase())?.ips[0] ?? null;
  }

  resolveAll(name: string): readonly string[] {
    return this.byName.get(name.toLowerCase())?.ips ?? [];
  }

  isPermanent(name: string): boolean {
    return this.byName.get(name.toLowerCase())?.permanent ?? false;
  }

  entries(): readonly RouterHostsEntry[] {
    const now = this.maintenant();
    return Array.from(this.byName.values()).map(e => Object.freeze({
      name: e.nom,
      ip: e.ips[0],
      ips: Object.freeze([...e.ips]),
      permanent: e.permanent,
      ageSeconds: Math.max(0, Math.floor((now - e.poseeA) / 1000)),
    }));
  }

  clear(): void {
    this.byName.clear();
  }

  clearLearned(): number {
    let n = 0;
    for (const [cle, e] of [...this.byName]) {
      if (e.permanent) continue;
      this.byName.delete(cle);
      n += 1;
    }
    return n;
  }

  renderCisco(): string[] {
    return this.entries()
      .filter(e => e.permanent)
      .map(e => `ip host ${e.name} ${e.ips.join(' ')}`);
  }

  renderHuawei(): string[] {
    return this.entries()
      .filter(e => e.permanent)
      .map(e => `ip host ${e.name} ${e.ips.join(' ')}`);
  }
}
