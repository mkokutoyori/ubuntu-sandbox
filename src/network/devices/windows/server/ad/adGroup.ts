export interface GroupPropertySpec {
  readonly parameter: string;
  readonly ldap: string;
}

export const GROUP_PROPERTIES: readonly GroupPropertySpec[] = [
  { parameter: 'Description', ldap: 'description' },
  { parameter: 'DisplayName', ldap: 'displayName' },
  { parameter: 'HomePage',    ldap: 'wWWHomePage' },
  { parameter: 'ManagedBy',   ldap: 'managedBy' },
];

export const GROUP_PROPERTY_PARAMETERS: readonly string[] = GROUP_PROPERTIES.map(p => p.parameter);

export type GroupScopeName = 'DomainLocal' | 'Global' | 'Universal';
export type GroupCategoryName = 'Distribution' | 'Security';

export const GROUP_SCOPES: ReadonlyArray<{ name: GroupScopeName; value: number }> = [
  { name: 'DomainLocal', value: 0 },
  { name: 'Global', value: 1 },
  { name: 'Universal', value: 2 },
];

export const GROUP_CATEGORIES: ReadonlyArray<{ name: GroupCategoryName; value: number }> = [
  { name: 'Distribution', value: 0 },
  { name: 'Security', value: 1 },
];

function matchEnum<T extends string>(
  table: ReadonlyArray<{ name: T; value: number }>, raw: string,
): T | null {
  const token = raw.trim();
  if (token === '') return null;
  if (/^\d+$/.test(token)) {
    return table.find(e => e.value === parseInt(token, 10))?.name ?? null;
  }
  const lower = token.toLowerCase();
  return table.find(e => e.name.toLowerCase() === lower)?.name ?? null;
}

export function parseGroupScope(raw: string): GroupScopeName | null {
  return matchEnum(GROUP_SCOPES, raw);
}

export function parseGroupCategory(raw: string): GroupCategoryName | null {
  return matchEnum(GROUP_CATEGORIES, raw);
}

export function groupScopeNames(): string {
  return GROUP_SCOPES.map(s => s.name).join(',');
}

export function groupCategoryNames(): string {
  return GROUP_CATEGORIES.map(c => c.name).join(',');
}

const GROUP_SCOPE_BIT: Record<GroupScopeName, number> = {
  Global: 0x00000002, DomainLocal: 0x00000004, Universal: 0x00000008,
};
const SCOPE_OF_BIT = new Map<number, GroupScopeName>(
  (Object.keys(GROUP_SCOPE_BIT) as GroupScopeName[]).map(scope => [GROUP_SCOPE_BIT[scope], scope]),
);
const SECURITY_ENABLED_BIT = 0x80000000;

export function groupTypeValue(scope: GroupScopeName, category: GroupCategoryName): number {
  const bit = GROUP_SCOPE_BIT[scope];
  return category === 'Security' ? (bit | SECURITY_ENABLED_BIT) : bit;
}

export function groupTypeParts(groupType: number): { scope: GroupScopeName; category: GroupCategoryName } {
  return {
    category: (groupType & SECURITY_ENABLED_BIT) !== 0 ? 'Security' : 'Distribution',
    scope: SCOPE_OF_BIT.get(groupType & 0x0000000e) ?? 'Global',
  };
}
