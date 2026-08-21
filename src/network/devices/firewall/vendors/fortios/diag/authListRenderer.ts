import type { AuthenticatedIdentity, IdentityTable } from '../../../identity/IdentityTable';

export interface AuthListFilter {
  readonly user?: string;
  readonly group?: string;
  readonly policyId?: string;
}

export function identityMatchesFilter(
  identity: AuthenticatedIdentity, filter: AuthListFilter,
): boolean {
  if (filter.user !== undefined && identity.user !== filter.user) return false;
  if (filter.group !== undefined && !identity.groups.includes(filter.group)) return false;
  if (filter.policyId !== undefined && identity.policyId !== filter.policyId) return false;
  return true;
}

export function renderAuthList(
  table: IdentityTable, filter: AuthListFilter = {},
): string {
  const all = table.list();
  const listed = all.filter(identity => identityMatchesFilter(identity, filter));
  const filtered = all.length - listed.length;

  const lines: string[] = [];
  for (const identity of listed) lines.push(...renderIdentity(table, identity));
  lines.push(`----- ${listed.length} listed, ${filtered} filtered ------`);
  return lines.join('\n');
}

function renderIdentity(
  table: IdentityTable, identity: AuthenticatedIdentity,
): string[] {
  const out: string[] = [
    `${identity.address}, ${identity.user}`,
    `\ttype: fw, id: ${identity.policyId ?? 0}, `
    + `duration: ${table.durationOf(identity)}, idled: ${table.idleOf(identity)}`,
  ];

  const policy = table.timeoutPolicy();
  out.push(`\texpire: ${table.expiryOf(identity)}, allow-idle: ${policy.seconds}`);

  if (identity.source !== 'local' && identity.server !== undefined) {
    out.push(`\tserver: ${identity.server}`);
  }

  out.push(`\tpackets: in ${identity.packetsIn} out ${identity.packetsOut}, `
    + `bytes: in ${identity.bytesIn} out ${identity.bytesOut}`);

  identity.groupIds.forEach((groupId, index) => {
    out.push(`\tgroup_id: ${groupId}`);
    out.push(`\tgroup_name: ${identity.groups[index]}`);
  });

  return out;
}

export function parseAuthFilter(words: readonly string[]): AuthListFilter {
  const filter: { user?: string; group?: string; policyId?: string } = {};
  for (let index = 0; index < words.length - 1; index += 2) {
    const key = words[index];
    const value = words[index + 1];
    if (key === 'user') filter.user = value;
    else if (key === 'group') filter.group = value;
    else if (key === 'policy') filter.policyId = value;
  }
  return filter;
}
