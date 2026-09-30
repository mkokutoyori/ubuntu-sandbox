/**
 * Sonde du codec et d'EDNS (RFC 1035 §2.3.4 et §4.1.4, RFC 6891 §6.1, RFC 2181 §9).
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 5 cas sur 10 tombent.
 *   - un nom de plus de 255 octets sur le fil est accepté au décodage
 *   - les options EDNS sont jetées au décodage et jamais écrites (aucun aller-retour)
 *   - deux enregistrements OPT dans une requête ne donnent pas FORMERR (§6.1.1)
 *   - un OPT dont le nom n'est pas la racine ne donne pas FORMERR (§6.1.2)
 *   - TC est posé alors que seules des données additionnelles ont été retirées
 * Passent avant et après (témoins) : boucle de pointeurs de compression rejetée,
 * longueur de données dépassant le message rejetée, enregistrement A de longueur
 * de données 3 rejeté, requête ordinaire avec un
 * OPT simple répond NOERROR avec son OPT, un message valide fait l'aller-retour.
 */

import { describe, it, expect } from 'vitest';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { makeOptRecord } from '@/network/dns/wire/EdnsOptRecord';
import { makeARecord, makeNsRecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import type { OptRecordData } from '@/network/dns/wire/ResourceRecord';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { truncateForUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

function header(id: number, qd: number, an: number, ns: number, ar: number): number[] {
  return [id >> 8, id & 0xff, 0x00, 0x00, 0, qd, 0, an, 0, ns, 0, ar];
}

function nameBytes(labels: readonly string[]): number[] {
  const out: number[] = [];
  for (const label of labels) {
    out.push(label.length);
    for (const ch of label) out.push(ch.charCodeAt(0));
  }
  out.push(0);
  return out;
}

function query(qname = 'www.example.com', extra: DnsMessage['additionals'] = []): DnsMessage {
  return {
    id: 9,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false,
      cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: extra,
  };
}

function server(): AuthoritativeServer {
  const zone = new Zone('example.com', makeSoaRecord('example.com', 3600, {
    mname: 'ns1.example.com', rname: 'h.example.com', serial: 1, refresh: 7200, retry: 3600,
    expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeNsRecord('example.com', 86400, 'ns1.example.com'));
  zone.addRecord(makeARecord('ns1.example.com', 3600, '192.0.2.1'));
  zone.addRecord(makeARecord('www.example.com', 3600, '192.0.2.10'));
  for (let i = 1; i <= 60; i++) zone.addRecord(makeARecord('big.example.com', 3600, `198.51.100.${i}`));
  const store = new ZoneStore();
  store.addZone(zone);
  return new AuthoritativeServer(store);
}

const expectDecodeFails = (bytes: number[]): void => {
  expect(() => decodeDnsMessage(Uint8Array.from(bytes))).toThrow();
};

describe('codec — entrées malformées', () => {
  it('témoin : un message valide fait l’aller-retour', () => {
    const back = decodeDnsMessage(encodeDnsMessage(query()));
    expect(back.questions[0].qname).toBe('www.example.com');
  });

  it('témoin : une boucle de pointeurs de compression est rejetée', () => {
    expectDecodeFails([...header(1, 1, 0, 0, 0), 0xc0, 12, 0, 1, 0, 1]);
  });

  it('témoin : une longueur de données qui dépasse le message est rejetée', () => {
    expectDecodeFails([
      ...header(1, 0, 1, 0, 0), ...nameBytes(['a']), 0, 1, 0, 1, 0, 0, 0, 60, 0, 200, 1, 2, 3, 4,
    ]);
  });

  it('un nom de plus de 255 octets est rejeté', () => {
    const labels = Array.from({ length: 6 }, () => 'a'.repeat(60));
    expectDecodeFails([...header(1, 1, 0, 0, 0), ...nameBytes(labels), 0, 1, 0, 1]);
  });

  it('un enregistrement A dont la longueur de données n’est pas 4 est rejeté', () => {
    expectDecodeFails([
      ...header(1, 0, 1, 0, 0), ...nameBytes(['a']), 0, 1, 0, 1, 0, 0, 0, 60, 0, 3, 1, 2, 3,
    ]);
  });
});

describe('EDNS (RFC 6891)', () => {
  it('les options EDNS font l’aller-retour', () => {
    const opt = makeOptRecord(4096, { options: [{ code: 10, data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) }] });
    const back = decodeDnsMessage(encodeDnsMessage(query('www.example.com', [opt])));
    const data = back.additionals[0].data as OptRecordData;
    expect(data.options).toHaveLength(1);
    expect(data.options?.[0].code).toBe(10);
    expect([...data.options![0].data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('témoin : une requête avec un OPT simple reçoit NOERROR et un OPT', () => {
    const r = server().answer(query('www.example.com', [makeOptRecord(4096)]));
    expect(r.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(r.additionals.some((rr) => rr.data.type === RRType.OPT)).toBe(true);
  });

  it('deux OPT dans une requête donnent FORMERR (§6.1.1)', () => {
    const r = server().answer(query('www.example.com', [makeOptRecord(4096), makeOptRecord(4096)]));
    expect(r.flags.rcode).toBe(DnsRcode.FORMERR);
  });

  it('un OPT dont le nom n’est pas la racine donne FORMERR (§6.1.2)', () => {
    const opt = { ...makeOptRecord(4096), name: 'example.com' };
    const r = server().answer(query('www.example.com', [opt]));
    expect(r.flags.rcode).toBe(DnsRcode.FORMERR);
  });
});

describe('troncature (RFC 2181 §9 : TC seulement si un RRset requis manque)', () => {
  it('TC n’est pas posé quand seules des données additionnelles sont retirées', () => {
    const base = server().answer(query('www.example.com'));
    const padding = Array.from({ length: 40 }, (_, i) => makeARecord(`extra${i}.example.com`, 60, '192.0.2.200'));
    const truncated = truncateForUdp({ ...base, additionals: padding }, 512);
    expect(truncated.answers).toHaveLength(1);
    expect(truncated.flags.tc).toBe(false);
  });
});
