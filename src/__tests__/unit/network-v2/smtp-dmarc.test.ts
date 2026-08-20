import { describe, it, expect } from 'vitest';
import {
  fetchDmarcPolicy, evaluateDmarcAlignment, formatAuthenticationResultsHeader,
  type DmarcDnsLookup, type DmarcPolicyRecord,
} from '@/network/smtp/dmarc';

function lookup(records: Record<string, readonly string[]>): DmarcDnsLookup {
  return { resolveTxt: async (domain) => records[domain] ?? [] };
}

describe('fetchDmarcPolicy() — RFC 7489 policy record parsing', () => {
  it('parses a basic p=reject policy', async () => {
    const l = lookup({ '_dmarc.example.org': ['v=DMARC1; p=reject; aspf=r; adkim=r'] });
    const record = await fetchDmarcPolicy(l, 'example.org');
    expect(record).toEqual({ domain: 'example.org', policy: 'reject', spfAlignment: 'relaxed', dkimAlignment: 'relaxed' });
  });

  it('defaults alignment modes to relaxed when adkim/aspf are absent', async () => {
    const l = lookup({ '_dmarc.example.org': ['v=DMARC1; p=quarantine'] });
    const record = await fetchDmarcPolicy(l, 'example.org');
    expect(record?.spfAlignment).toBe('relaxed');
    expect(record?.dkimAlignment).toBe('relaxed');
  });

  it('honors strict (s) alignment modes', async () => {
    const l = lookup({ '_dmarc.example.org': ['v=DMARC1; p=reject; adkim=s; aspf=s'] });
    const record = await fetchDmarcPolicy(l, 'example.org');
    expect(record?.spfAlignment).toBe('strict');
    expect(record?.dkimAlignment).toBe('strict');
  });

  it('returns null when no _dmarc TXT record is published', async () => {
    const record = await fetchDmarcPolicy(lookup({}), 'example.org');
    expect(record).toBeNull();
  });

  it('returns null when p= is missing or invalid', async () => {
    const l = lookup({ '_dmarc.example.org': ['v=DMARC1; sp=none'] });
    expect(await fetchDmarcPolicy(l, 'example.org')).toBeNull();
  });
});

describe('evaluateDmarcAlignment() — composition over SPF/DKIM results, no re-evaluation', () => {
  const strictRecord: DmarcPolicyRecord = { domain: 'example.org', policy: 'reject', spfAlignment: 'strict', dkimAlignment: 'strict' };
  const relaxedRecord: DmarcPolicyRecord = { domain: 'example.org', policy: 'reject', spfAlignment: 'relaxed', dkimAlignment: 'relaxed' };

  it('aligned + pass on SPF alone yields deliver', () => {
    const evaluation = evaluateDmarcAlignment(strictRecord, {
      fromDomain: 'example.org',
      spf: { result: 'pass', domain: 'example.org' },
    });
    expect(evaluation.spfAligned).toBe(true);
    expect(evaluation.dkimAligned).toBe(false);
    expect(evaluation.disposition).toBe('deliver');
  });

  it('aligned + pass on DKIM alone yields deliver', () => {
    const evaluation = evaluateDmarcAlignment(strictRecord, {
      fromDomain: 'example.org',
      dkim: { result: 'pass', domain: 'example.org' },
    });
    expect(evaluation.dkimAligned).toBe(true);
    expect(evaluation.disposition).toBe('deliver');
  });

  it('strict alignment rejects a subdomain match that relaxed would accept', () => {
    const strictEval = evaluateDmarcAlignment(strictRecord, {
      fromDomain: 'example.org',
      spf: { result: 'pass', domain: 'mail.example.org' },
    });
    expect(strictEval.spfAligned).toBe(false);
    expect(strictEval.disposition).toBe('reject');

    const relaxedEval = evaluateDmarcAlignment(relaxedRecord, {
      fromDomain: 'example.org',
      spf: { result: 'pass', domain: 'mail.example.org' },
    });
    expect(relaxedEval.spfAligned).toBe(true);
    expect(relaxedEval.disposition).toBe('deliver');
  });

  it('an SPF pass on an unrelated domain is not aligned even under relaxed mode', () => {
    const evaluation = evaluateDmarcAlignment(relaxedRecord, {
      fromDomain: 'example.org',
      spf: { result: 'pass', domain: 'attacker.example' },
    });
    expect(evaluation.spfAligned).toBe(false);
    expect(evaluation.disposition).toBe('reject');
  });

  it('an aligned domain with a non-pass SPF/DKIM result does not count as aligned', () => {
    const evaluation = evaluateDmarcAlignment(relaxedRecord, {
      fromDomain: 'example.org',
      spf: { result: 'fail', domain: 'example.org' },
      dkim: { result: 'fail', domain: 'example.org' },
    });
    expect(evaluation.spfAligned).toBe(false);
    expect(evaluation.dkimAligned).toBe(false);
    expect(evaluation.disposition).toBe('reject');
  });

  it('p=quarantine marks but does not reject an unaligned message', () => {
    const record: DmarcPolicyRecord = { ...relaxedRecord, policy: 'quarantine' };
    const evaluation = evaluateDmarcAlignment(record, { fromDomain: 'example.org' });
    expect(evaluation.disposition).toBe('quarantine');
  });

  it('p=none delivers and only logs, even fully unaligned', () => {
    const record: DmarcPolicyRecord = { ...relaxedRecord, policy: 'none' };
    const evaluation = evaluateDmarcAlignment(record, { fromDomain: 'example.org' });
    expect(evaluation.disposition).toBe('deliver');
    expect(evaluation.policy).toBe('none');
  });
});

describe('formatAuthenticationResultsHeader()', () => {
  it('renders spf/dkim/dmarc results with their checked domains', () => {
    const dmarcEval = evaluateDmarcAlignment(
      { domain: 'example.org', policy: 'reject', spfAlignment: 'relaxed', dkimAlignment: 'relaxed' },
      { fromDomain: 'example.org', spf: { result: 'pass', domain: 'example.org' } },
    );
    const header = formatAuthenticationResultsHeader({
      servId: 'mail.receiver.example',
      fromDomain: 'example.org',
      spf: { result: 'pass', domain: 'example.org' },
      dkim: { result: 'fail', domain: 'example.org' },
      dmarc: dmarcEval,
    });
    expect(header.startsWith('Authentication-Results: mail.receiver.example;')).toBe(true);
    expect(header).toContain('spf=pass smtp.mailfrom=example.org');
    expect(header).toContain('dkim=fail header.d=example.org');
    expect(header).toContain('dmarc=pass (p=reject dis=deliver) header.from=example.org');
  });

  it('reports dmarc=fail when neither SPF nor DKIM aligned', () => {
    const dmarcEval = evaluateDmarcAlignment(
      { domain: 'example.org', policy: 'reject', spfAlignment: 'relaxed', dkimAlignment: 'relaxed' },
      { fromDomain: 'example.org' },
    );
    const header = formatAuthenticationResultsHeader({ servId: 'mx.example', fromDomain: 'example.org', dmarc: dmarcEval });
    expect(header).toContain('dmarc=fail (p=reject dis=reject) header.from=example.org');
  });
});
