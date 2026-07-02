import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import {
  makeOptRecord, findOpt, EDNS_BADVERS_EXTENDED_RCODE_HIGH, CLASSIC_UDP_PAYLOAD_SIZE,
} from '@/network/dns/wire/EdnsOptRecord';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { makeARecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer, queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

const BIG_RRSET_SIZE = 60;

function makeQuery(qname: string, qtype: number, edns?: { size: number; version?: number; dnssecOk?: boolean }): DnsMessage {
  return {
    id: 42,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [],
    authorities: [],
    additionals: edns
      ? [makeOptRecord(edns.size, { version: edns.version, dnssecOk: edns.dnssecOk })]
      : [],
  };
}

function buildTopology() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('DNS1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const zone = new Zone('example.com', makeSoaRecord('example.com', 3600, {
    mname: 'ns1.example.com', rname: 'hostmaster.example.com',
    serial: 1, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeARecord('www.example.com', 3600, '192.0.2.10'));
  for (let i = 0; i < BIG_RRSET_SIZE; i++) {
    zone.addRecord(makeARecord('big.example.com', 3600, `198.51.100.${i + 1}`));
  }
  const store = new ZoneStore();
  store.addZone(zone);
  bindDnsUdpServer(srv, (q) => new AuthoritativeServer(store).answer(q));

  return { pc, srv };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('EDNS(0) OPT pseudo-RR — wire format (RFC 6891 §6.1)', () => {
  it('round-trips a message carrying an OPT record', () => {
    const message = makeQuery('www.example.com', RRType.A, { size: 4096, dnssecOk: true });

    const decoded = decodeDnsMessage(encodeDnsMessage(message));

    const opt = findOpt(decoded);
    expect(opt).not.toBeNull();
    expect(opt!.data.udpPayloadSize).toBe(4096);
    expect(opt!.data.version).toBe(0);
    expect(opt!.data.dnssecOk).toBe(true);
    expect(opt!.data.extendedRcodeHigh).toBe(0);
  });

  it('lays out OPT on the wire: root owner, TYPE 41, CLASS = payload size, DO bit in TTL', () => {
    const message = makeQuery('a.b', RRType.A, { size: 1232, dnssecOk: true });

    const bytes = encodeDnsMessage(message);
    const optOffset = bytes.length - 11;

    expect(bytes[optOffset]).toBe(0x00);
    expect((bytes[optOffset + 1] << 8) | bytes[optOffset + 2]).toBe(41);
    expect((bytes[optOffset + 3] << 8) | bytes[optOffset + 4]).toBe(1232);
    expect(bytes[optOffset + 7] & 0x80).toBe(0x80);
    expect((bytes[optOffset + 9] << 8) | bytes[optOffset + 10]).toBe(0);
  });

  it('clamps an advertised payload size below 512 up to 512', () => {
    const opt = makeOptRecord(100);
    expect(opt.data.udpPayloadSize).toBe(CLASSIC_UDP_PAYLOAD_SIZE);
  });
});

describe('EDNS(0) over a real LAN — negotiated UDP payload size', () => {
  it('still truncates at 512 for a client that does not speak EDNS', async () => {
    const { pc } = buildTopology();

    const response = await queryDnsOverUdp(pc, new IPAddress('10.0.1.10'), makeQuery('big.example.com', RRType.A));

    expect(response!.flags.tc).toBe(true);
    expect(encodeDnsMessage(response!).length).toBeLessThanOrEqual(512);
    expect(findOpt(response!)).toBeNull();
  });

  it('returns the full oversized answer over UDP when the client advertises 4096', async () => {
    const { pc } = buildTopology();

    const response = await queryDnsOverUdp(
      pc, new IPAddress('10.0.1.10'), makeQuery('big.example.com', RRType.A, { size: 4096 }),
    );

    expect(response!.flags.tc).toBe(false);
    expect(response!.answers).toHaveLength(BIG_RRSET_SIZE);
    const opt = findOpt(response!);
    expect(opt).not.toBeNull();
    expect(opt!.data.version).toBe(0);
  });

  it('truncates to the advertised size when the client buffer is between 512 and the payload', async () => {
    const { pc } = buildTopology();

    const response = await queryDnsOverUdp(
      pc, new IPAddress('10.0.1.10'), makeQuery('big.example.com', RRType.A, { size: 700 }),
    );

    expect(response!.flags.tc).toBe(true);
    expect(encodeDnsMessage(response!).length).toBeLessThanOrEqual(700);
    expect(response!.answers.length).toBeGreaterThan(0);
    expect(response!.answers.length).toBeLessThan(BIG_RRSET_SIZE);
    expect(findOpt(response!)).not.toBeNull();
  });

  it('answers BADVERS to an unsupported EDNS version', async () => {
    const { pc } = buildTopology();

    const response = await queryDnsOverUdp(
      pc, new IPAddress('10.0.1.10'), makeQuery('www.example.com', RRType.A, { size: 4096, version: 1 }),
    );

    expect(response!.answers).toHaveLength(0);
    const opt = findOpt(response!);
    expect(opt).not.toBeNull();
    expect(opt!.data.extendedRcodeHigh).toBe(EDNS_BADVERS_EXTENDED_RCODE_HIGH);
    expect(response!.flags.rcode).toBe(0);
  });

  it('omits OPT from responses to plain queries', async () => {
    const { pc } = buildTopology();

    const response = await queryDnsOverUdp(pc, new IPAddress('10.0.1.10'), makeQuery('www.example.com', RRType.A));

    expect(response!.answers).toHaveLength(1);
    expect(findOpt(response!)).toBeNull();
  });
});
