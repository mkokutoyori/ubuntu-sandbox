export const DEFAULT_REUSE_PASSWORD_LIMIT = 0;
export const MIN_REUSE_PASSWORD_LIMIT = 0;
export const MAX_REUSE_PASSWORD_LIMIT = 20;

export const DEFAULT_PASSWORD_HISTORY_THRESHOLD = 3;
export const MIN_PASSWORD_HISTORY_THRESHOLD = 3;
export const MAX_PASSWORD_HISTORY_THRESHOLD = 15;

interface KeptSecret {
  secret: string;
  reuses: number;
}

export class PasswordHistory {
  private readonly used = new Map<string, KeptSecret[]>();
  private readonly changed = new Map<string, number>();

  remember(name: string, secret: string, at?: number): void {
    if (secret.length === 0) return;
    if (at !== undefined) this.changed.set(name, at);
    const kept = this.used.get(name) ?? [];
    if (kept[0]?.secret === secret) return;
    const seen = kept.findIndex(entry => entry.secret === secret);
    const entry = seen === -1 ? { secret, reuses: 0 } : kept[seen];
    if (seen !== -1) { entry.reuses++; kept.splice(seen, 1); }
    kept.unshift(entry);
    this.used.set(name, kept.slice(0, MAX_PASSWORD_HISTORY_THRESHOLD));
  }

  previous(name: string): string | undefined {
    return this.used.get(name)?.[0]?.secret;
  }

  wasUsed(name: string, secret: string, threshold: number, reuses: number): boolean {
    const kept = (this.used.get(name) ?? []).slice(0, threshold);
    const seen = kept.find(entry => entry.secret === secret);
    return seen !== undefined && seen.reuses >= reuses;
  }

  changedAt(name: string): number | undefined { return this.changed.get(name); }

  forget(name: string): void {
    this.used.delete(name);
    this.changed.delete(name);
  }

  clear(): void {
    this.used.clear();
    this.changed.clear();
  }
}

export function charactersAbsentFrom(previous: string, next: string): number {
  const known = new Set(previous);
  const fresh = new Set<string>();
  for (const character of next) if (!known.has(character)) fresh.add(character);
  return fresh.size;
}
