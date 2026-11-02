import type { Zone } from '@/network/dns/zone/Zone';
import { normalizeDnsName } from '@/network/dns/wire/DnsName';

export interface ZoneScopeView {
  readonly name: string;
  readonly fileName: string;
}

export const ZONE_SCOPE_REFUSALS = {
  missing: 'The scope does not exist.',
  absent: 'The scope does not exist for the zone.',
  exists: 'The scope already exists for the zone.',
  isDefault: 'The scope is the same as the default zone scope.',
  invalidName: 'The scope name contains invalid characters.',
  referenced: 'The zone scope cannot be deleted because it is referenced by a DNS Policy.',
} as const;

interface StoredZoneScope extends ZoneScopeView {
  readonly records: Zone;
}

const NO_SCOPES: ReadonlyMap<string, StoredZoneScope> = new Map();

export function zoneScopeFileName(name: string): string {
  return `${name}.dns`;
}

export function zoneScopeFilePath(zone: string, name: string): string {
  return `${zone}\\${zoneScopeFileName(name)}`;
}

export class DnsZoneScopes {
  private readonly scopesByZone = new Map<string, Map<string, StoredZoneScope>>();
  private readonly scopeNames = new WeakMap<Zone, string>();

  isDefault(zone: string, name: string): boolean {
    return normalizeDnsName(name) === normalizeDnsName(zone);
  }

  list(zone: string): ZoneScopeView[] {
    return [...this.peek(zone).values()].map(({ name, fileName }) => ({ name, fileName }));
  }

  find(zone: string, name: string): ZoneScopeView | null {
    const found = this.peek(zone).get(normalizeDnsName(name));
    return found === undefined ? null : { name: found.name, fileName: found.fileName };
  }

  recordsOf(zone: string, name: string): Zone | null {
    return this.peek(zone).get(normalizeDnsName(name))?.records ?? null;
  }

  recordsOfAll(zone: string): Zone[] {
    return [...this.peek(zone).values()].map(scope => scope.records);
  }

  nameOf(records: Zone): string | null {
    return this.scopeNames.get(records) ?? null;
  }

  create(zone: string, name: string, build: () => Zone | string): string | null {
    if (this.isDefault(zone, name)) return ZONE_SCOPE_REFUSALS.isDefault;
    const scopes = this.scopesOf(zone);
    if (scopes.has(normalizeDnsName(name))) return ZONE_SCOPE_REFUSALS.exists;
    const records = build();
    if (typeof records === 'string') return records;
    scopes.set(normalizeDnsName(name), { name, fileName: zoneScopeFileName(name), records });
    this.scopeNames.set(records, name);
    return null;
  }

  remove(zone: string, name: string, isReferenced: (name: string) => boolean): string | null {
    if (this.isDefault(zone, name)) return ZONE_SCOPE_REFUSALS.isDefault;
    const scope = this.peek(zone).get(normalizeDnsName(name));
    if (scope === undefined) return ZONE_SCOPE_REFUSALS.missing;
    if (isReferenced(scope.name)) return ZONE_SCOPE_REFUSALS.referenced;
    this.scopesOf(zone).delete(normalizeDnsName(name));
    return null;
  }

  dropZone(zone: string): void {
    this.scopesByZone.delete(normalizeDnsName(zone));
  }

  private peek(zone: string): ReadonlyMap<string, StoredZoneScope> {
    return this.scopesByZone.get(normalizeDnsName(zone)) ?? NO_SCOPES;
  }

  private scopesOf(zone: string): Map<string, StoredZoneScope> {
    const key = normalizeDnsName(zone);
    let scopes = this.scopesByZone.get(key);
    if (scopes === undefined) {
      scopes = new Map();
      this.scopesByZone.set(key, scopes);
    }
    return scopes;
  }
}
