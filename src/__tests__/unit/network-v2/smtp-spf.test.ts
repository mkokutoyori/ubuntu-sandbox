import { describe, it, expect } from 'vitest';
import { evaluateSpf, formatReceivedSpfHeader, type SpfDnsLookup } from '@/network/smtp/spf';

function lookup(overrides: Partial<SpfDnsLookup>): SpfDnsLookup {
  return {
    resolveTxt: async () => [],
    resolveAddress: async () => null,
    resolveMx: async () => [],
    ...overrides,
  };
}

describe('evaluateSpf() — RFC 7208 mechanism evaluation', () => {
  it('returns none when the domain publishes no TXT record at all', async () => {
    const result = await evaluateSpf(lookup({}), 'example.org', '203.0.113.5');
    expect(result).toEqual({ result: 'none', domain: 'example.org', clientIp: '203.0.113.5' });
  });

  it('returns none when TXT records exist but none is a v=spf1 record', async () => {
    const l = lookup({ resolveTxt: async () => ['google-site-verification=abc'] });
    const result = await evaluateSpf(l, 'example.org', '203.0.113.5');
    expect(result.result).toBe('none');
  });

  it('permerror on more than one v=spf1 record', async () => {
    const l = lookup({ resolveTxt: async () => ['v=spf1 -all', 'v=spf1 +all'] });
    const result = await evaluateSpf(l, 'example.org', '203.0.113.5');
    expect(result.result).toBe('permerror');
  });

  it('permerror on invalid mechanism syntax', async () => {
    const l = lookup({ resolveTxt: async () => ['v=spf1 bogus-mechanism -all'] });
    const result = await evaluateSpf(l, 'example.org', '203.0.113.5');
    expect(result.result).toBe('permerror');
  });

  it('temperror when the TXT lookup itself fails', async () => {
    const l = lookup({ resolveTxt: async () => { throw new Error('DNS timeout'); } });
    const result = await evaluateSpf(l, 'example.org', '203.0.113.5');
    expect(result.result).toBe('temperror');
  });

  describe('ip4 mechanism', () => {
    it('pass for an IP inside the CIDR range', async () => {
      const l = lookup({ resolveTxt: async () => ['v=spf1 ip4:203.0.113.0/24 -all'] });
      const result = await evaluateSpf(l, 'example.org', '203.0.113.42');
      expect(result.result).toBe('pass');
      expect(result.mechanism).toBe('ip4:203.0.113.0/24');
    });

    it('fail (via -all) for an IP outside the CIDR range', async () => {
      const l = lookup({ resolveTxt: async () => ['v=spf1 ip4:203.0.113.0/24 -all'] });
      const result = await evaluateSpf(l, 'example.org', '198.51.100.9');
      expect(result.result).toBe('fail');
      expect(result.mechanism).toBe('-all');
    });

    it('matches a bare ip4 address with an implicit /32', async () => {
      const l = lookup({ resolveTxt: async () => ['v=spf1 ip4:203.0.113.7 -all'] });
      const pass = await evaluateSpf(l, 'example.org', '203.0.113.7');
      expect(pass.result).toBe('pass');
      const fail = await evaluateSpf(l, 'example.org', '203.0.113.8');
      expect(fail.result).toBe('fail');
    });
  });

  describe('ip6 mechanism', () => {
    it('pass for an IPv6 address inside the CIDR range', async () => {
      const l = lookup({ resolveTxt: async () => ['v=spf1 ip6:2001:db8::/32 -all'] });
      const result = await evaluateSpf(l, 'example.org', '2001:db8:1234::5');
      expect(result.result).toBe('pass');
    });

    it('fail for an IPv6 address outside the CIDR range', async () => {
      const l = lookup({ resolveTxt: async () => ['v=spf1 ip6:2001:db8::/32 -all'] });
      const result = await evaluateSpf(l, 'example.org', '2001:db9::1');
      expect(result.result).toBe('fail');
    });
  });

  describe('a mechanism', () => {
    it('pass when the client IP matches the domain A record', async () => {
      const l = lookup({
        resolveTxt: async () => ['v=spf1 a -all'],
        resolveAddress: async (host) => (host === 'example.org' ? '203.0.113.10' : null),
      });
      const result = await evaluateSpf(l, 'example.org', '203.0.113.10');
      expect(result.result).toBe('pass');
    });

    it('softfail via ~all when the client IP does not match', async () => {
      const l = lookup({
        resolveTxt: async () => ['v=spf1 a ~all'],
        resolveAddress: async () => '203.0.113.10',
      });
      const result = await evaluateSpf(l, 'example.org', '198.51.100.1');
      expect(result.result).toBe('softfail');
    });

    it('supports an explicit domain-spec (a:mail.example.org)', async () => {
      const l = lookup({
        resolveTxt: async () => ['v=spf1 a:mail.example.org -all'],
        resolveAddress: async (host) => (host === 'mail.example.org' ? '203.0.113.20' : null),
      });
      const result = await evaluateSpf(l, 'example.org', '203.0.113.20');
      expect(result.result).toBe('pass');
    });
  });

  describe('mx mechanism', () => {
    it('pass when the client IP matches one of the domain MX exchanges', async () => {
      const l = lookup({
        resolveTxt: async () => ['v=spf1 mx -all'],
        resolveMx: async () => [{ preference: 10, exchange: 'mx1.example.org' }, { preference: 20, exchange: 'mx2.example.org' }],
        resolveAddress: async (host) => (host === 'mx2.example.org' ? '203.0.113.30' : null),
      });
      const result = await evaluateSpf(l, 'example.org', '203.0.113.30');
      expect(result.result).toBe('pass');
    });

    it('neutral (default, no all) when nothing matches', async () => {
      const l = lookup({
        resolveTxt: async () => ['v=spf1 mx'],
        resolveMx: async () => [{ preference: 10, exchange: 'mx1.example.org' }],
        resolveAddress: async () => '203.0.113.30',
      });
      const result = await evaluateSpf(l, 'example.org', '198.51.100.1');
      expect(result.result).toBe('neutral');
    });
  });

  describe('include mechanism', () => {
    it('pass when the included domain policy itself passes', async () => {
      const l = lookup({
        resolveTxt: async (domain) => {
          if (domain === 'example.org') return ['v=spf1 include:_spf.provider.example -all'];
          if (domain === '_spf.provider.example') return ['v=spf1 ip4:203.0.113.0/24 -all'];
          return [];
        },
      });
      const result = await evaluateSpf(l, 'example.org', '203.0.113.99');
      expect(result.result).toBe('pass');
      expect(result.mechanism).toBe('include:_spf.provider.example');
    });

    it('falls through to the next mechanism when the include does not pass', async () => {
      const l = lookup({
        resolveTxt: async (domain) => {
          if (domain === 'example.org') return ['v=spf1 include:_spf.provider.example ip4:198.51.100.0/24 -all'];
          if (domain === '_spf.provider.example') return ['v=spf1 -all'];
          return [];
        },
      });
      const result = await evaluateSpf(l, 'example.org', '198.51.100.5');
      expect(result.result).toBe('pass');
      expect(result.mechanism).toBe('ip4:198.51.100.0/24');
    });

    it('permerror when the included domain has no SPF policy at all', async () => {
      const l = lookup({
        resolveTxt: async (domain) => (domain === 'example.org' ? ['v=spf1 include:nowhere.example -all'] : []),
      });
      const result = await evaluateSpf(l, 'example.org', '203.0.113.1');
      expect(result.result).toBe('permerror');
    });
  });

  describe('qualifiers', () => {
    const l = lookup({ resolveTxt: async () => ['v=spf1 ip4:203.0.113.0/24 ?all'] });

    it('applies the ? qualifier as neutral for a matching mechanism', async () => {
      const result = await evaluateSpf(l, 'example.org', '198.51.100.1');
      expect(result.result).toBe('neutral');
    });

    it('the default qualifier (no prefix) is +, i.e. pass', async () => {
      const plusL = lookup({ resolveTxt: async () => ['v=spf1 ip4:203.0.113.0/24'] });
      const result = await evaluateSpf(plusL, 'example.org', '203.0.113.1');
      expect(result.result).toBe('pass');
    });
  });

  it('neutral when no mechanism matches and the policy has no trailing all', async () => {
    const l = lookup({ resolveTxt: async () => ['v=spf1 ip4:203.0.113.0/24'] });
    const result = await evaluateSpf(l, 'example.org', '198.51.100.1');
    expect(result.result).toBe('neutral');
  });
});

describe('formatReceivedSpfHeader() — RFC 7208 §5.1', () => {
  it('formats a pass result with client-ip and helo', () => {
    const header = formatReceivedSpfHeader({
      result: 'pass', domain: 'example.org', clientIp: '203.0.113.5', helo: 'mail.example.org', mechanism: 'ip4:203.0.113.0/24',
    });
    expect(header).toContain('Received-SPF: pass');
    expect(header).toContain('client-ip=203.0.113.5');
    expect(header).toContain('helo=mail.example.org');
  });

  it('formats a fail result without a matched mechanism', () => {
    const header = formatReceivedSpfHeader({
      result: 'fail', domain: 'example.org', clientIp: '198.51.100.1', helo: 'evil.example',
    });
    expect(header).toContain('Received-SPF: fail');
  });
});
