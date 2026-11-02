/*
 * Structure — what the DNS stream transport (RFC 1035 §4.2.2, RFC 7766) hands to a handler and what it takes back: the
 * address of the peer and its port, the address the connection arrived on (a policy keyed on the server interface needs it
 * over TCP as it already has it over UDP), in either family, and a reply that can be absent. A handler that answers null
 * sends no message, closes nothing, and the next query of the same connection is still served: it is how a policy ignores a
 * query over a stream.
 * Discrimination (run on the tree before the change): 5 of 8 cases fall. The three that pass either way are the WITNESS "the
 * lab delivers the reply a handler gives" (the lab itself is sound), the NON-REGRESSION "sends every message of an array
 * reply" and the NON-REGRESSION "hands the handler the source address and port" (the two arguments that existed).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, IPv6Address, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { bindDnsTcpServer, type DnsStreamHandler } from '@/network/dns/transport/DnsTcpTransport';
import { DnsStreamReader, frameDnsMessage } from '@/network/dns/transport/DnsStreamFraming';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

const SERVER_V4 = '10.0.1.10';
const SERVER_V6 = '2001:db8::10';
const CLIENT_V4 = '10.0.1.2';
const CLIENT_V6 = '2001:db8::2';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

function query(id: number): DnsMessage {
  return {
    id,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname: 'www.example.com', qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

function answerTo(request: DnsMessage): DnsMessage {
  return { ...request, flags: { ...request.flags, qr: true, aa: true } };
}

interface Call {
  readonly id: number;
  readonly source: IPAddress | IPv6Address | undefined;
  readonly port: number | undefined;
  readonly destination: IPAddress | IPv6Address | undefined;
}

function lab(reply: (request: DnsMessage) => ReturnType<DnsStreamHandler>) {
  const client = new LinuxPC('linux-pc', 'PC1');
  const server = new LinuxServer('linux-server', 'DNS1');
  client.configureInterface('eth0', new IPAddress(CLIENT_V4), new SubnetMask('255.255.255.0'));
  server.configureInterface('eth0', new IPAddress(SERVER_V4), new SubnetMask('255.255.255.0'));
  client.configureIPv6Interface('eth0', new IPv6Address(CLIENT_V6), 64);
  server.configureIPv6Interface('eth0', new IPv6Address(SERVER_V6), 64);
  new Cable('c1').connect(client.getPort('eth0')!, server.getPort('eth0')!);
  const calls: Call[] = [];
  const directions: string[] = [];
  bindDnsTcpServer(server, (request, source, port, _raw, destination) => {
    calls.push({ id: request.id, source, port, destination });
    return reply(request);
  }, 53, { observer: event => directions.push(event.direction) });
  const converse = async (address: string, ids: readonly number[], expected: number) => {
    const socket = await client.tcpConnect(address, 53);
    const received: Uint8Array[] = [];
    let closed = false;
    socket!.onData(data => { if (data instanceof Uint8Array) received.push(data); });
    socket!.onClose(() => { closed = true; });
    for (const id of ids) socket!.send(frameDnsMessage(encodeDnsMessage(query(id))));
    const started = Date.now();
    while (Date.now() - started < 300 && received.length < expected) await new Promise(resolve => setTimeout(resolve, 10));
    const localPort = socket!.localPort;
    socket!.close();
    const replies = new DnsStreamReader().push(new Uint8Array(received.flatMap(chunk => [...chunk]))).map(raw => decodeDnsMessage(raw).id);
    return { replies, closed, localPort };
  };
  return { calls, directions, converse };
}

describe('what the stream transport hands to the handler', () => {
  it('hands the handler the source address and port', async () => {
    const { calls, converse } = lab(answerTo);
    const { localPort } = await converse(SERVER_V4, [7], 1);
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toEqual(new IPAddress(CLIENT_V4));
    expect(calls[0].port).toBe(localPort);
  });

  it('hands the handler the address the connection arrived on over IPv4', async () => {
    const { calls, converse } = lab(answerTo);
    await converse(SERVER_V4, [7], 1);
    expect(calls[0].destination).toBeInstanceOf(IPAddress);
    expect(calls[0].destination?.toString()).toBe(SERVER_V4);
  });

  it('hands the handler the addresses of a connection made over IPv6 as IPv6 addresses', async () => {
    const { calls, converse } = lab(answerTo);
    await converse(SERVER_V6, [8], 1);
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBeInstanceOf(IPv6Address);
    expect(calls[0].source?.toString()).toBe(CLIENT_V6);
    expect(calls[0].destination).toBeInstanceOf(IPv6Address);
    expect(calls[0].destination?.toString()).toBe(SERVER_V6);
  });
});

describe('a reply that can be absent', () => {
  it('delivers the reply a handler gives', async () => {
    const { converse } = lab(answerTo);
    expect((await converse(SERVER_V4, [11], 1)).replies).toEqual([11]);
  });

  it('sends nothing when the handler answers null, and closes nothing', async () => {
    const { calls, directions, converse } = lab(() => null);
    const { replies, closed } = await converse(SERVER_V4, [12], 1);
    expect(calls.map(call => call.id)).toEqual([12]);
    expect(replies).toEqual([]);
    expect(directions).toEqual(['receive']);
    expect(closed).toBe(false);
  });

  it('sends nothing when the handler answers a promise of null', async () => {
    const { calls, directions, converse } = lab(() => Promise.resolve(null));
    const { replies, closed } = await converse(SERVER_V4, [13], 1);
    expect(calls.map(call => call.id)).toEqual([13]);
    expect(replies).toEqual([]);
    expect(directions).toEqual(['receive']);
    expect(closed).toBe(false);
  });

  it('serves the next query of the connection after one that was ignored', async () => {
    const { calls, directions, converse } = lab(request => (request.id === 21 ? null : answerTo(request)));
    const { replies, closed } = await converse(SERVER_V4, [21, 22], 1);
    expect(calls.map(call => call.id)).toEqual([21, 22]);
    expect(replies).toEqual([22]);
    expect(directions).toEqual(['receive', 'receive', 'send']);
    expect(closed).toBe(false);
  });

  it('sends every message of an array reply', async () => {
    const { converse } = lab(request => [answerTo(request), answerTo({ ...request, id: request.id + 1 })]);
    expect((await converse(SERVER_V4, [31], 2)).replies.sort()).toEqual([31, 32]);
  });
});
