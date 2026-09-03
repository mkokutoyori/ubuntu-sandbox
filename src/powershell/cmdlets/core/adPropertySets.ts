import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import type { CmdletContext } from '@/powershell/cmdlets/CmdletContext';

export const OU_DEFAULT_PROPERTIES: readonly string[] = [
  'City', 'Country', 'DistinguishedName', 'LinkedGroupPolicyObjects', 'ManagedBy',
  'Name', 'ObjectClass', 'PostalCode', 'State', 'StreetAddress',
];

export const USER_DEFAULT_PROPERTIES: readonly string[] = [
  'DistinguishedName', 'Enabled', 'GivenName', 'Name', 'ObjectClass',
  'SamAccountName', 'SID', 'Surname', 'UserPrincipalName',
];

export const GROUP_DEFAULT_PROPERTIES: readonly string[] = [
  'DistinguishedName', 'GroupCategory', 'GroupScope', 'Name', 'ObjectClass', 'SamAccountName',
];

export const COMPUTER_DEFAULT_PROPERTIES: readonly string[] = [
  'DistinguishedName', 'DNSHostName', 'Enabled', 'Name', 'ObjectClass', 'SamAccountName',
];

export function requestedProperties(ctx: CmdletContext): readonly string[] | 'all' | null {
  const raw = ctx.named['properties'];
  if (raw === undefined) return null;
  const asked = (Array.isArray(raw) ? raw : [raw]).map(psValueToString)
    .flatMap(v => v.split(',')).map(v => v.trim()).filter(v => v !== '');
  if (asked.some(v => v === '*')) return 'all';
  return asked;
}

export function selectAdProperties(
  object: Record<string, PSValue>,
  defaults: readonly string[],
  asked: readonly string[] | 'all' | null,
): Record<string, PSValue> {
  if (asked === 'all') return object;
  const keep = new Set(defaults.map(p => p.toLowerCase()));
  for (const extra of asked ?? []) keep.add(extra.toLowerCase());
  const out: Record<string, PSValue> = {};
  for (const [name, value] of Object.entries(object)) {
    if (keep.has(name.toLowerCase())) out[name] = value;
  }
  for (const extra of asked ?? []) {
    if (out[extra] === undefined && object[extra] === undefined) out[extra] = '';
  }
  return out;
}

export function adView(
  ctx: CmdletContext, defaults: readonly string[],
): (object: Record<string, PSValue>) => Record<string, PSValue> {
  const asked = requestedProperties(ctx);
  return object => selectAdProperties(object, defaults, asked);
}
