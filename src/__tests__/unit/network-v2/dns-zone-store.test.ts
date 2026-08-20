import { describe, it, expect } from 'vitest';
import { ZoneStore, ZoneStoreError } from '@/network/dns/zone/ZoneStore';
import { parseZoneFile } from '@/network/dns/zone/ZoneFile';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';

const ZONE_TEXT = `
$ORIGIN example.com.
$TTL 3600
@       IN      SOA     ns1.example.com. hostmaster.example.com. (
                            2026070100 7200 3600 1209600 300 )
        IN      NS      ns1.example.com.
ns1     IN      A       192.0.2.1
www     IN      A       192.0.2.10
        IN      A       192.0.2.11
mail    IN      A       192.0.2.20
        IN      MX 10   mail.example.com.
child   IN      NS      ns1.child.example.com.
ns1.child IN    A       192.0.2.53
`;

function buildStore(): ZoneStore {
  const store = new ZoneStore();
  store.addZone(parseZoneFile(ZONE_TEXT));
  return store;
}

describe('ZoneStore — RFC 1034 §3-4 authoritative lookup', () => {
  it('rejects adding two zones with the same origin', () => {
    const store = buildStore();
    expect(() => store.addZone(parseZoneFile(ZONE_TEXT))).toThrow(ZoneStoreError);
  });

  it('finds the zone owning an exact-match name', () => {
    const store = buildStore();
    expect(store.findZone('example.com')?.origin).toBe('example.com');
  });

  it('finds the zone owning a subdomain via longest suffix match', () => {
    const store = buildStore();
    expect(store.findZone('www.example.com')?.origin).toBe('example.com');
  });

  it('returns null when no configured zone covers the name', () => {
    const store = buildStore();
    expect(store.findZone('other.test')).toBeNull();
  });

  it('answers an A query authoritatively with multiple RRs in the RRSet', () => {
    const store = buildStore();
    const result = store.answer({ qname: 'www.example.com', qtype: RRType.A, qclass: DnsClass.IN });
    expect(result.aa).toBe(true);
    expect(result.rcode).toBe(DnsRcode.NOERROR);
    expect(result.answers).toHaveLength(2);
  });

  it('answers an SOA query authoritatively', () => {
    const store = buildStore();
    const result = store.answer({ qname: 'example.com', qtype: RRType.SOA, qclass: DnsClass.IN });
    expect(result.aa).toBe(true);
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].data.type).toBe(RRType.SOA);
  });

  it('answers an MX query and glues the exchange address into the additional section', () => {
    const store = buildStore();
    const result = store.answer({ qname: 'mail.example.com', qtype: RRType.MX, qclass: DnsClass.IN });
    expect(result.aa).toBe(true);
    expect(result.answers).toHaveLength(1);
    expect(result.additional.some(rr => rr.data.type === RRType.A)).toBe(true);
  });

  it('answers an NS query at the apex authoritatively', () => {
    const store = buildStore();
    const result = store.answer({ qname: 'example.com', qtype: RRType.NS, qclass: DnsClass.IN });
    expect(result.aa).toBe(true);
    expect(result.answers).toHaveLength(1);
  });

  it('returns NXDOMAIN with the SOA in authority for a name that does not exist', () => {
    const store = buildStore();
    const result = store.answer({ qname: 'ghost.example.com', qtype: RRType.A, qclass: DnsClass.IN });
    expect(result.aa).toBe(true);
    expect(result.rcode).toBe(DnsRcode.NXDOMAIN);
    expect(result.answers).toHaveLength(0);
    expect(result.authority).toHaveLength(1);
    expect(result.authority[0].data.type).toBe(RRType.SOA);
  });

  it('returns NODATA with the SOA in authority when the name exists but not for that type', () => {
    const store = buildStore();
    const result = store.answer({ qname: 'www.example.com', qtype: RRType.MX, qclass: DnsClass.IN });
    expect(result.aa).toBe(true);
    expect(result.rcode).toBe(DnsRcode.NOERROR);
    expect(result.answers).toHaveLength(0);
    expect(result.authority).toHaveLength(1);
  });

  it('returns a non-authoritative referral with glue for a delegated subzone', () => {
    const store = buildStore();
    const result = store.answer({ qname: 'host.child.example.com', qtype: RRType.A, qclass: DnsClass.IN });
    expect(result.aa).toBe(false);
    expect(result.rcode).toBe(DnsRcode.NOERROR);
    expect(result.answers).toHaveLength(0);
    expect(result.authority).toHaveLength(1);
    expect(result.authority[0].data.type).toBe(RRType.NS);
    expect(result.additional.some(rr => rr.data.type === RRType.A)).toBe(true);
  });

  it('returns REFUSED when no zone in the store covers the queried name', () => {
    const store = buildStore();
    const result = store.answer({ qname: 'unrelated.test', qtype: RRType.A, qclass: DnsClass.IN });
    expect(result.aa).toBe(false);
    expect(result.rcode).toBe(DnsRcode.REFUSED);
    expect(result.answers).toHaveLength(0);
  });
});
