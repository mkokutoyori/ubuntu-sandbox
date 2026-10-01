/**
 * Sonde de la mise à jour dynamique DNS (RFC 2136 §3.2, §3.4.1, §3.4.2).
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 9 cas sur 12 tombent :
 * prérequis dépendant de la valeur jugé sur un seul enregistrement au lieu du
 * RRset entier (§3.2.3), classes étrangères acceptées (§3.2.3, §3.4.1), TTL non nul
 * accepté sur une suppression de classe NONE (§3.4.1.3), règles CNAME et SOA
 * ignorées (§3.4.2.2), NS du sommet protégés en bloc au lieu de « le dernier »
 * (§3.4.2.4).
 * Passent avant et après : le prérequis qui liste tout le RRset, l'ajout
 * ordinaire (témoins du laboratoire) et l'ajout de type ANY, refusé dès avant mais
 * parce que son RDATA est vide, non parce que le type est méta (non discriminant).
 */

import { describe, it, expect } from 'vitest';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { Zone } from '@/network/dns/zone/Zone';
import {
  makeARecord, makeSoaRecord, makeNsRecord, makeCnameRecord, makeEmptyRecord,
} from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import { evaluateUpdate } from '@/network/dns/update/UpdateResponder';
import { buildUpdateMessage, readUpdateMessage, DnsUpdateFormatError } from '@/network/dns/update/DnsUpdate';
import type { DnsUpdateRequest } from '@/network/dns/update/DnsUpdate';

function soa(serial: number) {
  return makeSoaRecord('example.com', 3600, {
    mname: 'ns1.example.com', rname: 'h.example.com', serial, refresh: 7200, retry: 3600,
    expire: 1209600, minimum: 300,
  });
}

function zoneWith(): Zone {
  const zone = new Zone('example.com', soa(100));
  zone.addRecord(makeNsRecord('example.com', 86400, 'ns1.example.com'));
  zone.addRecord(makeNsRecord('example.com', 86400, 'ns2.example.com'));
  zone.addRecord(makeARecord('multi.example.com', 300, '192.0.2.1'));
  zone.addRecord(makeARecord('multi.example.com', 300, '192.0.2.2'));
  zone.addRecord(makeCnameRecord('alias.example.com', 300, 'multi.example.com'));
  return zone;
}

function request(over: Partial<DnsUpdateRequest>): DnsUpdateRequest {
  return { zone: 'example.com', zoneClass: DnsClass.IN, prerequisites: [], updates: [], ...over };
}

function apply(zone: Zone, req: DnsUpdateRequest) {
  const verdict = evaluateUpdate(zone, req);
  if (verdict.rcode !== DnsRcode.NOERROR) return verdict;
  for (const rr of verdict.applied!.removals) zone.removeRecord(rr);
  for (const rr of verdict.applied!.additions) zone.addRecord(rr);
  if (verdict.applied!.soa) zone.updateSoa(verdict.applied!.soa);
  return verdict;
}

function wireFormerr(mutate: (records: ResourceRecord<ResourceRecordData>[]) => void, where: 'answers' | 'authorities'): boolean {
  const message = buildUpdateMessage(request({}), 1);
  const list = [...message[where]];
  mutate(list);
  try {
    readUpdateMessage({ ...message, [where]: list });
    return false;
  } catch (error) {
    return error instanceof DnsUpdateFormatError;
  }
}

describe('RFC 2136 §3.2.5 — prérequis dépendant de la valeur', () => {
  it('témoin : un prérequis qui liste tout le RRset est satisfait', () => {
    const zone = zoneWith();
    const v = evaluateUpdate(zone, request({
      prerequisites: [
        { kind: 'rrset-exists-value', record: makeARecord('multi.example.com', 0, '192.0.2.1') },
        { kind: 'rrset-exists-value', record: makeARecord('multi.example.com', 0, '192.0.2.2') },
      ],
    }));
    expect(v.rcode).toBe(DnsRcode.NOERROR);
  });

  it('un prérequis qui ne liste qu’une partie du RRset échoue en NXRRSET', () => {
    const zone = zoneWith();
    const v = evaluateUpdate(zone, request({
      prerequisites: [
        { kind: 'rrset-exists-value', record: makeARecord('multi.example.com', 0, '192.0.2.1') },
      ],
    }));
    expect(v.rcode).toBe(8);
  });
});

