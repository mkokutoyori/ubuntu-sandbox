/**
 * PRD-DNS phase 9 (first slice): the living PC DNS path speaks RFC 1035
 * binary on the wire.
 *
 * Before this migration, hosts exchanged JSON "dns-query"/"dns-response"
 * payloads over UDP 53. Now the stub resolver (EndHost, shared by Linux
 * and Windows hosts) and dnsmasq (LinuxMachine) encode/decode real binary
 * DNS messages with the engine codec — so anything sniffing the cable
 * sees actual DNS datagrams, PTR lookups travel as in-addr.arpa QNAMEs,
 * and oversized UDP answers are truncated with TC=1 like a real server.
 *
 * Topology: PC1 (10.0.1.2/24) ── DNS1 LinuxServer (10.0.1.10/24, dnsmasq)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { DnsRcode, DnsOpcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { makeARecord } from '@/network/dns/wire/ResourceRecord';
import type { ARecordData, PtrRecordData } from '@/network/dns/wire/ResourceRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

const SERVER_IP = '10.0.1.10';

function buildTopology() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('DNS1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(SERVER_IP), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  return { pc, srv };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('DNS on the wire is RFC 1035 binary', () => {
  it('the stub resolver emits a binary datagram a raw UDP listener can decode', async () => {
    const { pc, srv } = buildTopology();
    const captured: unknown[] = [];
    srv.getSocketTable().unbind('udp', '127.0.0.53', 53);
    srv.udpBind(53, ({ udp }) => { captured.push(udp.payload); }, 'raw-capture');

    await pc.queryDnsServer(new IPAddress(SERVER_IP), 'webserver', 'A', 50);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toBeInstanceOf(Uint8Array);
    const query = decodeDnsMessage(captured[0] as Uint8Array);
    expect(query.flags.qr).toBe(false);
    expect(query.flags.opcode).toBe(DnsOpcode.QUERY);
    expect(query.flags.rd).toBe(true);
    expect(query.questions).toEqual([
      { qname: 'webserver', qtype: RRType.A, qclass: DnsClass.IN },
    ]);
  });

  it('the stub resolver consumes a binary response crafted with the codec', async () => {
    const { pc, srv } = buildTopology();
    srv.getSocketTable().unbind('udp', '127.0.0.53', 53);
    srv.udpBind(53, ({ sourceIP, udp }) => {
      const query = decodeDnsMessage(udp.payload as Uint8Array);
      const response: DnsMessage = {
        id: query.id,
        flags: {
          qr: true, opcode: DnsOpcode.QUERY, aa: true, tc: false,
          rd: query.flags.rd, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
        },
        questions: query.questions,
        answers: [makeARecord('webserver', 300, '10.0.1.88')],
        authorities: [],
        additionals: [],
      };
      const bytes = encodeDnsMessage(response);
      srv.sendUdpDatagram(sourceIP, udp.sourcePort, 53, bytes, bytes.length);
    }, 'raw-server');

    const reply = await pc.queryDnsServer(new IPAddress(SERVER_IP), 'webserver', 'A', 50);

    expect(reply).not.toBeNull();
    expect(reply!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(reply!.answers).toHaveLength(1);
    expect(reply!.answers[0].name).toBe('webserver');
    expect(reply!.answers[0].ttl).toBe(300);
    expect(reply!.answers[0].data.type).toBe(RRType.A);
    expect((reply!.answers[0].data as ARecordData).address.toString()).toBe('10.0.1.88');
  });

  it('ignores a spoofed response whose transaction id does not match', async () => {
    const { pc, srv } = buildTopology();
    srv.getSocketTable().unbind('udp', '127.0.0.53', 53);
    srv.udpBind(53, ({ sourceIP, udp }) => {
      const query = decodeDnsMessage(udp.payload as Uint8Array);
      const spoofed: DnsMessage = {
        id: (query.id + 1) & 0xffff,
        flags: {
          qr: true, opcode: DnsOpcode.QUERY, aa: false, tc: false,
          rd: true, ra: true, ad: false, cd: false, rcode: DnsRcode.NOERROR,
        },
        questions: query.questions,
        answers: [makeARecord('webserver', 300, '10.66.66.66')],
        authorities: [],
        additionals: [],
      };
      const bytes = encodeDnsMessage(spoofed);
      srv.sendUdpDatagram(sourceIP, udp.sourcePort, 53, bytes, bytes.length);
    }, 'spoofer');

    const reply = await pc.queryDnsServer(new IPAddress(SERVER_IP), 'webserver', 'A', 50);

    expect(reply).toBeNull();
  });
});

describe('dnsmasq answers engine-native binary queries', () => {
  it('interoperates with the DNS engine client (queryDnsOverUdp)', async () => {
    const { pc, srv } = buildTopology();
    srv.dnsService.addRecord({ name: 'webserver', type: 'A', value: '10.0.1.88', ttl: 3600 });
    srv.dnsService.start();

    const query: DnsMessage = {
      id: 0x1234,
      flags: {
        qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
        rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
      },
      questions: [{ qname: 'webserver', qtype: RRType.A, qclass: DnsClass.IN }],
      answers: [],
      authorities: [],
      additionals: [],
    };

    const response = await queryDnsOverUdp(pc, new IPAddress(SERVER_IP), query, 53, 500);

    expect(response).not.toBeNull();
    expect(response!.id).toBe(0x1234);
    expect(response!.flags.qr).toBe(true);
    expect(response!.flags.ra).toBe(true);
    expect(response!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(response!.questions).toEqual(query.questions);
    expect(response!.answers).toHaveLength(1);
    expect(response!.answers[0].data).toMatchObject({ type: RRType.A });
  });

  it('keeps the dnsmasq process name on the bound socket', () => {
    const { srv } = buildTopology();
    srv.dnsService.start();

    const socket = srv.getSocketTable().getAll()
      .find((s) => s.protocol === 'udp' && s.localPort === 53);

    expect(socket?.processName).toBe('dnsmasq');
  });

  it('truncates an oversized UDP answer with TC=1 (RFC 1035 §4.2.1)', async () => {
    const { pc, srv } = buildTopology();
    for (let i = 0; i < 8; i++) {
      srv.dnsService.addRecord({
        name: 'big.example.com', type: 'TXT', value: 'x'.repeat(120) + i, ttl: 3600,
      });
    }
    srv.dnsService.start();

    const query: DnsMessage = {
      id: 7,
      flags: {
        qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
        rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
      },
      questions: [{ qname: 'big.example.com', qtype: RRType.TXT, qclass: DnsClass.IN }],
      answers: [],
      authorities: [],
      additionals: [],
    };

    const response = await queryDnsOverUdp(pc, new IPAddress(SERVER_IP), query, 53, 500);

    expect(response).not.toBeNull();
    expect(response!.flags.tc).toBe(true);
    expect(response!.answers.length).toBeLessThan(8);
    expect(encodeDnsMessage(response!).length).toBeLessThanOrEqual(512);
  });
});

describe('PTR lookups travel as in-addr.arpa QNAMEs', () => {
  it('sends the reversed arpa name on the wire and resolves through dnsmasq', async () => {
    const { pc, srv } = buildTopology();
    srv.dnsService.parseConfig('ptr-record=88.1.0.10.in-addr.arpa,webserver.lan');
    srv.dnsService.start();

    // Sniff what actually goes on the cable by decoding what the PC sends.
    const captured: DnsMessage[] = [];
    const pcSend = pc.sendUdpDatagram.bind(pc);
    pc.sendUdpDatagram = (dst, dport, sport, payload, bytes) => {
      if (dport === 53 && payload instanceof Uint8Array) {
        captured.push(decodeDnsMessage(payload));
      }
      return pcSend(dst, dport, sport, payload, bytes);
    };

    const reply = await pc.queryDnsServer(new IPAddress(SERVER_IP), '10.0.1.88', 'PTR', 500);

    expect(captured).toHaveLength(1);
    expect(captured[0].questions[0]).toEqual({
      qname: '88.1.0.10.in-addr.arpa', qtype: RRType.PTR, qclass: DnsClass.IN,
    });
    expect(reply).not.toBeNull();
    expect(reply!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(reply!.answers[0].data.type).toBe(RRType.PTR);
    expect((reply!.answers[0].data as PtrRecordData).ptrdname).toBe('webserver.lan');
  });
});

describe('unresolvable lookups fail before reaching the wire', () => {
  it('returns null for a name no real resolver could encode', async () => {
    const { pc } = buildTopology();

    const overlongLabel = 'a'.repeat(64) + '.example.com';
    const reply = await pc.queryDnsServer(new IPAddress(SERVER_IP), overlongLabel, 'A', 50);

    expect(reply).toBeNull();
  });

  it('returns null for an unknown query type mnemonic', async () => {
    const { pc } = buildTopology();

    const reply = await pc.queryDnsServer(new IPAddress(SERVER_IP), 'webserver', 'BOGUS', 50);

    expect(reply).toBeNull();
  });
});
