/**
 * `queryDnsOverTls` verifiait le certificat du serveur DoT sur `simulationNowMs()` et `bindDnsTlsServer` datait le sien
 * sur la meme heure globale : un client dont l'horloge avait avance de deux ans validait toujours un certificat d'un
 * an. Corrige : le serveur date son certificat sur l'horloge de SA machine et le client le verifie sur celle de la
 * sienne (`TcpStack.nowMs`).
 *
 * Discrimine par `git stash` sur src/network : 1 des 2 cas tombe avant (client en avance). Le TEMOIN (horloges
 * alignees, la reponse arrive) passe des deux cotes et prouve que le laboratoire est sain.
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
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { makeARecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsTlsServer, queryDnsOverTls } from '@/network/dns/transport/DnsTlsTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

const TWO_YEARS = 2 * 365 * 24 * 3600 * 1000;

const query: DnsMessage = {
  id: 7,
  flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
  questions: [{ qname: 'www.example.com', qtype: RRType.A, qclass: DnsClass.IN }],
  answers: [], authorities: [], additionals: [],
};

function lab() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'DNS1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  const zone = new Zone('example.com', makeSoaRecord('example.com', 3600, {
    mname: 'ns1.example.com', rname: 'hostmaster.example.com', serial: 1, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeARecord('www.example.com', 3600, '192.0.2.10'));
  const store = new ZoneStore();
  store.addZone(zone);
  const engine = new AuthoritativeServer(store);
  bindDnsTlsServer(srv, (q: DnsMessage) => engine.answer(q));
  return { pc, srv };
}

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

describe('DNS sur TLS verifie le certificat sur l horloge du client', () => {
  it('TEMOIN — horloges alignees, la reponse arrive', async () => {
    const { pc } = lab();
    const reply = await queryDnsOverTls(pc, new IPAddress('10.0.1.10'), query);
    expect(reply?.answers.length).toBeGreaterThan(0);
  });

  it('un client avance de deux ans refuse le certificat d un an', async () => {
    const { pc } = lab();
    pc._stepSystemClock(TWO_YEARS);
    const reply = await queryDnsOverTls(pc, new IPAddress('10.0.1.10'), query);
    expect(reply).toBeNull();
  });
});
