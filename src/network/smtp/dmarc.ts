import type { SpfResult } from './spf';
import type { DkimVerifyResult } from './dkim';

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';
export type DmarcAlignmentMode = 'strict' | 'relaxed';

export interface DmarcPolicyRecord {
  readonly domain: string;
  readonly policy: DmarcPolicy;
  readonly spfAlignment: DmarcAlignmentMode;
  readonly dkimAlignment: DmarcAlignmentMode;
}

export interface DmarcEvaluation {
  readonly policy: DmarcPolicy;
  readonly spfAligned: boolean;
  readonly dkimAligned: boolean;
  readonly disposition: 'deliver' | 'quarantine' | 'reject';
}

export interface DmarcDnsLookup {
  resolveTxt(domain: string): Promise<readonly string[]>;
}

export interface DmarcInput {
  readonly fromDomain: string;
  readonly spf?: { readonly result: SpfResult; readonly domain: string };
  readonly dkim?: { readonly result: DkimVerifyResult; readonly domain: string };
}

function parseTags(record: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of record.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key) tags.set(key, value);
  }
  return tags;
}

export async function fetchDmarcPolicy(lookup: DmarcDnsLookup, fromDomain: string): Promise<DmarcPolicyRecord | null> {
  const txts = await lookup.resolveTxt(`_dmarc.${fromDomain}`);
  const record = txts.find((t) => t.trim().toLowerCase().startsWith('v=dmarc1'));
  if (!record) return null;

  const tags = parseTags(record);
  const policy = tags.get('p');
  if (policy !== 'none' && policy !== 'quarantine' && policy !== 'reject') return null;

  return {
    domain: fromDomain,
    policy,
    spfAlignment: tags.get('aspf') === 's' ? 'strict' : 'relaxed',
    dkimAlignment: tags.get('adkim') === 's' ? 'strict' : 'relaxed',
  };
}

function organizationalDomain(domain: string): string {
  const parts = domain.toLowerCase().split('.');
  return parts.length <= 2 ? domain.toLowerCase() : parts.slice(-2).join('.');
}

function domainsAligned(fromDomain: string, checkedDomain: string, mode: DmarcAlignmentMode): boolean {
  const a = fromDomain.toLowerCase();
  const b = checkedDomain.toLowerCase();
  if (a === b) return true;
  if (mode === 'strict') return false;
  return organizationalDomain(a) === organizationalDomain(b);
}

export function evaluateDmarcAlignment(record: DmarcPolicyRecord, input: DmarcInput): DmarcEvaluation {
  const spfAligned = input.spf !== undefined && input.spf.result === 'pass' && domainsAligned(input.fromDomain, input.spf.domain, record.spfAlignment);
  const dkimAligned = input.dkim !== undefined && input.dkim.result === 'pass' && domainsAligned(input.fromDomain, input.dkim.domain, record.dkimAlignment);
  const aligned = spfAligned || dkimAligned;
  const disposition = aligned ? 'deliver' : record.policy === 'none' ? 'deliver' : record.policy;
  return { policy: record.policy, spfAligned, dkimAligned, disposition };
}

export interface AuthenticationResultsContext {
  readonly servId: string;
  readonly fromDomain: string;
  readonly spf?: { readonly result: SpfResult; readonly domain: string };
  readonly dkim?: { readonly result: DkimVerifyResult; readonly domain: string };
  readonly dmarc?: DmarcEvaluation;
}

export function formatAuthenticationResultsHeader(ctx: AuthenticationResultsContext): string {
  const parts = [ctx.servId];
  if (ctx.spf) parts.push(`spf=${ctx.spf.result} smtp.mailfrom=${ctx.spf.domain}`);
  if (ctx.dkim) parts.push(`dkim=${ctx.dkim.result} header.d=${ctx.dkim.domain}`);
  if (ctx.dmarc) {
    const dmarcResult = ctx.dmarc.spfAligned || ctx.dmarc.dkimAligned ? 'pass' : 'fail';
    parts.push(`dmarc=${dmarcResult} (p=${ctx.dmarc.policy} dis=${ctx.dmarc.disposition}) header.from=${ctx.fromDomain}`);
  }
  return `Authentication-Results: ${parts.join('; ')}`;
}
