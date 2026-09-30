import { RRType } from '@/network/dns/wire/RRType';
import { normalizeDnsName, isWithinDomain } from '@/network/dns/wire/DnsName';
import { NamedConfigError } from './NamedConfigError';
import type { NamedConfStatement } from './NamedConfParser';

export type UpdatePolicyNameType =
  | 'name' | 'subdomain' | 'wildcard' | 'self' | 'selfsub' | 'selfwild' | 'zonesub';

const UNDECIDABLE_NAME_TYPES = new Set([
  '6to4-self', 'external', 'krb5-self', 'krb5-selfsub', 'krb5-subdomain', 'krb5-subdomain-self-rhs',
  'ms-self', 'ms-selfsub', 'ms-subdomain', 'ms-subdomain-self-rhs', 'tcp-self',
]);

const SUPPORTED_NAME_TYPES = new Set<string>([
  'name', 'subdomain', 'wildcard', 'self', 'selfsub', 'selfwild', 'zonesub',
]);

const EXCLUDED_BY_DEFAULT = new Set<number>([RRType.SOA, RRType.NS, RRType.RRSIG, RRType.NSEC]);
const NEVER_MATCHED_BY_ANY = new Set<number>([RRType.NSEC]);

export interface UpdatePolicyRule {
  readonly grant: boolean;
  readonly identity: string;
  readonly nameType: UpdatePolicyNameType | null;
  readonly name: string | null;
  readonly types: ReadonlySet<number> | 'default' | 'any';
}

const TYPE_NUMBERS: ReadonlyMap<string, number> = new Map(
  Object.entries(RRType).map(([name, code]) => [name, code as number]));

function parseTypes(statement: NamedConfStatement, names: readonly string[]): UpdatePolicyRule['types'] {
  if (names.length === 0) return 'default';
  const types = new Set<number>();
  for (const raw of names) {
    const upper = raw.toUpperCase();
    if (upper === 'ANY') return 'any';
    const code = TYPE_NUMBERS.get(upper);
    if (code === undefined) {
      throw new NamedConfigError(statement.file, statement.line, `unknown type '${raw}'`);
    }
    types.add(code);
  }
  return types;
}

export function parseUpdatePolicyRule(statement: NamedConfStatement): UpdatePolicyRule {
  const words = statement.values.map((value) => value.text);
  const verb = words[0];
  if (verb !== 'grant' && verb !== 'deny') {
    throw new NamedConfigError(statement.file, statement.line, `expected 'grant' or 'deny' near '${verb}'`);
  }
  const identity = words[1];
  const nameType = words[2];
  if (!identity || !nameType) {
    throw new NamedConfigError(statement.file, statement.line, `expected ${verb} identity and name type`);
  }
  const lowered = nameType.toLowerCase();
  if (!SUPPORTED_NAME_TYPES.has(lowered) && !UNDECIDABLE_NAME_TYPES.has(lowered)) {
    throw new NamedConfigError(statement.file, statement.line, `unknown name type '${nameType}'`);
  }
  const withoutName = lowered === 'zonesub';
  const name = withoutName ? null : (words[3] ?? null);
  if (!withoutName && name === null) {
    throw new NamedConfigError(statement.file, statement.line, `expected a name after '${nameType}'`);
  }
  const typeWords = words.slice(withoutName ? 3 : 4);
  return {
    grant: verb === 'grant',
    identity: normalizeDnsName(identity),
    nameType: SUPPORTED_NAME_TYPES.has(lowered) ? lowered as UpdatePolicyNameType : null,
    name: name === null ? null : normalizeDnsName(name),
    types: parseTypes(statement, typeWords),
  };
}

function identityMatches(rule: UpdatePolicyRule, signer: string): boolean {
  if (rule.identity === '*') return true;
  if (rule.identity.startsWith('*.')) return isWithinDomain(signer, rule.identity.slice(2)) && signer !== rule.identity.slice(2);
  return rule.identity === signer;
}

function nameMatches(rule: UpdatePolicyRule, signer: string, zone: string, target: string): boolean {
  switch (rule.nameType) {
    case 'name': return target === rule.name;
    case 'subdomain': return isWithinDomain(target, rule.name ?? '');
    case 'wildcard': {
      const pattern = rule.name ?? '';
      return pattern.startsWith('*.')
        && target !== pattern.slice(2) && isWithinDomain(target, pattern.slice(2));
    }
    case 'self': return target === signer;
    case 'selfsub': return isWithinDomain(target, signer);
    case 'selfwild': return target !== signer && target.endsWith(`.${signer}`)
      && !target.slice(0, -signer.length - 1).includes('.');
    case 'zonesub': return isWithinDomain(target, zone);
    case null: return false;
  }
}

function typeMatches(rule: UpdatePolicyRule, type: number): boolean {
  if (rule.types === 'default') return !EXCLUDED_BY_DEFAULT.has(type);
  if (rule.types === 'any') return !NEVER_MATCHED_BY_ANY.has(type);
  return rule.types.has(type);
}

export function updatePolicyPermits(
  rules: readonly UpdatePolicyRule[],
  signer: string | null,
  zone: string,
  targetName: string,
  type: number,
): boolean {
  if (signer === null) return false;
  const who = normalizeDnsName(signer);
  const target = normalizeDnsName(targetName);
  const origin = normalizeDnsName(zone);
  for (const rule of rules) {
    if (!identityMatches(rule, who)) continue;
    if (rule.nameType === null) {
      if (!rule.grant) return false;
      continue;
    }
    if (!nameMatches(rule, who, origin, target)) continue;
    if (!typeMatches(rule, type)) continue;
    return rule.grant;
  }
  return false;
}
