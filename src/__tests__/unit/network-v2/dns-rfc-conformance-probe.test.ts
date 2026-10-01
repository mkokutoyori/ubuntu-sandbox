/**
 * Sonde de conformité du moteur autoritaire DNS (RFC 1034 §4.3.3, RFC 4592,
 * RFC 2308 §3, RFC 1035 §4.1.1, RFC 4035 §5.3.2).
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 6 cas sur 8 tombent.
 *   - générique : *.wild.example.com ne synthétise rien, répond NXDOMAIN
 *   - nœud non terminal vide (b.deep) : NXDOMAIN au lieu de NODATA
 *   - TTL négatif : le SOA de la section autorité garde son TTL (3600) au lieu de
 *     min(TTL du SOA, MINIMUM) = 300
 *   - un message QR=1 reçu sur UDP reçoit une réponse (un serveur doit l'ignorer)
 *   - signature d'un nom synthétisé : le RRSIG du générique n'accompagne pas
 *     la réponse, le validateur la déclarerait "bogus"
 * Passent avant et après (témoins) : le nom existant répond normalement, le
 * NXDOMAIN hors générique reste NXDOMAIN.
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
import {
  makeARecord, makeSoaRecord, makeNsRecord, makeCnameRecord,
} from '@/network/dns/wire/ResourceRecord';
import type { RrsigRecordData } from '@/network/dns/wire/ResourceRecord';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer, queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { generateZoneKey } from '@/network/dns/dnssec/DnsKey';
import { signZone, verifySignature } from '@/network/dns/dnssec/DnsSigner';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { DnskeyRecordData } from '@/network/dns/wire/ResourceRecord';

function lab() {
  const zone = new Zone('example.com', makeSoaRecord('example.com', 3600, {
    mname: 'ns1.example.com', rname: 'h.example.com', serial: 1, refresh: 7200, retry: 3600,
    expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeNsRecord('example.com', 86400, 'ns1.example.com'));
  zone.addRecord(makeARecord('ns1.example.com', 3600, '192.0.2.1'));
  zone.addRecord(makeARecord('*.wild.example.com', 3600, '192.0.2.77'));
  zone.addRecord(makeARecord('exact.wild.example.com', 3600, '192.0.2.78'));
  zone.addRecord(makeARecord('a.b.deep.example.com', 3600, '192.0.2.88'));
  zone.addRecord(makeCnameRecord('alias.example.com', 3600, 'target.other.org'));
  const store = new ZoneStore();
  store.addZone(zone);
  return { zone, store, server: new AuthoritativeServer(store) };
}

let nextId = 1;
function query(qname: string, qtype: number, qr = false): DnsMessage {
  return {
    id: nextId++,
    flags: {
      qr, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false,
      rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('moteur autoritaire — génériques et noms vides', () => {
  it('témoin : un nom existant répond avec son propre enregistrement', () => {
    const r = lab().server.answer(query('exact.wild.example.com', RRType.A));
    expect(r.flags.rcode).toBe(DnsRcode.NOERROR);
    expect((r.answers[0].data as { address: IPAddress }).address.toString()).toBe('192.0.2.78');
  });

  it('synthétise un nom absent depuis le générique, avec le nom demandé comme propriétaire', () => {
    const r = lab().server.answer(query('host.wild.example.com', RRType.A));
    expect(r.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(r.answers).toHaveLength(1);
    expect(r.answers[0].name).toBe('host.wild.example.com');
  });

  it('un générique ne couvre pas un type absent : NODATA', () => {
    const r = lab().server.answer(query('host.wild.example.com', RRType.AAAA));
    expect(r.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(r.answers).toHaveLength(0);
  });

  it('un nœud non terminal vide répond NODATA et non NXDOMAIN', () => {
    const r = lab().server.answer(query('b.deep.example.com', RRType.A));
    expect(r.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(r.answers).toHaveLength(0);
  });

  it('témoin : un nom sous un nœud sans générique reste NXDOMAIN', () => {
    const r = lab().server.answer(query('x.deep.example.com', RRType.A));
    expect(r.flags.rcode).toBe(DnsRcode.NXDOMAIN);
  });
});

describe('moteur autoritaire — TTL négatif (RFC 2308 §3)', () => {
  it('le SOA négatif porte min(TTL du SOA, MINIMUM)', () => {
    const r = lab().server.answer(query('nope.example.com', RRType.A));
    expect(r.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    expect(r.authorities[0].ttl).toBe(300);
  });
});

describe('moteur autoritaire — DNSSEC sur nom synthétisé (RFC 4035 §5.3.2)', () => {
  it('la réponse porte le RRSIG du générique, et il se valide sur le nom synthétisé', () => {
    const { zone, server } = lab();
    const zsk = generateZoneKey('example.com', 'zsk', 3600);
    const ksk = generateZoneKey('example.com', 'ksk', 3600);
    signZone(zone, { zsk, ksk });
    const asked = query('host.wild.example.com', RRType.A);
    const r = server.answer({
      ...asked,
      additionals: [{
        name: '', ttl: 0, rrClass: 4096,
        data: { type: RRType.OPT, version: 0, dnssecOk: true, options: [] },
      } as never],
    });
    const sig = r.answers.find((rr) => rr.data.type === RRType.RRSIG);
    expect(sig).toBeDefined();
    const rrset = r.answers.filter((rr) => rr.data.type === RRType.A);
    const now = Math.floor(Date.now() / 1000);
    expect(verifySignature(
      rrset, sig!.data as RrsigRecordData, zsk.data as DnskeyRecordData, now,
    )).toBe(true);
  });
});

describe('transport UDP — message QR=1 (RFC 1035 §4.1.1)', () => {
  it('un serveur ignore une réponse reçue, mais répond à une question', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const srv = new LinuxServer('linux-server', 'DNS1');
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
    const server = lab().server;
    bindDnsUdpServer(srv, (q) => server.answer(q));

    const witness = await queryDnsOverUdp(
      pc, new IPAddress('10.0.1.10'), query('ns1.example.com', RRType.A), 53, 300);
    expect(witness).not.toBeNull();

    const reflected = await queryDnsOverUdp(
      pc, new IPAddress('10.0.1.10'), query('ns1.example.com', RRType.A, true), 53, 300);
    expect(reflected).toBeNull();
  });
});
