import { fmtHumanDate } from '../../linux/LinuxLogManager';

export type FortiGuardFamily = 'antivirus' | 'ips' | 'geo-ip';

export interface FortiGuardDatabase {
  readonly name: string;
  readonly family: FortiGuardFamily | 'application';
  readonly version: string;
  readonly contract: string;
  readonly lastUpdate: string;
  readonly lastAttempt: string | null;
}

const SEED: readonly Omit<FortiGuardDatabase, 'lastAttempt'>[] = Object.freeze([
  { name: 'AV Engine', family: 'antivirus', version: '0.00000',
    contract: 'Contract Expired', lastUpdate: 'Wed Jan  1 00:00:00 2020' },
  { name: 'Virus Definitions', family: 'antivirus', version: '1.00000',
    contract: 'Contract Expired', lastUpdate: 'Wed Jan  1 00:00:00 2020' },
  { name: 'IPS Attack Engine', family: 'ips', version: '0.00000',
    contract: 'Contract Expired', lastUpdate: 'Wed Jan  1 00:00:00 2020' },
  { name: 'IPS Attack Definitions', family: 'ips', version: '1.00000',
    contract: 'Contract Expired', lastUpdate: 'Wed Jan  1 00:00:00 2020' },
  { name: 'Application Definitions', family: 'application', version: '1.00000',
    contract: 'Contract Expired', lastUpdate: 'Wed Jan  1 00:00:00 2020' },
  { name: 'IP Geography DB', family: 'geo-ip', version: '1.00000',
    contract: 'Contract Expired', lastUpdate: 'Wed Jan  1 00:00:00 2020' },
]);

export interface FortiGuardDeps {
  readonly now?: () => number;
}

export class FortiGuardDatabases {
  private readonly databases: FortiGuardDatabase[];
  private readonly now: () => number;

  constructor(deps: FortiGuardDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.databases = SEED.map(seed => ({ ...seed, lastAttempt: null }));
  }

  list(): readonly FortiGuardDatabase[] { return this.databases; }

  recordAttempt(family?: FortiGuardFamily): number {
    const stamp = fmtHumanDate(new Date(this.now()));
    let touched = 0;
    this.databases.forEach((database, index) => {
      if (family !== undefined && database.family !== family) return;
      this.databases[index] = { ...database, lastAttempt: stamp };
      touched++;
    });
    return touched;
  }
}
