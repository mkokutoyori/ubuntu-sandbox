export type FortiGuardFamily = 'antivirus' | 'ips' | 'geo-ip';

export interface FortiGuardDatabase {
  readonly name: string;
  readonly family: FortiGuardFamily | 'application';
  readonly statusLabel?: string;
  readonly version: string;
  readonly contract: string;
  readonly lastUpdateMs: number;
  readonly lastAttemptMs: number | null;
}

const NEVER_UPDATED_MS = Date.UTC(2020, 0, 1, 0, 0, 0);

const SEED: readonly Omit<FortiGuardDatabase, 'lastAttemptMs'>[] = Object.freeze([
  { name: 'AV Engine', family: 'antivirus', version: '0.00000',
    contract: 'Contract Expired', lastUpdateMs: NEVER_UPDATED_MS },
  { name: 'Virus Definitions', family: 'antivirus', statusLabel: 'Virus-DB',
    version: '1.00000',
    contract: 'Contract Expired', lastUpdateMs: NEVER_UPDATED_MS },
  { name: 'IPS Attack Engine', family: 'ips', statusLabel: 'IPS-Engine',
    version: '0.00000',
    contract: 'Contract Expired', lastUpdateMs: NEVER_UPDATED_MS },
  { name: 'IPS Attack Definitions', family: 'ips', statusLabel: 'IPS-DB',
    version: '1.00000',
    contract: 'Contract Expired', lastUpdateMs: NEVER_UPDATED_MS },
  { name: 'Application Definitions', family: 'application', statusLabel: 'APP-DB',
    version: '1.00000',
    contract: 'Contract Expired', lastUpdateMs: NEVER_UPDATED_MS },
  { name: 'IP Geography DB', family: 'geo-ip', version: '1.00000',
    contract: 'Contract Expired', lastUpdateMs: NEVER_UPDATED_MS },
]);

export interface FortiGuardDeps {
  readonly now?: () => number;
}

export class FortiGuardDatabases {
  private readonly databases: FortiGuardDatabase[];
  private readonly now: () => number;

  constructor(deps: FortiGuardDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.databases = SEED.map(seed => ({ ...seed, lastAttemptMs: null }));
  }

  list(): readonly FortiGuardDatabase[] { return this.databases; }

  withStatusLabel(label: string): FortiGuardDatabase | undefined {
    return this.databases.find(database => database.statusLabel === label);
  }

  recordAttempt(family?: FortiGuardFamily): number {
    const at = this.now();
    let touched = 0;
    this.databases.forEach((database, index) => {
      if (family !== undefined && database.family !== family) return;
      this.databases[index] = { ...database, lastAttemptMs: at };
      touched++;
    });
    return touched;
  }
}
