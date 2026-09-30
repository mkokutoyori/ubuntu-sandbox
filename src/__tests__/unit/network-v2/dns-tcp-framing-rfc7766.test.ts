/**
 * Sonde du transport DNS sur flux (RFC 1035 §4.2.2, RFC 7766 §8, RFC 7858 §3.3).
 *
 * Sur TCP (et TLS) chaque message DNS est précédé de sa longueur sur 2 octets ;
 * une connexion sert plusieurs requêtes (RFC 7766 §6.2.1) et un message peut
 * arriver en plusieurs segments.
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 3 cas sur 4 tombent (le fichier DnsStreamFraming, neuf, reste présent).
 *   - la réponse du serveur ne porte pas de préfixe de longueur
 *   - deux requêtes préfixées sur la même connexion : décodage du préfixe comme en-tête, connexion fermée
 *   - une requête fragmentée en deux segments n'est pas réassemblée
 * Passe avant et après (témoin) : le client de transport (queryAuthoritativeServer)
 * obtient sa réponse d'un serveur de même version — le laboratoire est sain.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { Zone } from '@/network/dns/zone/Zone';
import { makeARecord, makeSoaRecord, makeNsRecord } from '@/network/dns/wire/ResourceRecord';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsTcpServer, queryDnsOverTcp } from '@/network/dns/transport/DnsTcpTransport';
import { DnsStreamReader, frameDnsMessage } from '@/network/dns/transport/DnsStreamFraming';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

function query(id: number, qname: string): DnsMessage {
  return {
    id,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false,
      cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

function lab() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'DNS1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  const zone = new Zone('example.com', makeSoaRecord('example.com', 3600, {
    mname: 'ns1.example.com', rname: 'h.example.com', serial: 1, refresh: 7200, retry: 3600,
    expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeNsRecord('example.com', 86400, 'ns1.example.com'));
  zone.addRecord(makeARecord('ns1.example.com', 3600, '192.0.2.1'));
  zone.addRecord(makeARecord('www.example.com', 3600, '192.0.2.10'));
  const store = new ZoneStore();
  store.addZone(zone);
  const auth = new AuthoritativeServer(store);
  bindDnsTcpServer(srv, (q) => auth.answer(q));
  return { pc, srv };
}

async function collect(pc: LinuxPC, payloads: Uint8Array[], expected: number, wait = 400) {
  const socket = await pc.tcpConnect('10.0.1.10', 53);
  const received: Uint8Array[] = [];
  let closed = false;
  socket!.onData((data) => { if (data instanceof Uint8Array) received.push(data); });
  socket!.onClose(() => { closed = true; });
  for (const payload of payloads) socket!.send(payload);
  const started = Date.now();
  while (Date.now() - started < wait) {
    if (received.length >= expected) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  socket!.close();
  return { received, closed };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('DNS sur TCP — préfixe de longueur et connexion persistante', () => {
  it('témoin : le client de transport obtient sa réponse', async () => {
    const { pc } = lab();
    const reply = await queryDnsOverTcp(pc, new IPAddress('10.0.1.10'), query(11, 'www.example.com'));
    expect(reply?.answers).toHaveLength(1);
  });

  it('la réponse est préfixée de sa longueur sur 2 octets', async () => {
    const { pc } = lab();
    const { received } = await collect(
      pc, [frameDnsMessage(encodeDnsMessage(query(21, 'www.example.com')))], 1);
    expect(received).toHaveLength(1);
    const bytes = received[0];
    expect((bytes[0] << 8) | bytes[1]).toBe(bytes.length - 2);
    expect(decodeDnsMessage(bytes.slice(2)).id).toBe(21);
  });

  it('deux requêtes sur la même connexion reçoivent deux réponses, connexion ouverte', async () => {
    const { pc } = lab();
    const two = new Uint8Array([
      ...frameDnsMessage(encodeDnsMessage(query(31, 'www.example.com'))),
      ...frameDnsMessage(encodeDnsMessage(query(32, 'ns1.example.com'))),
    ]);
    const { received, closed } = await collect(pc, [two], 1);
    const ids = new DnsStreamReader().push(
      new Uint8Array(received.flatMap((chunk) => [...chunk]))).map((m) => decodeDnsMessage(m).id);
    expect(ids.sort()).toEqual([31, 32]);
    expect(closed).toBe(false);
  });

  it('une requête fragmentée en deux segments est réassemblée', async () => {
    const { pc } = lab();
    const framed = frameDnsMessage(encodeDnsMessage(query(41, 'www.example.com')));
    const { received } = await collect(pc, [framed.slice(0, 5), framed.slice(5)], 1);
    expect(received).toHaveLength(1);
    expect(decodeDnsMessage(received[0].slice(2)).id).toBe(41);
  });
});
