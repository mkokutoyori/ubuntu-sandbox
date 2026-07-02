/**
 * DNS Phase 3 — AuthoritativeServer over the real UDP/TCP transport
 * (RFC 1035 §4.2, §6).
 *
 * Unlike Phases 1-2 (pure codec/zone unit tests), this phase proves the
 * whole stack end-to-end on a real simulated LAN: cabled devices, real
 * ARP/routing, binary-encoded datagrams on the wire, and — the specific
 * behavior this phase adds — TC=1 truncation on UDP with transparent
 * retry over TCP (RFC 1035 §4.2.1), exactly what a real `dig` does.
 *
 * Topology:
 *   PC1 (10.0.1.2/24) ── DNS1 LinuxServer (10.0.1.10/24, UDP+TCP/53)
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
import { makeARecord, makeSoaRecord, makeNsRecord, makeMxRecord } from '@/network/dns/wire/ResourceRecord';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer, queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { bindDnsTcpServer, queryAuthoritativeServer } from '@/network/dns/transport/DnsTcpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

const BIG_RRSET_SIZE = 60;

function exampleSoa() {
  return makeSoaRecord('example.com', 3600, {
    mname: 'ns1.example.com', rname: 'hostmaster.example.com',
    serial: 2026070100, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  });
}

function buildZoneStore(): ZoneStore {
  const zone = new Zone('example.com', exampleSoa());
  zone.addRecord(makeNsRecord('example.com', 86400, 'ns1.example.com'));
  zone.addRecord(makeARecord('ns1.example.com', 3600, '192.0.2.1'));
  zone.addRecord(makeARecord('www.example.com', 3600, '192.0.2.10'));
  zone.addRecord(makeMxRecord('example.com', 3600, 10, 'mail.example.com'));
  zone.addRecord(makeARecord('mail.example.com', 3600, '192.0.2.20'));
  for (let i = 0; i < BIG_RRSET_SIZE; i++) {
    zone.addRecord(makeARecord('big.example.com', 3600, `198.51.100.${i + 1}`));
  }

  const store = new ZoneStore();
  store.addZone(zone);
  return store;
}

function buildTopology(options: { cabled?: boolean } = {}) {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('DNS1');

  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));

  if (options.cabled !== false) {
    new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  }

  const authServer = new AuthoritativeServer(buildZoneStore());
  bindDnsUdpServer(srv, (query) => authServer.answer(query));
  bindDnsTcpServer(srv, (query) => authServer.answer(query));

  return { pc, srv };
}

let nextId = 1;

function makeQuery(qname: string, qtype: number): DnsMessage {
  return {
    id: nextId++,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('AuthoritativeServer over real UDP/53 — nominal path', () => {
  it('answers an A query with a correct binary round-trip and AA=1', async () => {
    const { pc, srv } = buildTopology();

    const response = await queryDnsOverUdp(pc, new IPAddress('10.0.1.10'), makeQuery('www.example.com', RRType.A));

    expect(response).not.toBeNull();
    expect(response!.flags.aa).toBe(true);
    expect(response!.flags.tc).toBe(false);
    expect(response!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(response!.answers).toHaveLength(1);
    expect((response!.answers[0].data as { address: IPAddress }).address.toString()).toBe('192.0.2.10');
    void srv;
  });

  it('answers NXDOMAIN with the SOA in authority for an unknown name', async () => {
    const { pc } = buildTopology();

    const response = await queryDnsOverUdp(pc, new IPAddress('10.0.1.10'), makeQuery('ghost.example.com', RRType.A));

    expect(response).not.toBeNull();
    expect(response!.flags.aa).toBe(true);
    expect(response!.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    expect(response!.answers).toHaveLength(0);
    expect(response!.authorities).toHaveLength(1);
    expect(response!.authorities[0].data.type).toBe(RRType.SOA);
  });

  it('glues the MX exchange address into the additional section', async () => {
    const { pc } = buildTopology();

    const response = await queryDnsOverUdp(pc, new IPAddress('10.0.1.10'), makeQuery('example.com', RRType.MX));

    expect(response!.answers).toHaveLength(1);
    expect(response!.additionals.some((rr) => rr.data.type === RRType.A)).toBe(true);
  });

  it('REFUSES a query for a name outside every hosted zone', async () => {
    const { pc } = buildTopology();

    const response = await queryDnsOverUdp(pc, new IPAddress('10.0.1.10'), makeQuery('unrelated.test', RRType.A));

    expect(response!.flags.aa).toBe(false);
    expect(response!.flags.rcode).toBe(DnsRcode.REFUSED);
  });
});

describe('AuthoritativeServer — TC=1 truncation and TCP retry (RFC 1035 §4.2.1)', () => {
  it('truncates a large RRset over UDP and sets TC=1', async () => {
    const { pc } = buildTopology();

    const response = await queryDnsOverUdp(pc, new IPAddress('10.0.1.10'), makeQuery('big.example.com', RRType.A));

    expect(response).not.toBeNull();
    expect(response!.flags.tc).toBe(true);
    expect(response!.answers.length).toBeLessThan(BIG_RRSET_SIZE);
  });

  it('retries over TCP and returns the full untruncated answer', async () => {
    const { pc } = buildTopology();

    const response = await queryAuthoritativeServer(pc, new IPAddress('10.0.1.10'), makeQuery('big.example.com', RRType.A));

    expect(response).not.toBeNull();
    expect(response!.flags.tc).toBe(false);
    expect(response!.flags.aa).toBe(true);
    expect(response!.answers).toHaveLength(BIG_RRSET_SIZE);
  });

  it('does not fall back to TCP when the UDP answer already fits', async () => {
    const { pc, srv } = buildTopology();

    const response = await queryAuthoritativeServer(pc, new IPAddress('10.0.1.10'), makeQuery('www.example.com', RRType.A));

    expect(response!.answers).toHaveLength(1);
    expect(srv.getTcpStack().listSockets()).toHaveLength(0);
  });
});

describe('AuthoritativeServer — failure realism', () => {
  it('times out over UDP when the server is not cabled', async () => {
    const { pc } = buildTopology({ cabled: false });

    const response = await queryDnsOverUdp(pc, new IPAddress('10.0.1.10'), makeQuery('www.example.com', RRType.A), 53, 200);

    expect(response).toBeNull();
  });

  it('queryAuthoritativeServer times out end-to-end when the server is not cabled', async () => {
    const { pc } = buildTopology({ cabled: false });

    const response = await queryAuthoritativeServer(pc, new IPAddress('10.0.1.10'), makeQuery('big.example.com', RRType.A), { timeoutMs: 200 });

    expect(response).toBeNull();
  });
});
