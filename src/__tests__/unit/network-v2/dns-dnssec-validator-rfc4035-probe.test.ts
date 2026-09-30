/**
 * Sonde du validateur DNSSEC (RFC 4035 §5) face à un attaquant qui falsifie
 * ou retire des données signées.
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 5 cas sur 10 tombent.
 *   - un DNSKEY auto-signé par n'importe quelle clé du jeu était accepté : un
 *     attaquant ajoute sa clé au jeu de la zone, le signe avec elle et il est
 *     « secure » parce que la vraie KSK ancrée y figure aussi (§5.2)
 *   - des RRSIG retirés d'une réponse sous une zone sécurisée donnaient
 *     « insecure » au lieu de « bogus » (§5.3, rétrogradation)
 *   - un DS retiré donnait « insecure » sans preuve NSEC signée d'absence de DS
 *   - un NODATA ou NXDOMAIN dont les NSEC sont retirés donnait « insecure »
 *   - le premier RRSIG du jeu décidait seul : un RRSIG d'un algorithme
 *     inconnu placé devant le bon faisait passer « bogus »
 * Passent avant et après (témoins) : une réponse intègre est secure ; une
 * donnée modifiée est bogus ; une délégation non signée prouvée par NSEC est
 * insecure ; hors de toute ancre la réponse est insecure ; un RRSIG dont le signataire
 * n'est pas un ancêtre du propriétaire n'est pas secure (refusé avant par la clé, non par le
 * signataire : non discriminant).
 */
import { describe, it, expect } from 'vitest';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import {
  makeARecord, makeSoaRecord, makeNsRecord, makeRrsigRecord, makeDnskeyRecord,
} from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, ResourceRecordData, RrsigRecordData, DnskeyRecordData } from '@/network/dns/wire/ResourceRecord';
import { generateZoneKey, makeDsForKey } from '@/network/dns/dnssec/DnsKey';
import { signZone, signRRSet, defaultSignatureWindow } from '@/network/dns/dnssec/DnsSigner';
import { DnsValidator, type ChainLookup } from '@/network/dns/dnssec/DnsValidator';
import { normalizeDnsName, parentName } from '@/network/dns/wire/DnsName';

type Rr = ResourceRecord<ResourceRecordData>;
const soa = (origin: string) => makeSoaRecord(origin, 3600, {
  mname: `ns.${origin || 'root'}`, rname: `h.${origin || 'root'}`, serial: 1, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
});

function world() {
  const keys = {
    root: { zsk: generateZoneKey('', 'zsk', 3600), ksk: generateZoneKey('', 'ksk', 3600) },
    com: { zsk: generateZoneKey('com', 'zsk', 3600), ksk: generateZoneKey('com', 'ksk', 3600) },
    ex: { zsk: generateZoneKey('example.com', 'zsk', 3600), ksk: generateZoneKey('example.com', 'ksk', 3600) },
  };
  const root = new Zone('', soa(''));
  root.addRecord(makeNsRecord('', 3600, 'ns.root'));
  root.addRecord(makeNsRecord('com', 3600, 'ns.com'));
  root.addRecord(makeARecord('ns.com', 3600, '10.0.0.3'));
  root.addRecord({ ...makeDsForKey('com', 3600, keys.com.ksk) } as Rr);

  const com = new Zone('com', soa('com'));
  com.addRecord(makeNsRecord('com', 3600, 'ns.com'));
  com.addRecord(makeNsRecord('example.com', 3600, 'ns.example.com'));
  com.addRecord(makeARecord('ns.example.com', 3600, '10.0.0.4'));
  com.addRecord(makeDsForKey('example.com', 3600, keys.ex.ksk) as Rr);
  com.addRecord(makeNsRecord('plain.com', 3600, 'ns.plain.com'));
  com.addRecord(makeARecord('ns.plain.com', 3600, '10.0.0.5'));

  const ex = new Zone('example.com', soa('example.com'));
  ex.addRecord(makeNsRecord('example.com', 3600, 'ns.example.com'));
  ex.addRecord(makeARecord('ns.example.com', 3600, '10.0.0.4'));
  ex.addRecord(makeARecord('www.example.com', 300, '192.0.2.10'));

  const plain = new Zone('plain.com', soa('plain.com'));
  plain.addRecord(makeNsRecord('plain.com', 3600, 'ns.plain.com'));
  plain.addRecord(makeARecord('www.plain.com', 300, '192.0.2.50'));

  signZone(root, keys.root);
  signZone(com, keys.com);
  signZone(ex, keys.ex);

  const store = new ZoneStore();
  [root, com, ex, plain].forEach((z) => store.addZone(z));
  const tamper: { strip?: (name: string, type: number, records: Rr[], authority: Rr[]) => [Rr[], Rr[]] } = {};
  const lookup: ChainLookup = async (qname, qtype) => {
    const name = normalizeDnsName(qname);
    const zone = qtype === RRType.DS ? store.findZone(parentName(name) ?? '') : store.findZone(name);
    const r = store.answer({ qname: name, qtype, qclass: DnsClass.IN }, { dnssec: true });
    void zone;
    let answers = [...r.answers] as Rr[];
    let authority = [...r.authority] as Rr[];
    if (qtype === RRType.DS) {
      const parent = store.findZone(parentName(name) ?? '')!;
      const pr = new ZoneStore();
      pr.addZone(parent);
      const a = pr.answer({ qname: name, qtype, qclass: DnsClass.IN }, { dnssec: true });
      answers = [...a.answers] as Rr[];
      authority = [...a.authority] as Rr[];
    }
    if (tamper.strip) [answers, authority] = tamper.strip(name, qtype, answers, authority);
    return { status: 'NOERROR' as const, records: answers, authorities: authority };
  };
  const validator = () => new DnsValidator(lookup, [makeDsForKey('', 0, keys.root.ksk)]);
  const answerFor = (name: string, type: number) =>
    store.answer({ qname: name, qtype: type, qclass: DnsClass.IN }, { dnssec: true });
  return { keys, store, validator, answerFor, tamper, lookup };
}

