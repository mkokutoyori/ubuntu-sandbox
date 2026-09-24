export interface SessionHelperEntry {
  readonly id: number;
  readonly name: string;
  readonly protocol: number;
  readonly port: number;
}

export class SessionHelperTable {
  private readonly entries = new Map<number, SessionHelperEntry>();

  constructor(defaults: readonly SessionHelperEntry[] = []) {
    for (const entry of defaults) this.upsert(entry);
  }

  upsert(entry: SessionHelperEntry): void {
    this.entries.set(entry.id, entry);
  }

  remove(id: number): boolean {
    return this.entries.delete(id);
  }

  list(): readonly SessionHelperEntry[] {
    return Object.freeze([...this.entries.values()]);
  }

  helperFor(protocol: number, port: number): string | undefined {
    for (const entry of this.entries.values()) {
      if (entry.protocol === protocol && entry.port === port) return entry.name;
    }
    return undefined;
  }
}
