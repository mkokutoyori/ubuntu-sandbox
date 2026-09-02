export interface AdFunctionalLevel {
  readonly rank: number;
  readonly keyword: string;
  readonly domainMode: string;
  readonly forestMode: string;
}

export const AD_FUNCTIONAL_LEVELS: readonly AdFunctionalLevel[] = [
  { rank: 2, keyword: 'Win2003',      domainMode: 'Windows2003Domain',   forestMode: 'Windows2003Forest' },
  { rank: 3, keyword: 'Win2008',      domainMode: 'Windows2008Domain',   forestMode: 'Windows2008Forest' },
  { rank: 4, keyword: 'Win2008R2',    domainMode: 'Windows2008R2Domain', forestMode: 'Windows2008R2Forest' },
  { rank: 5, keyword: 'Win2012',      domainMode: 'Windows2012Domain',   forestMode: 'Windows2012Forest' },
  { rank: 6, keyword: 'Win2012R2',    domainMode: 'Windows2012R2Domain', forestMode: 'Windows2012R2Forest' },
  { rank: 7, keyword: 'WinThreshold', domainMode: 'Windows2016Domain',   forestMode: 'Windows2016Forest' },
];

export const DEFAULT_AD_FUNCTIONAL_LEVEL =
  AD_FUNCTIONAL_LEVELS[AD_FUNCTIONAL_LEVELS.length - 1];

export function parseAdFunctionalLevel(raw: string): AdFunctionalLevel | null {
  const token = raw.trim();
  if (token === '' || token.toLowerCase() === 'default') return DEFAULT_AD_FUNCTIONAL_LEVEL;
  if (/^\d+$/.test(token)) {
    return AD_FUNCTIONAL_LEVELS.find(l => l.rank === parseInt(token, 10)) ?? null;
  }
  const lower = token.toLowerCase();
  return AD_FUNCTIONAL_LEVELS.find(l => l.keyword.toLowerCase() === lower) ?? null;
}

export function adFunctionalLevelKeywords(): string {
  return AD_FUNCTIONAL_LEVELS.map(l => l.keyword).join(', ');
}

export const MAX_NETBIOS_NAME_LENGTH = 15;

export function netbiosNameProblem(name: string): string | null {
  if (name.length === 0) return 'The NetBIOS name cannot be empty.';
  if (name.length > MAX_NETBIOS_NAME_LENGTH) {
    return `The NetBIOS domain name "${name}" is not valid. A NetBIOS domain name must be a single label of ${MAX_NETBIOS_NAME_LENGTH} characters or less.`;
  }
  if (name.includes('.')) {
    return `The NetBIOS domain name "${name}" is not valid. A NetBIOS domain name must be a single label of ${MAX_NETBIOS_NAME_LENGTH} characters or less.`;
  }
  return null;
}

export interface AddsForestOptions {
  installDns?: boolean;
  domainMode?: AdFunctionalLevel;
  forestMode?: AdFunctionalLevel;
  databasePath?: string;
  logPath?: string;
  sysvolPath?: string;
  whatIf?: boolean;
}
