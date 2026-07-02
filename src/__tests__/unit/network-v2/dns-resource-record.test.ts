import { describe, it, expect } from 'vitest';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import {
  makeARecord, makeAaaaRecord, makeNsRecord, makeCnameRecord, makeSoaRecord,
  makePtrRecord, makeMxRecord, makeTxtRecord, makeSrvRecord,
  validateDnsName, DnsNameError, DnsRecordError,
} from '@/network/dns/wire/ResourceRecord';

describe('RRType / DnsClass — IANA numeric assignments', () => {
  it('matches the IANA-registered values for the RR types this engine supports', () => {
    expect(RRType.A).toBe(1);
    expect(RRType.NS).toBe(2);
    expect(RRType.CNAME).toBe(5);
    expect(RRType.SOA).toBe(6);
    expect(RRType.PTR).toBe(12);
    expect(RRType.MX).toBe(15);
    expect(RRType.TXT).toBe(16);
    expect(RRType.AAAA).toBe(28);
    expect(RRType.SRV).toBe(33);
    expect(RRType.OPT).toBe(41);
    expect(RRType.ANY).toBe(255);
  });

  it('matches the IANA-registered DNS classes', () => {
    expect(DnsClass.IN).toBe(1);
    expect(DnsClass.CH).toBe(3);
    expect(DnsClass.HS).toBe(4);
    expect(DnsClass.ANY).toBe(255);
  });
});

describe('validateDnsName — RFC 1035 §3.1/§2.3.4', () => {
  it('accepts a well-formed name', () => {
    expect(() => validateDnsName('www.example.com')).not.toThrow();
  });

  it('accepts the root name', () => {
    expect(() => validateDnsName('.')).not.toThrow();
    expect(() => validateDnsName('')).not.toThrow();
  });

  it('rejects a label longer than 63 octets', () => {
    const longLabel = 'a'.repeat(64);
    expect(() => validateDnsName(`${longLabel}.com`)).toThrow(DnsNameError);
  });

  it('accepts a label exactly 63 octets long (the maximum)', () => {
    const maxLabel = 'a'.repeat(63);
    expect(() => validateDnsName(`${maxLabel}.com`)).not.toThrow();
  });

  it('rejects an empty label in the middle of the name', () => {
    expect(() => validateDnsName('www..example.com')).toThrow(DnsNameError);
  });

  it('rejects a name whose total wire length would exceed 255 octets', () => {
    const label63 = 'a'.repeat(63);
    const tooLong = Array.from({ length: 5 }, () => label63).join('.');
    expect(() => validateDnsName(tooLong)).toThrow(DnsNameError);
  });

  it('accepts internationalised domain names encoded as ASCII punycode (xn--)', () => {
    expect(() => validateDnsName('xn--e1afmkfd.example.com')).not.toThrow();
  });
});

describe('makeARecord', () => {
  it('builds a valid A record from a dotted-quad string', () => {
    const rr = makeARecord('host.example.com', 3600, '192.0.2.1');
    expect(rr.name).toBe('host.example.com');
    expect(rr.ttl).toBe(3600);
    expect(rr.rrClass).toBe(DnsClass.IN);
    expect(rr.data.type).toBe(RRType.A);
    expect(rr.data.address.toString()).toBe('192.0.2.1');
  });

  it('rejects a negative TTL', () => {
    expect(() => makeARecord('host.example.com', -1, '192.0.2.1')).toThrow(DnsRecordError);
  });

  it('rejects a TTL exceeding the signed 32-bit range (RFC 1035 §3.2.1)', () => {
    expect(() => makeARecord('host.example.com', 0x80000000, '192.0.2.1')).toThrow(DnsRecordError);
  });

  it('accepts TTL=0 (no caching, RFC 1035 §3.2.1)', () => {
    expect(() => makeARecord('host.example.com', 0, '192.0.2.1')).not.toThrow();
  });

  it('rejects an invalid IPv4 address', () => {
    expect(() => makeARecord('host.example.com', 3600, '999.0.0.1')).toThrow();
  });

  it('rejects an owner name that is not well-formed', () => {
    const longLabel = 'a'.repeat(64);
    expect(() => makeARecord(`${longLabel}.com`, 3600, '192.0.2.1')).toThrow(DnsNameError);
  });
});

