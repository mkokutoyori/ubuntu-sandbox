import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { encodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { makeARecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer, queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { deriveSessionKey, encryptBytes, decryptBytes } from '@/network/dns/transport/SimulatedTls';
import { bindDnsTlsServer, queryDnsOverTls, DOT_PORT } from '@/network/dns/transport/DnsTlsTransport';
import { bindDnsHttpsServer, queryDnsOverHttps } from '@/network/dns/transport/DnsHttpsTransport';
import { bindDnsQuicServer, DnsQuicClient } from '@/network/dns/transport/DnsQuicTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

function makeQuery(qname: string, id = 5): DnsMessage {
  return {
    id,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
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
  const store = new ZoneStore();
  store.addZone(zone);
  const engine = new AuthoritativeServer(store);
  const handler = (q: DnsMessage) => engine.answer(q);

  bindDnsUdpServer(srv, handler);
  bindDnsTlsServer(srv, handler);
  bindDnsHttpsServer(srv, handler);
  bindDnsQuicServer(srv, handler);

  return { pc, srv };
}

const SERVER = () => new IPAddress('10.0.1.10');

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('Simulated TLS primitives', () => {
  it('derives the same session key on both sides and round-trips ciphertext', () => {
    const key = deriveSessionKey('client-rand', 'server-rand');
    const plaintext = encodeDnsMessage(makeQuery('www.example.com'));

    const ciphertext = encryptBytes(key, 0, plaintext);
    expect(Uint8Array.from(ciphertext)).not.toEqual(plaintext);
    expect(decryptBytes(key, 0, ciphertext)).toEqual(plaintext);
  });

  it('produces different ciphertext for different sequence numbers', () => {
    const key = deriveSessionKey('a', 'b');
    const plaintext = encodeDnsMessage(makeQuery('www.example.com'));

    expect(encryptBytes(key, 0, plaintext)).not.toEqual(encryptBytes(key, 1, plaintext));
  });
});

describe('DoT — DNS over TLS on TCP/853 (RFC 7858)', () => {
  it('answers with the same semantics as plain UDP', async () => {
    const { pc } = buildTopology();

    const overUdp = await queryDnsOverUdp(pc, SERVER(), makeQuery('www.example.com', 21));
    const overTls = await queryDnsOverTls(pc, SERVER(), makeQuery('www.example.com', 22));

    expect(overTls).not.toBeNull();
    expect(overTls!.flags.aa).toBe(true);
    expect(overTls!.answers).toHaveLength(1);
    expect((overTls!.answers[0].data as { address: IPAddress }).address.toString())
      .toBe((overUdp!.answers[0].data as { address: IPAddress }).address.toString());
  }, 15000);

  it('rejects a client offering the wrong ALPN', async () => {
    const { pc } = buildTopology();

    const reply = await queryDnsOverTls(pc, SERVER(), makeQuery('www.example.com'), { alpn: 'h2', timeoutMs: 500 });

    expect(reply).toBeNull();
  }, 15000);

  it('fails when no DoT listener is bound', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const srv = new LinuxServer('DNS1');
    pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
    srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

    const reply = await queryDnsOverTls(pc, SERVER(), makeQuery('www.example.com'), { timeoutMs: 500 });

    expect(reply).toBeNull();
  }, 15000);

  it('listens on TCP 853 by default', () => {
    const { srv } = buildTopology();
    const listeners = srv.getTcpStack().listListeners().map((l) => l.localPort);
    expect(listeners).toContain(DOT_PORT);
  });
});

describe('DoH — DNS over HTTPS (RFC 8484)', () => {
  it('answers a POST /dns-query carrying application/dns-message', async () => {
    const { pc } = buildTopology();

    const reply = await queryDnsOverHttps(pc, SERVER(), makeQuery('www.example.com', 31));

    expect(reply).not.toBeNull();
    expect(reply!.flags.aa).toBe(true);
    expect((reply!.answers[0].data as { address: IPAddress }).address.toString()).toBe('192.0.2.10');
  }, 15000);

  it('rejects a request for a path other than /dns-query', async () => {
    const { pc } = buildTopology();

    const reply = await queryDnsOverHttps(pc, SERVER(), makeQuery('www.example.com'), {
      path: '/not-dns', timeoutMs: 500,
    });

    expect(reply).toBeNull();
  }, 15000);
});

describe('DoQ — DNS over QUIC on UDP/853 (RFC 9250)', () => {
  it('answers over a QUIC stream with the same semantics as UDP', async () => {
    const { pc } = buildTopology();
    const client = new DnsQuicClient(pc, SERVER());

    const reply = await client.query(makeQuery('www.example.com', 41));

    expect(reply).not.toBeNull();
    expect(reply!.flags.aa).toBe(true);
    expect((reply!.answers[0].data as { address: IPAddress }).address.toString()).toBe('192.0.2.10');
  }, 15000);

  it('opens a new client-initiated bidirectional stream per query', async () => {
    const { pc } = buildTopology();
    const client = new DnsQuicClient(pc, SERVER());

    await client.query(makeQuery('www.example.com', 42));
    const firstStream = client.lastStreamId;
    await client.query(makeQuery('www.example.com', 43));

    expect(firstStream).toBe(0);
    expect(client.lastStreamId).toBe(4);
  }, 15000);

  it('ignores a cleartext DNS datagram sent to the QUIC port', async () => {
    const { pc } = buildTopology();

    const reply = await queryDnsOverUdp(pc, SERVER(), makeQuery('www.example.com'), 853, 400);

    expect(reply).toBeNull();
  }, 15000);
});

describe('Transport parity (PRD Phase 8 exit criterion)', () => {
  it('returns the same answer over UDP, DoT, DoH and DoQ', async () => {
    const { pc } = buildTopology();
    const quic = new DnsQuicClient(pc, SERVER());

    const answers = await Promise.all([
      queryDnsOverUdp(pc, SERVER(), makeQuery('www.example.com', 51)),
      queryDnsOverTls(pc, SERVER(), makeQuery('www.example.com', 52)),
      queryDnsOverHttps(pc, SERVER(), makeQuery('www.example.com', 53)),
      quic.query(makeQuery('www.example.com', 54)),
    ]);

    for (const reply of answers) {
      expect(reply).not.toBeNull();
      expect(reply!.flags.rcode).toBe(DnsRcode.NOERROR);
      expect(reply!.answers).toHaveLength(1);
      expect((reply!.answers[0].data as { address: IPAddress }).address.toString()).toBe('192.0.2.10');
    }
  }, 20000);
});
