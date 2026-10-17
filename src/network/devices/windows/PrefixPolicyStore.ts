import { IPv6Address } from '../../core/types';
import {
  DEFAULT_POLICY_TABLE, policyFromTable, type DestinationPolicy, type PolicyEntry,
} from '../../layers/internet/DestinationSelection';

export type PrefixPolicyStoreName = 'active' | 'persistent';

export type PrefixPolicyOutcome = 'ok' | 'exists' | 'not-found';

const COMPATIBLE_PREFIX = new IPv6Address('::');

const isCompatibleRow = (row: PolicyEntry): boolean => row.length === 96 && row.prefix.equals(COMPATIBLE_PREFIX);

const factoryRows = (): PolicyEntry[] => [
  ...DEFAULT_POLICY_TABLE.filter((row) => !isCompatibleRow(row)),
  ...DEFAULT_POLICY_TABLE.filter(isCompatibleRow),
];

const sameKey = (row: PolicyEntry, other: PolicyEntry): boolean =>
  row.length === other.length && row.prefix.equals(other.prefix);

export const policyPrefixText = (row: PolicyEntry): string => `${row.prefix}/${row.length}`;

export class PrefixPolicyStore {
  private active: readonly PolicyEntry[] = factoryRows();
  private persistent: readonly PolicyEntry[] = factoryRows();
  private cached: { readonly table: readonly PolicyEntry[]; readonly policy: DestinationPolicy } | null = null;

  entries(store: PrefixPolicyStoreName): readonly PolicyEntry[] {
    return store === 'active' ? this.active : this.persistent;
  }

  listed(store: PrefixPolicyStoreName): PolicyEntry[] {
    return [...this.entries(store)].sort((left, right) => right.precedence - left.precedence);
  }

  policy(): DestinationPolicy {
    if (this.cached === null || this.cached.table !== this.active) {
      this.cached = { table: this.active, policy: policyFromTable(this.active) };
    }
    return this.cached.policy;
  }

  add(store: PrefixPolicyStoreName, row: PolicyEntry): PrefixPolicyOutcome {
    const targets = this.targetsOf(store);
    if (targets.some((name) => this.entries(name).some((existing) => sameKey(existing, row)))) return 'exists';
    for (const name of targets) this.replace(name, [...this.entries(name), row]);
    return 'ok';
  }

  set(store: PrefixPolicyStoreName, row: PolicyEntry): PrefixPolicyOutcome {
    let found = false;
    for (const name of this.targetsOf(store)) {
      const table = this.entries(name);
      if (!table.some((existing) => sameKey(existing, row))) continue;
      found = true;
      this.replace(name, table.map((existing) => (sameKey(existing, row) ? row : existing)));
    }
    return found ? 'ok' : 'not-found';
  }

  delete(store: PrefixPolicyStoreName, prefix: IPv6Address, length: number): PrefixPolicyOutcome {
    const key: PolicyEntry = { prefix, length, precedence: 0, label: 0 };
    let found = false;
    for (const name of this.targetsOf(store)) {
      const table = this.entries(name);
      if (!table.some((existing) => sameKey(existing, key))) continue;
      found = true;
      this.replace(name, table.filter((existing) => !sameKey(existing, key)));
    }
    return found ? 'ok' : 'not-found';
  }

  boot(): void {
    this.replace('active', [...this.persistent]);
  }

  private targetsOf(store: PrefixPolicyStoreName): PrefixPolicyStoreName[] {
    return store === 'persistent' ? ['active', 'persistent'] : ['active'];
  }

  private replace(store: PrefixPolicyStoreName, table: readonly PolicyEntry[]): void {
    if (store === 'active') this.active = table;
    else this.persistent = table;
  }
}