describe('makeAaaaRecord', () => {
  it('builds a valid AAAA record', () => {
    const rr = makeAaaaRecord('host.example.com', 3600, '2001:db8::1');
    expect(rr.data.type).toBe(RRType.AAAA);
    expect(rr.data.address.toString()).toBe('2001:db8::1');
  });
});

describe('makeNsRecord / makeCnameRecord / makePtrRecord', () => {
  it('builds an NS record delegating to a nameserver', () => {
    const rr = makeNsRecord('example.com', 86400, 'ns1.example.com');
    expect(rr.data).toEqual({ type: RRType.NS, nsdname: 'ns1.example.com' });
  });

  it('builds a CNAME record', () => {
    const rr = makeCnameRecord('www.example.com', 3600, 'example.com');
    expect(rr.data).toEqual({ type: RRType.CNAME, cname: 'example.com' });
  });

  it('builds a PTR record for reverse DNS', () => {
    const rr = makePtrRecord('1.2.0.192.in-addr.arpa', 3600, 'host.example.com');
    expect(rr.data).toEqual({ type: RRType.PTR, ptrdname: 'host.example.com' });
  });
});

describe('makeSoaRecord — RFC 1035 §3.3.13', () => {
  it('builds a complete SOA with the five standard timers', () => {
    const rr = makeSoaRecord('example.com', 3600, {
      mname: 'ns1.example.com', rname: 'hostmaster.example.com',
      serial: 2026070100, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
    });
    expect(rr.data.serial).toBe(2026070100);
    expect(rr.data.minimum).toBe(300);
  });

  it('rejects a serial number outside the unsigned 32-bit range', () => {
    expect(() => makeSoaRecord('example.com', 3600, {
      mname: 'ns1.example.com', rname: 'hostmaster.example.com',
      serial: 0x100000000, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
    })).toThrow(DnsRecordError);
  });

  it('rejects a negative refresh/retry/expire/minimum', () => {
    expect(() => makeSoaRecord('example.com', 3600, {
      mname: 'ns1.example.com', rname: 'hostmaster.example.com',
      serial: 1, refresh: -1, retry: 3600, expire: 1209600, minimum: 300,
    })).toThrow(DnsRecordError);
  });
});

describe('makeMxRecord', () => {
  it('builds an MX record with preference and exchange', () => {
    const rr = makeMxRecord('example.com', 3600, 10, 'mail.example.com');
    expect(rr.data).toEqual({ type: RRType.MX, preference: 10, exchange: 'mail.example.com' });
  });

  it('rejects a preference outside the unsigned 16-bit range', () => {
    expect(() => makeMxRecord('example.com', 3600, 70000, 'mail.example.com')).toThrow(DnsRecordError);
  });
});

describe('makeTxtRecord — RFC 1035 §3.3.14', () => {
  it('builds a TXT record from a single string', () => {
    const rr = makeTxtRecord('example.com', 3600, 'v=spf1 -all');
    expect(rr.data).toEqual({ type: RRType.TXT, text: ['v=spf1 -all'] });
  });

  it('builds a multi-segment TXT record (character-strings > 255 octets each)', () => {
    const rr = makeTxtRecord('example.com', 3600, ['segment one', 'segment two']);
    expect(rr.data.text).toEqual(['segment one', 'segment two']);
  });

  it('rejects a character-string longer than 255 octets (RFC 1035 §3.3)', () => {
    expect(() => makeTxtRecord('example.com', 3600, 'x'.repeat(256))).toThrow(DnsRecordError);
  });

  it('accepts an empty TXT record (zero-length character-string is valid)', () => {
    expect(() => makeTxtRecord('example.com', 3600, '')).not.toThrow();
  });
});

describe('makeSrvRecord — RFC 2782', () => {
  it('builds an SRV record for a service', () => {
    const rr = makeSrvRecord('_ldap._tcp.example.com', 3600, {
      priority: 10, weight: 20, port: 389, target: 'dc1.example.com',
    });
    expect(rr.data).toEqual({
      type: RRType.SRV, priority: 10, weight: 20, port: 389, target: 'dc1.example.com',
    });
  });

  it('rejects a port outside the unsigned 16-bit range', () => {
    expect(() => makeSrvRecord('_ldap._tcp.example.com', 3600, {
      priority: 10, weight: 20, port: 70000, target: 'dc1.example.com',
    })).toThrow(DnsRecordError);
  });
});
