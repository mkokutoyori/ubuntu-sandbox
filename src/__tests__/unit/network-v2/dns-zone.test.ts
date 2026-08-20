import { describe, it, expect } from 'vitest';
import { Zone, ZoneError } from '@/network/dns/zone/Zone';
import { RRType } from '@/network/dns/wire/RRType';
import { makeARecord, makeNsRecord, makeCnameRecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';

function exampleSoa() {
  return makeSoaRecord('example.com', 3600, {
    mname: 'ns1.example.com', rname: 'hostmaster.example.com',
    serial: 2026070100, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  });
}

function buildZone(): Zone {
  const zone = new Zone('example.com', exampleSoa());
  zone.addRecord(makeNsRecord('example.com', 86400, 'ns1.example.com'));
  zone.addRecord(makeARecord('ns1.example.com', 3600, '192.0.2.1'));
  zone.addRecord(makeARecord('www.example.com', 3600, '192.0.2.10'));
  zone.addRecord(makeCnameRecord('alias.example.com', 3600, 'www.example.com'));
  zone.addRecord(makeCnameRecord('dangling.example.com', 3600, 'nowhere.external.test'));
  zone.addRecord(makeNsRecord('child.example.com', 86400, 'ns1.child.example.com'));
  zone.addRecord(makeARecord('ns1.child.example.com', 3600, '192.0.2.53'));
  return zone;
}

describe('Zone — RFC 1034 §3-4 zone model', () => {
  it('normalizes the origin to lowercase', () => {
    const zone = new Zone('EXAMPLE.com', exampleSoa());
    expect(zone.origin).toBe('example.com');
  });

  it('rejects adding a record whose owner name is outside the zone', () => {
    const zone = buildZone();
    expect(() => zone.addRecord(makeARecord('host.other.test', 3600, '192.0.2.1'))).toThrow(ZoneError);
  });

  it('accepts a record at the apex and at subdomains of the origin', () => {
    const zone = buildZone();
    expect(zone.getRRSet('www.example.com', RRType.A)).toHaveLength(1);
  });

  it('rejects a second SOA record not at the zone apex', () => {
    const zone = buildZone();
    expect(() => zone.addRecord(makeSoaRecord('www.example.com', 3600, {
      mname: 'ns1.example.com', rname: 'hostmaster.example.com',
      serial: 1, refresh: 1, retry: 1, expire: 1, minimum: 1,
    }))).toThrow(ZoneError);
  });

  describe('lookup', () => {
    it('returns a direct answer for an exact name/type match', () => {
      const zone = buildZone();
      const result = zone.lookup('www.example.com', RRType.A);
      expect(result.kind).toBe('answer');
      if (result.kind === 'answer') {
        expect(result.records).toHaveLength(1);
        expect(result.records[0].data.type).toBe(RRType.A);
      }
    });

    it('is case-insensitive on the queried name', () => {
      const zone = buildZone();
      const result = zone.lookup('WWW.Example.COM', RRType.A);
      expect(result.kind).toBe('answer');
    });

    it('returns nodata when the name exists but not for the queried type', () => {
      const zone = buildZone();
      const result = zone.lookup('www.example.com', RRType.MX);
      expect(result.kind).toBe('nodata');
    });

    it('returns nxdomain when the name does not exist in the zone at all', () => {
      const zone = buildZone();
      const result = zone.lookup('ghost.example.com', RRType.A);
      expect(result.kind).toBe('nxdomain');
    });

    it('follows a CNAME chain to a final in-zone answer', () => {
      const zone = buildZone();
      const result = zone.lookup('alias.example.com', RRType.A);
      expect(result.kind).toBe('cname');
      if (result.kind === 'cname') {
        expect(result.chain).toHaveLength(1);
        expect(result.chain[0].data.cname).toBe('www.example.com');
        expect(result.finalRecords).not.toBeNull();
        expect(result.finalRecords![0].data.type).toBe(RRType.A);
      }
    });

    it('returns a null final answer when a CNAME points outside the zone', () => {
      const zone = buildZone();
      const result = zone.lookup('dangling.example.com', RRType.A);
      expect(result.kind).toBe('cname');
      if (result.kind === 'cname') {
        expect(result.finalRecords).toBeNull();
      }
    });

    it('does not follow the CNAME when the query type is CNAME itself', () => {
      const zone = buildZone();
      const result = zone.lookup('alias.example.com', RRType.CNAME);
      expect(result.kind).toBe('answer');
    });

    it('answers NS queries at the apex directly (not a delegation)', () => {
      const zone = buildZone();
      const result = zone.lookup('example.com', RRType.NS);
      expect(result.kind).toBe('answer');
    });

    it('returns a delegation referral for a name at a zone cut', () => {
      const zone = buildZone();
      const result = zone.lookup('child.example.com', RRType.A);
      expect(result.kind).toBe('delegation');
      if (result.kind === 'delegation') {
        expect(result.nsRecords).toHaveLength(1);
        expect(result.nsRecords[0].data.nsdname).toBe('ns1.child.example.com');
      }
    });

    it('returns a delegation referral for names below a zone cut', () => {
      const zone = buildZone();
      const result = zone.lookup('host.child.example.com', RRType.A);
      expect(result.kind).toBe('delegation');
    });
  });
});