describe('RFC 2136 §3.4.1 — prétraitement du message', () => {
  it('un prérequis dont la classe n’est ni ANY, ni NONE, ni celle de la zone est FORMERR', () => {
    expect(wireFormerr((list) => {
      list.push({ ...makeARecord('multi.example.com', 0, '192.0.2.1'), rrClass: DnsClass.CH });
    }, 'answers')).toBe(true);
  });

  it('une mise à jour dont la classe n’est ni ANY, ni NONE, ni celle de la zone est FORMERR', () => {
    expect(wireFormerr((list) => {
      list.push({ ...makeARecord('new.example.com', 300, '192.0.2.9'), rrClass: DnsClass.CH });
    }, 'authorities')).toBe(true);
  });

  it('un ajout de type méta (ANY) est FORMERR', () => {
    expect(wireFormerr((list) => {
      list.push(makeEmptyRecord('new.example.com', RRType.ANY, DnsClass.IN));
    }, 'authorities')).toBe(true);
  });

  it('une suppression de classe NONE avec TTL non nul est FORMERR', () => {
    expect(wireFormerr((list) => {
      list.push({ ...makeARecord('multi.example.com', 300, '192.0.2.1'), rrClass: 254 });
    }, 'authorities')).toBe(true);
  });
});

describe('RFC 2136 §3.4.2.2 — ajouts ignorés', () => {
  it('témoin : un ajout ordinaire est appliqué', () => {
    const zone = zoneWith();
    apply(zone, request({ updates: [{ kind: 'add', record: makeARecord('new.example.com', 300, '192.0.2.9') }] }));
    expect(zone.getRRSet('new.example.com', RRType.A)).toHaveLength(1);
  });

  it('un CNAME n’est pas ajouté à un nom qui porte déjà d’autres données', () => {
    const zone = zoneWith();
    apply(zone, request({ updates: [{ kind: 'add', record: makeCnameRecord('multi.example.com', 300, 'x.example.com') }] }));
    expect(zone.getRRSet('multi.example.com', RRType.CNAME)).toBeUndefined();
  });

  it('une donnée n’est pas ajoutée à un nom qui porte un CNAME', () => {
    const zone = zoneWith();
    apply(zone, request({ updates: [{ kind: 'add', record: makeARecord('alias.example.com', 300, '192.0.2.9') }] }));
    expect(zone.getRRSet('alias.example.com', RRType.A)).toBeUndefined();
  });

  it('un SOA d’ajout de série inférieure est ignoré, un SOA de série supérieure remplace', () => {
    const zone = zoneWith();
    apply(zone, request({ updates: [{ kind: 'add', record: soa(50) }] }));
    expect(zone.soa.data.serial).toBe(100);
    expect(zone.getRRSet('example.com', RRType.SOA)).toHaveLength(1);
    apply(zone, request({ updates: [{ kind: 'add', record: soa(200) }] }));
    expect(zone.soa.data.serial).toBe(200);
    expect(zone.getRRSet('example.com', RRType.SOA)).toHaveLength(1);
  });
});

describe('RFC 2136 §3.4.2.4 — suppressions au sommet', () => {
  it('un NS du sommet peut être supprimé tant qu’il en reste un', () => {
    const zone = zoneWith();
    apply(zone, request({ updates: [{ kind: 'delete-record', record: makeNsRecord('example.com', 0, 'ns2.example.com') }] }));
    expect(zone.getRRSet('example.com', RRType.NS)).toHaveLength(1);
  });

  it('le dernier NS du sommet n’est jamais supprimé', () => {
    const zone = zoneWith();
    apply(zone, request({ updates: [
      { kind: 'delete-record', record: makeNsRecord('example.com', 0, 'ns1.example.com') },
      { kind: 'delete-record', record: makeNsRecord('example.com', 0, 'ns2.example.com') },
    ] }));
    expect(zone.getRRSet('example.com', RRType.NS)).toHaveLength(1);
  });
});
