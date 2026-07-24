import { tryIpToUint32, prefixLengthToMaskUint32 } from '@/network/core/ip';
import type { MxTarget } from './relay';

export type SpfResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';

export interface SpfEvaluation {
  readonly result: SpfResult;
  readonly domain: string;
  readonly clientIp: string;
  readonly mechanism?: string;
}

export interface SpfDnsLookup {
  resolveTxt(domain: string): Promise<readonly string[]>;
  resolveAddress(hostname: string): Promise<string | null>;
  resolveMx(domain: string): Promise<readonly MxTarget[]>;
}

const SPF_VERSION_PREFIX = 'v=spf1';
const MAX_INCLUDE_DEPTH = 10;

function isIpv6(ip: string): boolean {
  return ip.includes(':');
}

function ip4InCidr(ip: string, network: string, prefix: number): boolean {
  const ipValue = tryIpToUint32(ip);
  const netValue = tryIpToUint32(network);
  if (ipValue === null || netValue === null) return false;
  const mask = prefixLengthToMaskUint32(prefix);
  return (ipValue & mask) === (netValue & mask);
}

function parseIpv6(ip: string): bigint | null {
  if ((ip.match(/::/g) ?? []).length > 1) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

function ip6InCidr(ip: string, network: string, prefix: number): boolean {
  const ipValue = parseIpv6(ip);
  const netValue = parseIpv6(network);
  if (ipValue === null || netValue === null) return false;
  if (prefix <= 0) return true;
  if (prefix >= 128) return ipValue === netValue;
  const shift = BigInt(128 - prefix);
  const mask = ((1n << 128n) - 1n) >> shift << shift;
  return (ipValue & mask) === (netValue & mask);
}

function addressMatches(clientIp: string, candidate: string, prefix: number | undefined): boolean {
  if (isIpv6(clientIp) || isIpv6(candidate)) {
    return ip6InCidr(clientIp, candidate, prefix ?? 128);
  }
  return ip4InCidr(clientIp, candidate, prefix ?? 32);
}

interface ParsedMechanism {
  readonly qualifier: '+' | '-' | '~' | '?';
  readonly name: 'all' | 'ip4' | 'ip6' | 'a' | 'mx' | 'include';
  readonly domainSpec?: string;
  readonly prefix?: number;
}

const MECHANISM_RE = /^([+\-~?])?(all|ip4|ip6|a|mx|include)(?::([^/]+))?(?:\/(\d+))?$/;

function parseMechanism(term: string): ParsedMechanism | null {
  const m = MECHANISM_RE.exec(term);
  if (!m) return null;
  const [, qualifier, name, domainSpec, prefixStr] = m;
  if (name === 'ip4' || name === 'ip6' || name === 'include') {
    if (!domainSpec) return null;
  }
  return {
    qualifier: (qualifier as ParsedMechanism['qualifier']) ?? '+',
    name: name as ParsedMechanism['name'],
    domainSpec,
    prefix: prefixStr !== undefined ? Number(prefixStr) : undefined,
  };
}

function qualifierToResult(qualifier: ParsedMechanism['qualifier']): SpfResult {
  switch (qualifier) {
    case '+': return 'pass';
    case '-': return 'fail';
    case '~': return 'softfail';
    case '?': return 'neutral';
  }
}

type MechanismOutcome = 'match' | 'nomatch' | 'error';

async function matchMechanism(
  lookup: SpfDnsLookup,
  mech: ParsedMechanism,
  domain: string,
  clientIp: string,
  depth: number,
): Promise<MechanismOutcome> {
  switch (mech.name) {
    case 'all':
      return 'match';
    case 'ip4':
      return addressMatches(clientIp, mech.domainSpec!, mech.prefix) ? 'match' : 'nomatch';
    case 'ip6':
      return addressMatches(clientIp, mech.domainSpec!, mech.prefix) ? 'match' : 'nomatch';
    case 'a': {
      const target = mech.domainSpec ?? domain;
      const addr = await lookup.resolveAddress(target);
      if (!addr) return 'nomatch';
      return addressMatches(clientIp, addr, mech.prefix) ? 'match' : 'nomatch';
    }
    case 'mx': {
      const target = mech.domainSpec ?? domain;
      const targets = await lookup.resolveMx(target);
      for (const mx of targets) {
        const addr = await lookup.resolveAddress(mx.exchange);
        if (addr && addressMatches(clientIp, addr, mech.prefix)) return 'match';
      }
      return 'nomatch';
    }
    case 'include': {
      if (depth >= MAX_INCLUDE_DEPTH) return 'error';
      const inner = await evaluateSpfInternal(lookup, mech.domainSpec!, clientIp, depth + 1);
      if (inner.result === 'pass') return 'match';
      if (inner.result === 'permerror' || inner.result === 'none') return 'error';
      if (inner.result === 'temperror') return 'error';
      return 'nomatch';
    }
  }
}

async function evaluateSpfInternal(
  lookup: SpfDnsLookup,
  domain: string,
  clientIp: string,
  depth: number,
): Promise<SpfEvaluation> {
  let txts: readonly string[];
  try {
    txts = await lookup.resolveTxt(domain);
  } catch {
    return { result: 'temperror', domain, clientIp };
  }

  const records = txts.filter((t) => t.trim().toLowerCase().startsWith(SPF_VERSION_PREFIX));
  if (records.length === 0) return { result: 'none', domain, clientIp };
  if (records.length > 1) return { result: 'permerror', domain, clientIp };

  const terms = records[0].trim().split(/\s+/).slice(1);
  for (const term of terms) {
    const mech = parseMechanism(term);
    if (!mech) return { result: 'permerror', domain, clientIp };
    const outcome = await matchMechanism(lookup, mech, domain, clientIp, depth);
    if (outcome === 'error') return { result: 'permerror', domain, clientIp };
    if (outcome === 'match') {
      return { result: qualifierToResult(mech.qualifier), domain, clientIp, mechanism: term };
    }
  }
  return { result: 'neutral', domain, clientIp };
}

export async function evaluateSpf(lookup: SpfDnsLookup, domain: string, clientIp: string): Promise<SpfEvaluation> {
  return evaluateSpfInternal(lookup, domain, clientIp, 0);
}

export interface ReceivedSpfContext {
  readonly result: SpfResult;
  readonly domain: string;
  readonly clientIp: string;
  readonly helo: string;
  readonly mechanism?: string;
}

export function formatReceivedSpfHeader(ctx: ReceivedSpfContext): string {
  const comment = ctx.mechanism ? `${ctx.domain}: matched "${ctx.mechanism}"` : `${ctx.domain}`;
  return `Received-SPF: ${ctx.result} (${comment}) client-ip=${ctx.clientIp}; helo=${ctx.helo};`;
}
