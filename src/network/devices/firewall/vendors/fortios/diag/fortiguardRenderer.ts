export interface FortiguardDatabase {
  readonly name: string;
  readonly version: string;
  readonly contract: string;
  readonly lastUpdate: string;
  readonly lastAttempt?: string | null;
}

export function renderAutoupdateVersions(
  databases: readonly FortiguardDatabase[],
): string {
  const lines: string[] = [];
  for (const database of databases) {
    lines.push(`${database.name}`);
    lines.push(`---------`);
    lines.push(`Version: ${database.version}`);
    lines.push(`Contract Expiry Date: n/a`);
    lines.push(`Last Updated using manual update on ${database.lastUpdate}`);
    lines.push(`Last Update Attempt: ${database.lastAttempt ?? 'n/a'}`);
    lines.push(`Result: ${database.contract}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
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
