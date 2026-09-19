export interface FortiguardDatabase {
  readonly name: string;
  readonly statusLabel?: string;
  readonly version: string;
  readonly contract: string;
  readonly lastUpdateMs: number;
  readonly lastAttemptMs?: number | null;
}

export type InstantText = (at: number) => string;

export function renderAutoupdateVersions(
  databases: readonly FortiguardDatabase[], ctime: InstantText,
): string {
  const lines: string[] = [];
  for (const database of databases) {
    lines.push(`${database.name}`);
    lines.push(`---------`);
    lines.push(`Version: ${database.version}`);
    lines.push(`Contract Expiry Date: n/a`);
    lines.push(`Last Updated using manual update on ${ctime(database.lastUpdateMs)}`);
    lines.push(`Last Update Attempt: ${database.lastAttemptMs === null
      || database.lastAttemptMs === undefined ? 'n/a' : ctime(database.lastAttemptMs)}`);
    lines.push(`Result: ${database.contract}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export const FORTIGUARD_STATUS_ORDER: readonly string[] = Object.freeze([
  'Virus-DB', 'IPS-DB', 'APP-DB', 'IPS-Engine',
]);

export function renderFortiguardStatusLines(
  databases: readonly FortiguardDatabase[], minute: InstantText,
): string[] {
  return FORTIGUARD_STATUS_ORDER.flatMap((label) => {
    const database = databases.find(d => d.statusLabel === label);
    return database === undefined
      ? [] : [`${label}: ${database.version}(${minute(database.lastUpdateMs)})`];
  });
}

export function renderFortiguardServiceStatus(): string {
  return [
    'FortiGuard Distribution Network: not reachable in this simulator',
    'Web Filtering: Unavailable (no subscription)',
    'AntiSpam: Unavailable (no subscription)',
    'AntiVirus: Unavailable (no subscription)',
    'IPS: Unavailable (no subscription)',
    'Application Control: Unavailable (no subscription)',
  ].join('\n');
}