const plainAnswer = (): Rr[] => [makeARecord('www.plain.com', 300, '192.0.2.50')];

describe('validateAnswer', () => {
  it('témoin : une réponse intègre sous une chaîne sécurisée est secure', async () => {
    const w = world();
    const a = w.answerFor('www.example.com', RRType.A);
    expect(await w.validator().validateAnswer(a.answers as Rr[], a.authority as Rr[])).toBe('secure');
  });

  it('témoin : une donnée modifiée est bogus', async () => {
    const w = world();
    const a = w.answerFor('www.example.com', RRType.A);
    const forged = (a.answers as Rr[]).map((rr) => rr.data.type === RRType.A ? makeARecord('www.example.com', 300, '6.6.6.6') : rr);
    expect(await w.validator().validateAnswer(forged, [])).toBe('bogus');
  });

  it('témoin : une délégation non signée prouvée par NSEC est insecure', async () => {
    const w = world();
    expect(await w.validator().validateAnswer(plainAnswer(), [])).toBe('insecure');
  });

  it('témoin : hors de toute ancre, la réponse est insecure', async () => {
    const w = world();
    const validator = new DnsValidator(w.lookup, []);
    expect(await validator.validateAnswer(plainAnswer(), [])).toBe('insecure');
  });

  it('des RRSIG retirés d’une réponse de zone sécurisée donnent bogus', async () => {
    const w = world();
    const a = w.answerFor('www.example.com', RRType.A);
    const stripped = (a.answers as Rr[]).filter((rr) => rr.data.type !== RRType.RRSIG);
    expect(await w.validator().validateAnswer(stripped, [])).toBe('bogus');
  });

  it('un DS retiré sans preuve d’absence donne bogus', async () => {
    const w = world();
    w.tamper.strip = (_n, type, answers, authority) => type === RRType.DS
      ? [answers.filter((rr) => rr.data.type !== RRType.DS && rr.data.type !== RRType.RRSIG), authority.filter((rr) => rr.data.type === RRType.SOA)]
      : [answers, authority];
    const a = w.answerFor('www.example.com', RRType.A);
    expect(await w.validator().validateAnswer(a.answers as Rr[], [])).toBe('bogus');
  });

  it('un DNSKEY signé par une clé intruse, ajoutée au jeu de la zone, donne bogus', async () => {
    const w = world();
    const intruder = generateZoneKey('example.com', 'zsk', 3600, undefined, 'intruder');
    w.tamper.strip = (name, type, answers, authority) => {
      if (type !== RRType.DNSKEY || name !== 'example.com') return [answers, authority];
      const keysOnly = answers.filter((rr) => rr.data.type === RRType.DNSKEY);
      const set = [...keysOnly, intruder as Rr];
      const sig = signRRSet(set, 'example.com', intruder, defaultSignatureWindow());
      return [[...set, sig as Rr], authority];
    };
    const a = w.answerFor('www.example.com', RRType.A);
    expect(await w.validator().validateAnswer(a.answers as Rr[], [])).toBe('bogus');
  });

  it('un RRSIG d’algorithme inconnu placé devant le bon n’invalide pas la réponse', async () => {
    const w = world();
    const a = w.answerFor('www.example.com', RRType.A);
    const good = (a.answers as Rr[]).find((rr) => rr.data.type === RRType.RRSIG)!;
    const unknown = makeRrsigRecord('www.example.com', 300, { ...(good.data as RrsigRecordData), algorithm: 250 });
    const set = [(a.answers as Rr[]).find((rr) => rr.data.type === RRType.A)!, unknown as Rr, good];
    expect(await w.validator().validateAnswer(set, [])).toBe('secure');
  });

  it('un RRSIG dont le signataire n’est pas un ancêtre du propriétaire est rejeté', async () => {
    const w = world();
    const a = w.answerFor('www.example.com', RRType.A);
    const record = (a.answers as Rr[]).find((rr) => rr.data.type === RRType.A)!;
    const sig = signRRSet([record], 'plain.com', w.keys.ex.zsk, defaultSignatureWindow());
    expect(await w.validator().validateAnswer([record, sig as Rr], [])).not.toBe('secure');
  });
});

describe('validateNegative', () => {
  it('un NXDOMAIN dont les NSEC sont retirés donne bogus', async () => {
    const w = world();
    const r = w.answerFor('ghost.example.com', RRType.A);
    const stripped = (r.authority as Rr[]).filter((rr) => rr.data.type === RRType.SOA);
    expect(await w.validator().validateNegative('ghost.example.com', stripped, true)).toBe('bogus');
  });
});

void makeDnskeyRecord;
export type { DnskeyRecordData };
