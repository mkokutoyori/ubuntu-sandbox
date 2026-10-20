/**
 * RFC 6147 (docs/rfc/nat/rfc6147.txt) section 5: the DNS64 synthesis, engine level.
 *
 * Measured before the engine existed: the module could not be imported, so every case fell. The
 * lookups are scripted (no network): what is measured here is the DECISION of section 5.1, not the
 * transport, which the BIND probe covers with real frames. Witnesses that pass for any correct
 * resolver: a real AAAA is returned untouched and NXDOMAIN is passed through (sections 5.1.1, 5.1.2).
 */
import { describe, it, expect } from 'vitest';
import { IPAddress } from '@/network/core/types';
import { RRType } from '@/network/dns/wire/RRType';
import { makeARecord, makeAaaaRecord, makeCnameRecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import type { ResolutionResult } from '@/network/dns/resolver/RecursiveResolver';
import { Nat64Prefix } from '@/network/nat/nat64/Nat64Prefix';
import { applyDns64, DEFAULT_DNS64_EXCLUDE, DNS64_TTL_WITHOUT_SOA_SECONDS, type Dns64Rule } from '@/network/dns/dns64/Dns64';

const noerror = (answers: ResolutionResult['answers'], authorities?: ResolutionResult['authorities']): ResolutionResult =>
  ({ status: 'NOERROR', answers, authorities, fromCache: false });
const empty = noerror([]);

const rule = (overrides: Partial<Dns64Rule> = {}): Dns64Rule => ({
  prefix: Nat64Prefix.wellKnownPrefix(), clients: () => true, mapped: () => true, exclude: DEFAULT_DNS64_EXCLUDE, ...overrides,
});
const query = { client: '10.0.0.5', checkingDisabled: false, dnssecOk: false };
const looking = (answers: Record<number, ResolutionResult>) => async (_n: string, t: number) => answers[t] ?? empty;

describe('RFC 6147 section 5.1: when to synthesize', () => {
  it('section 5.1.6/5.1.7: no AAAA, an A record: a synthetic AAAA under the prefix, the A record removed', async () => {
    const result = await applyDns64([rule()], query, 'www.example.org', empty,
      looking({ [RRType.A]: noerror([makeARecord('www.example.org', 300, '8.8.4.4')]) }));
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].data).toMatchObject({ type: RRType.AAAA });
    expect(result.answers[0].name).toBe('www.example.org');
    expect((result.answers[0].data as { address: { toString(): string } }).address.toString()).toBe('64:ff9b::808:404');
  });

  it('section 5.1.7: the TTL is the minimum of the A record and the SOA of the negative answer', async () => {
    const soa = makeSoaRecord('example.org', 60, { mname: 'ns.example.org', rname: 'h.example.org', serial: 1, refresh: 1, retry: 1, expire: 1, minimum: 60 });
    const a = looking({ [RRType.A]: noerror([makeARecord('www.example.org', 300, '8.8.4.4')]) });
    expect((await applyDns64([rule()], query, 'www.example.org', noerror([], [soa]), a)).answers[0].ttl).toBe(60);
    const longA = looking({ [RRType.A]: noerror([makeARecord('www.example.org', 3600, '8.8.4.4')]) });
    expect((await applyDns64([rule()], query, 'www.example.org', empty, longA)).answers[0].ttl).toBe(DNS64_TTL_WITHOUT_SOA_SECONDS);
    const shortA = looking({ [RRType.A]: noerror([makeARecord('www.example.org', 30, '8.8.4.4')]) });
    expect((await applyDns64([rule()], query, 'www.example.org', empty, shortA)).answers[0].ttl).toBe(30);
  });

  it('section 5.1.1: a real AAAA is returned and nothing is synthesized (witness)', async () => {
    const real = noerror([makeAaaaRecord('v6.example.org', 300, '2001:db8::1')]);
    let asked = false;
    const result = await applyDns64([rule()], query, 'v6.example.org', real, async () => { asked = true; return empty; });
    expect(result.answers).toEqual(real.answers);
    expect(asked).toBe(false);
  });

  it('section 5.1.2: NXDOMAIN is passed through without asking for A (witness)', async () => {
    let asked = false;
    const nx: ResolutionResult = { status: 'NXDOMAIN', answers: [], fromCache: false };
    expect(await applyDns64([rule()], query, 'nope.example.org', nx, async () => { asked = true; return empty; })).toBe(nx);
    expect(asked).toBe(false);
  });

  it('section 5.1.2: any other error on the AAAA query is treated as an empty answer', async () => {
    const servfail: ResolutionResult = { status: 'SERVFAIL', answers: [], fromCache: false };
    const result = await applyDns64([rule()], query, 'www.example.org', servfail,
      looking({ [RRType.A]: noerror([makeARecord('www.example.org', 300, '8.8.4.4')]) }));
    expect(result.answers).toHaveLength(1);
  });

  it('section 5.1.4: an AAAA in ::ffff:0:0/96 is excluded and synthesis proceeds', async () => {
    const mappedOnly = noerror([makeAaaaRecord('www.example.org', 300, '::ffff:8.8.4.4')]);
    const result = await applyDns64([rule()], query, 'www.example.org', mappedOnly,
      looking({ [RRType.A]: noerror([makeARecord('www.example.org', 300, '8.8.4.4')]) }));
    expect(result.answers).toHaveLength(1);
    expect((result.answers[0].data as { address: { toString(): string } }).address.toString()).toBe('64:ff9b::808:404');
  });

  it('section 5.1.4: excluded AAAA records never reach the client when a usable one is present', async () => {
    const mixed = noerror([makeAaaaRecord('x.example.org', 300, '::ffff:8.8.4.4'), makeAaaaRecord('x.example.org', 300, '2001:db8::7')]);
    const result = await applyDns64([rule()], query, 'x.example.org', mixed, looking({}));
    expect(result.answers.map((rr) => (rr.data as { address: { toString(): string } }).address.toString())).toEqual(['2001:db8::7']);
  });

  it('section 5.1.5: the CNAME chain is kept ahead of the synthetic AAAA', async () => {
    const result = await applyDns64([rule()], query, 'alias.example.org', empty, looking({
      [RRType.A]: noerror([makeCnameRecord('alias.example.org', 300, 'www.example.org'), makeARecord('www.example.org', 300, '8.8.4.4')]),
    }));
    expect(result.answers.map((rr) => rr.data.type)).toEqual([RRType.CNAME, RRType.AAAA]);
    expect(result.answers[1].name).toBe('www.example.org');
  });

  it('section 5.2: with the Well-Known Prefix a non-global A record is not synthesized', async () => {
    const result = await applyDns64([rule()], query, 'lan.example.org', empty,
      looking({ [RRType.A]: noerror([makeARecord('lan.example.org', 300, '10.1.2.3')]) }));
    expect(result.answers).toEqual([]);
  });

  it('section 5: the mapped list leaves out the A records it does not select', async () => {
    const onlyTen = rule({ mapped: (ip: IPAddress) => ip.getOctets()[0] === 8 });
    const result = await applyDns64([onlyTen], query, 'two.example.org', empty, looking({
      [RRType.A]: noerror([makeARecord('two.example.org', 300, '8.8.4.4'), makeARecord('two.example.org', 300, '1.1.1.1')]),
    }));
    expect(result.answers).toHaveLength(1);
  });

  it('a client the rule does not serve gets no synthesis', async () => {
    const result = await applyDns64([rule({ clients: (c) => c === '10.9.9.9' })], query, 'www.example.org', empty,
      looking({ [RRType.A]: noerror([makeARecord('www.example.org', 300, '8.8.4.4')]) }));
    expect(result.answers).toEqual([]);
  });

  it('section 5.5 item 3: CD and DO together: no synthesis, the client validates', async () => {
    const result = await applyDns64([rule()], { ...query, checkingDisabled: true, dnssecOk: true }, 'www.example.org', empty,
      looking({ [RRType.A]: noerror([makeARecord('www.example.org', 300, '8.8.4.4')]) }));
    expect(result.answers).toEqual([]);
  });
});
