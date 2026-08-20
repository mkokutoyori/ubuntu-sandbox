import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IPv6Address, MACAddress, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { makeARecord, makeAaaaRecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer, queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { bindDnsTcpServer, queryAuthoritativeServer } from '@/network/dns/transport/DnsTcpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { AaaaRecordData, ARecordData } from '@/network/dns/wire/ResourceRecord';

let scheduler: VirtualTimeScheduler;
const SERVER = '2001:db8::53';
const CLIENT = '2001:db8::10';
const BIG = 60;

function makeQuery(qname: string, qtype: number, id = 1): DnsMessage {
  return {
    id,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

function buildZoneStore(): ZoneStore {
  const zone = new Zone('example.com', makeSoaRecord('example.com', 3600, {
    mname: 'ns1.example.com', rname: 'hostmaster.example.com',
    serial: 1, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeARecord('www.example.com', 3600, '192.0.2.10'));
  zone.addRecord(makeAaaaRecord('www.example.com', 3600, '2001:db8::abcd'));
  for (let i = 0; i < BIG; i++) {
    zone.addRecord(makeAaaaRecord('big.example.com', 3600, `2001:db8:0:${i.toString(16)}::1`));
  }
  const store = new ZoneStore();
  store.addZone(zone);
  return store;
}

async function warm(pc: LinuxPC, srv: LinuxServer): Promise<void> {
  await pc.executeCommand(`ping6 -c 1 ${SERVER}`);
  await srv.executeCommand(`ping6 -c 1 ${CLIENT}`);
}

function buildLan() {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'DNS6', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(srv.getPort('eth0')!, sw.getPorts()[1]);
  pc.configureIPv6Interface('eth0', new IPv6Address(CLIENT), 64);
  srv.configureIPv6Interface('eth0', new IPv6Address(SERVER), 64);

  const engine = new AuthoritativeServer(buildZoneStore());
  const handler = (q: DnsMessage) => engine.answer(q);
  bindDnsUdpServer(srv, handler);
  bindDnsTcpServer(srv, handler);
  return { pc, srv };
}

beforeEach(() => {
  scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

afterEach(() => {
  __setDefaultScheduler(null);
});

describe('DNS end-to-end over IPv6 (RFC 3596 AAAA on an IPv6 transport)', () => {
  it('resolves an A record from an IPv6 DNS server over UDP6', async () => {
    const { pc, srv } = buildLan();
    await warm(pc, srv);

    const reply = await queryDnsOverUdp(pc, new IPv6Address(SERVER), makeQuery('www.example.com', RRType.A, 11));

    expect(reply).not.toBeNull();
    expect(reply!.flags.aa).toBe(true);
    expect((reply!.answers[0].data as ARecordData).address.toString()).toBe('192.0.2.10');
  });

  it('resolves an AAAA record over UDP6', async () => {
    const built = buildLan();
    await warm(built.pc, built.srv);

    const reply = await queryDnsOverUdp(built.pc, new IPv6Address(SERVER), makeQuery('www.example.com', RRType.AAAA, 12));

    expect((reply!.answers[0].data as AaaaRecordData).address.toString()).toBe('2001:db8::abcd');
  });

  it('falls back to TCP over IPv6 for a truncated oversized AAAA RRset', async () => {
    const built = buildLan();
    await warm(built.pc, built.srv);

    const udpOnly = await queryDnsOverUdp(built.pc, new IPv6Address(SERVER), makeQuery('big.example.com', RRType.AAAA, 13));
    expect(udpOnly!.flags.tc).toBe(true);

    const full = await queryAuthoritativeServer(built.pc, new IPv6Address(SERVER), makeQuery('big.example.com', RRType.AAAA, 14));
    expect(full!.flags.tc).toBe(false);
    expect(full!.answers).toHaveLength(BIG);
  });
});
