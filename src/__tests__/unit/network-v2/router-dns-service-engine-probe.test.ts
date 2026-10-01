/**
 * Sonde du serveur DNS des routeurs Cisco/Huawei (table d'hôtes) : il doit
 * répondre par le moteur autoritaire commun (RFC 1034 §4.3, RFC 1035 §4.1.1,
 * RFC 6891) et non par une réponse écrite à la main.
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 5 cas sur 7 tombent.
 *   - un type absent (AAAA) d'un nom connu recevait NXDOMAIN au lieu de NODATA
 *   - une réponse NXDOMAIN ne portait pas de SOA (mise en cache négative impossible)
 *   - un opcode autre que QUERY était traité comme une question
 *   - un message QR=1 reçu recevait une réponse
 *   - l'OPT de la requête n'était pas honoré
 * Passent avant et après (témoins) : une requête A pour un nom connu, et un
 * nom inconnu en NXDOMAIN.
 */
import { describe, it, expect } from 'vitest';
import { RouterDnsService, type DnsTransport } from '@/network/devices/router/dns/RouterDnsService';
import { RouterHostsTable } from '@/network/devices/router/dns/RouterHostsTable';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { makeOptRecord } from '@/network/dns/wire/EdnsOptRecord';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

function rig() {
  const hosts = new RouterHostsTable();
  hosts.upsert('server.lab', '10.0.0.5');
  const sent: DnsMessage[] = [];
  let handler: ((source: string, port: number, payload: unknown) => void) | null = null;
  const transport: DnsTransport = {
    sendQuery: async () => [],
    bind: (_port, onQuery) => { handler = onQuery; return true; },
    unbind: () => { handler = null; },
    reply: (_dst, _port, payload) => { sent.push(decodeDnsMessage(payload as Uint8Array)); },
  };
  const service = new RouterDnsService(
    () => ({ serverEnabled: true } as never), () => hosts, () => transport);
  service.sync();
  const ask = (message: DnsMessage): void => handler!('10.0.0.9', 40000, encodeDnsMessage(message));
  return { ask, sent, service };
}

function query(qname: string, qtype: number, over: Partial<DnsMessage['flags']> = {}, extra: DnsMessage['additionals'] = []): DnsMessage {
  return {
    id: 3,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false,
      cd: false, rcode: DnsRcode.NOERROR, ...over,
    },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: extra,
  };
}

describe('serveur DNS du routeur', () => {
  it('témoin : un A pour un nom connu reçoit son adresse', () => {
    const { ask, sent } = rig();
    ask(query('server.lab', RRType.A));
    expect(sent[0].answers).toHaveLength(1);
  });

  it('témoin : un nom inconnu reçoit NXDOMAIN', () => {
    const { ask, sent } = rig();
    ask(query('ghost.lab', RRType.A));
    expect(sent[0].flags.rcode).toBe(DnsRcode.NXDOMAIN);
  });

  it('un type absent d’un nom connu est NODATA, pas NXDOMAIN', () => {
    const { ask, sent } = rig();
    ask(query('server.lab', RRType.AAAA));
    expect(sent[0].flags.rcode).toBe(DnsRcode.NOERROR);
    expect(sent[0].answers).toHaveLength(0);
  });

  it('NXDOMAIN porte un SOA en autorité', () => {
    const { ask, sent } = rig();
    ask(query('ghost.lab', RRType.A));
    expect(sent[0].authorities.some((rr) => rr.data.type === RRType.SOA)).toBe(true);
  });

  it('un opcode autre que QUERY reçoit NOTIMP', () => {
    const { ask, sent } = rig();
    ask(query('server.lab', RRType.A, { opcode: DnsOpcode.UPDATE }));
    expect(sent[0].flags.rcode).toBe(DnsRcode.NOTIMP);
  });

  it('un message QR=1 n’est pas répondu', () => {
    const { ask, sent } = rig();
    ask(query('server.lab', RRType.A, { qr: true }));
    expect(sent).toHaveLength(0);
  });

  it('l’OPT de la requête est honoré', () => {
    const { ask, sent } = rig();
    ask(query('server.lab', RRType.A, {}, [makeOptRecord(4096)]));
    expect(sent[0].additionals.some((rr) => rr.data.type === RRType.OPT)).toBe(true);
  });
});
