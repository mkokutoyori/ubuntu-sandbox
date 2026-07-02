import { describe, it, expect } from 'vitest';
import { parseZoneFile, ZoneFileError } from '@/network/dns/zone/ZoneFile';
import { RRType } from '@/network/dns/wire/RRType';

const SAMPLE_ZONE = `
; A sample authoritative zone file for example.com
$ORIGIN example.com.
$TTL 3600

@       IN      SOA     ns1.example.com. hostmaster.example.com. (
                            2026070100 ; serial
                            7200       ; refresh
                            3600       ; retry
                            1209600    ; expire
                            300 )      ; minimum

        IN      NS      ns1.example.com.
        IN      NS      ns2.example.com.

ns1     IN      A       192.0.2.1
ns2     IN      A       192.0.2.2
www     IN      A       192.0.2.10
        IN      AAAA    2001:db8::10
mail    IN      A       192.0.2.20
        IN      MX 10   mail.example.com.
alias   IN      CNAME   www.example.com.
info    IN      TXT     "v=spf1 -all"
_ldap._tcp  IN  SRV     10 20 389 dc1.example.com.
child   IN      NS      ns1.child.example.com.
ns1.child IN    A       192.0.2.53
`;

describe('ZoneFile — RFC 1035 §5 master file format', () => {
  it('parses the origin from the $ORIGIN directive', () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    expect(zone.origin).toBe('example.com');
  });

  it('parses the SOA record with all five timers', () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    expect(zone.soa.data.serial).toBe(2026070100);
    expect(zone.soa.data.refresh).toBe(7200);
    expect(zone.soa.data.retry).toBe(3600);
    expect(zone.soa.data.expire).toBe(1209600);
    expect(zone.soa.data.minimum).toBe(300);
    expect(zone.soa.data.mname).toBe('ns1.example.com');
    expect(zone.soa.data.rname).toBe('hostmaster.example.com');
  });

  it('reuses the owner name from the previous record when a line starts blank', () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    const ns = zone.getRRSet('example.com', RRType.NS);
    expect(ns).toHaveLength(2);
  });

  it('expands relative names against $ORIGIN', () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    const a = zone.getRRSet('ns1.example.com', RRType.A);
    expect(a).toHaveLength(1);
    expect(a![0].data.type === RRType.A && a![0].data.address.toString()).toBe('192.0.2.1');
  });

  it('applies the $TTL directive when no explicit TTL is given on a record line', () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    const a = zone.getRRSet('www.example.com', RRType.A)!;
    expect(a[0].ttl).toBe(3600);
  });

  it('parses an AAAA record on a continuation line reusing the owner', () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    const aaaa = zone.getRRSet('www.example.com', RRType.AAAA)!;
    expect(aaaa[0].data.type === RRType.AAAA && aaaa[0].data.address.toString()).toBe('2001:db8::10');
  });

  it('parses an MX record with preference and exchange', () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    const mx = zone.getRRSet('mail.example.com', RRType.MX)!;
    expect(mx[0].data).toEqual({ type: RRType.MX, preference: 10, exchange: 'mail.example.com' });
  });

  it('parses a CNAME record expanding a relative target', () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    const cname = zone.getRRSet('alias.example.com', RRType.CNAME)!;
    expect(cname[0].data).toEqual({ type: RRType.CNAME, cname: 'www.example.com' });
  });

  it('parses a quoted TXT record', () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    const txt = zone.getRRSet('info.example.com', RRType.TXT)!;
    expect(txt[0].data).toEqual({ type: RRType.TXT, text: ['v=spf1 -all'] });
  });

  it('parses an SRV record with an underscore-prefixed owner name', () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    const srv = zone.getRRSet('_ldap._tcp.example.com', RRType.SRV)!;
    expect(srv[0].data).toEqual({
      type: RRType.SRV, priority: 10, weight: 20, port: 389, target: 'dc1.example.com',
    });
  });

  it('parses a delegation NS record and its glue A record', () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    const ns = zone.getRRSet('child.example.com', RRType.NS)!;
    expect(ns[0].data).toEqual({ type: RRType.NS, nsdname: 'ns1.child.example.com' });
    const glue = zone.getRRSet('ns1.child.example.com', RRType.A)!;
    expect(glue[0].data.type === RRType.A && glue[0].data.address.toString()).toBe('192.0.2.53');
  });

  it('strips comments introduced by a semicolon', () => {
    const zone = parseZoneFile(SAMPLE_ZONE);
    expect(zone.soa.data.serial).toBe(2026070100);
  });

  it('throws ZoneFileError when no $ORIGIN directive and no default is supplied', () => {
    const noOrigin = '@ IN SOA ns1.example.com. hostmaster.example.com. (1 2 3 4 5)\n';
    expect(() => parseZoneFile(noOrigin)).toThrow(ZoneFileError);
  });

  it('accepts an explicit default origin argument when the file has none', () => {
    const noOriginDirective = `@ 3600 IN SOA ns1.example.com. hostmaster.example.com. (
      2026070100 7200 3600 1209600 300 )
www IN A 192.0.2.10
`;
    const zone = parseZoneFile(noOriginDirective, 'example.com');
    expect(zone.origin).toBe('example.com');
    expect(zone.getRRSet('www.example.com', RRType.A)).toHaveLength(1);
  });

  it('throws ZoneFileError for an unrecognized record type', () => {
    const bad = `$ORIGIN example.com.\n@ IN SOA ns1.example.com. hostmaster.example.com. (1 2 3 4 5)\nwww IN BOGUS foo\n`;
    expect(() => parseZoneFile(bad)).toThrow(ZoneFileError);
  });

  it('throws ZoneFileError when a record has no TTL and no $TTL default is in scope', () => {
    const bad = `$ORIGIN example.com.\nwww IN A 192.0.2.10\n@ IN SOA ns1.example.com. hostmaster.example.com. (1 2 3 4 5)\n`;
    expect(() => parseZoneFile(bad)).toThrow(ZoneFileError);
  });
});
