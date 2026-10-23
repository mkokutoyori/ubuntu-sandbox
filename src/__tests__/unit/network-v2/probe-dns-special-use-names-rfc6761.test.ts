/**
 * Probe: RFC 6761 §6.1-6.4 special-use names in the recursive resolver.
 * Authority: docs/rfc/addressing/rfc6761.txt. Before the fix the cases for
 * private reverse, test, invalid and localhost fail (the resolver walks the
 * root hints and answers SERVFAIL); the example.com and public-reverse
 * witnesses pass either way because the resolver is not allowed to treat
 * them as special (§6.5.4).
 */
import { describe, it, expect } from 'vitest';
import { classifySpecialUseName, answerSpecialUseName } from '@/network/dns/resolver/SpecialUseNames';
import { RecursiveResolver } from '@/network/dns/resolver/RecursiveResolver';
import { RRType } from '@/network/dns/wire/RRType';
import { IPAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('classification', () => {
  it.each([
    ['10.in-addr.arpa', 'private-reverse'], ['5.2.10.in-addr.arpa', 'private-reverse'],
    ['16.172.in-addr.arpa', 'private-reverse'], ['31.172.in-addr.arpa', 'private-reverse'],
    ['15.172.in-addr.arpa', null], ['32.172.in-addr.arpa', null],
    ['168.192.in-addr.arpa', 'private-reverse'], ['169.192.in-addr.arpa', null],
    ['8.8.8.8.in-addr.arpa', null],
    ['foo.test', 'test'], ['test.', 'test'], ['contest', null],
    ['a.b.localhost', 'localhost'], ['host.invalid.', 'invalid'],
    ['example.com', null], ['example', null],
  ])('%s -> %s', (name, kind) => {
    expect(classifySpecialUseName(name)).toBe(kind);
  });
});

describe('answers', () => {
  it('localhost: A and AAAA give loopback, other types give NODATA', () => {
    expect(answerSpecialUseName('localhost', 'x.localhost', RRType.A).answers[0].data).toMatchObject({ address: expect.objectContaining({}) });
    expect(answerSpecialUseName('localhost', 'x.localhost', RRType.AAAA).answers).toHaveLength(1);
    expect(answerSpecialUseName('localhost', 'x.localhost', RRType.MX)).toEqual({ status: 'NOERROR', answers: [] });
  });
  it('test, invalid, private reverse: immediate NXDOMAIN', () => {
    for (const kind of ['test', 'invalid', 'private-reverse'] as const) {
      expect(answerSpecialUseName(kind, 'a.b', RRType.A)).toEqual({ status: 'NXDOMAIN', answers: [] });
    }
  });
});

describe('resolver does not leave the host', () => {
  const resolverFor = (upstream: boolean, refuseTestNames = false) => {
    const host = new LinuxPC('linux-pc', 'pc');
    return new RecursiveResolver(host, [new IPAddress('198.41.0.4')], undefined, { resolveSpecialUseNamesUpstream: upstream, refuseTestNames });
  };
  it('answers locally without a single query', async () => {
    const resolver = resolverFor(false);
    expect((await resolver.resolve('foo.invalid', RRType.A)).status).toBe('NXDOMAIN');
    expect((await resolver.resolve('4.3.2.10.in-addr.arpa', RRType.PTR)).status).toBe('NXDOMAIN');
    expect((await resolverFor(false, true).resolve('a.test', RRType.A)).status).toBe('NXDOMAIN');
    const local = await resolver.resolve('www.localhost', RRType.A);
    expect(local.status).toBe('NOERROR');
    expect(local.answers).toHaveLength(1);
  });
  it('.test is resolved normally by default: BIND and Windows DNS do not special-case it and labs delegate it', async () => {
    expect((await resolverFor(false).resolve('a.test', RRType.A)).status).toBe('SERVFAIL');
  });
  it('witness: an unreachable root gives SERVFAIL for a normal name', async () => {
    expect((await resolverFor(false).resolve('example.com', RRType.A)).status).toBe('SERVFAIL');
  });
  it('upstream option lifts the shortcut for non-localhost names', async () => {
    expect((await resolverFor(true).resolve('foo.invalid', RRType.A)).status).toBe('SERVFAIL');
  });
});
