/**
 * Preuve de non-existence d'un NXDOMAIN signé (RFC 4035 §3.1.3.2, §5.4) :
 * la réponse doit porter le NSEC qui couvre le nom ET celui qui couvre le
 * générique du plus proche ancêtre existant ; le validateur exige les deux.
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 2 cas sur 3 tombent
 * (la réponse ne portait qu'un NSEC ; le validateur acceptait un NXDOMAIN privé
 * de la preuve du générique). Passe avant et après (témoin) : le NSEC qui
 * couvre le nom est bien présent.
 */
import { describe, it, expect } from 'vitest';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { makeARecord, makeSoaRecord, makeNsRecord } from '@/network/dns/wire/ResourceRecord';
import type { NsecRecordData, ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import { generateZoneKey, makeDsForKey } from '@/network/dns/dnssec/DnsKey';
import { signZone } from '@/network/dns/dnssec/DnsSigner';
import { nsecCovers } from '@/network/dns/dnssec/Nsec';
import { DnsValidator } from '@/network/dns/dnssec/DnsValidator';

function signed() {
  const zone = new Zone('example.com', makeSoaRecord('example.com', 3600, {
    mname: 'ns.example.com', rname: 'h.example.com', serial: 1, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeNsRecord('example.com', 3600, 'ns.example.com'));
  zone.addRecord(makeARecord('ns.example.com', 3600, '192.0.2.1'));
  zone.addRecord(makeARecord('m.example.com', 3600, '192.0.2.2'));
  zone.addRecord(makeARecord('z.example.com', 3600, '192.0.2.3'));
  const ksk = generateZoneKey('example.com', 'ksk', 3600);
  signZone(zone, { zsk: generateZoneKey('example.com', 'zsk', 3600), ksk });
  const store = new ZoneStore();
  store.addZone(zone);
  return { zone, store, ksk };
}

const nsecs = (records: readonly ResourceRecord<ResourceRecordData>[]) =>
  records.filter((rr): rr is ResourceRecord<NsecRecordData> => rr.data.type === RRType.NSEC);

describe('NXDOMAIN signé', () => {
  it('témoin : un NSEC couvre le nom demandé', () => {
    const { store } = signed();
    const r = store.answer({ qname: 'q.example.com', qtype: RRType.A, qclass: DnsClass.IN }, { dnssec: true });
    expect(r.rcode).toBe(DnsRcode.NXDOMAIN);
    expect(nsecs(r.authority).some((n) => nsecCovers('q.example.com', n))).toBe(true);
  });

  it('la réponse porte aussi le NSEC qui couvre le générique du plus proche ancêtre', () => {
    const { store } = signed();
    const r = store.answer({ qname: 'q.example.com', qtype: RRType.A, qclass: DnsClass.IN }, { dnssec: true });
    expect(nsecs(r.authority).some((n) => nsecCovers('*.example.com', n))).toBe(true);
  });

  it('le validateur rejette un NXDOMAIN sans la preuve du générique', async () => {
    const { zone, store, ksk } = signed();
    const r = store.answer({ qname: 'q.example.com', qtype: RRType.A, qclass: DnsClass.IN }, { dnssec: true });
    const lookup = async () => ({
      status: 'NOERROR' as const,
      records: [
        ...(zone.getRRSet('example.com', RRType.DNSKEY) ?? []),
        ...(zone.getRRSet('example.com', RRType.RRSIG) ?? []).filter((s) => (s.data as { typeCovered: number }).typeCovered === RRType.DNSKEY),
      ] as ResourceRecord<ResourceRecordData>[],
    });
    const validator = new DnsValidator(lookup, [makeDsForKey('example.com', 0, ksk)]);
    const covering = nsecs(r.authority).find((n) => nsecCovers('q.example.com', n))!;
    const withoutWildcard = r.authority.filter((rr) =>
      rr.data.type !== RRType.NSEC && !(rr.data.type === RRType.RRSIG)
      || rr.name === covering.name);
    expect(await validator.validateNegative('q.example.com', r.authority, true)).toBe('secure');
    expect(await validator.validateNegative('q.example.com', withoutWildcard, true)).toBe('bogus');
  });
});
