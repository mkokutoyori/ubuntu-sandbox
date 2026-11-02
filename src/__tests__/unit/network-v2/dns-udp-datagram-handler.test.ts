/*
 * Structure — the handler of a DNS server on UDP may decline to answer: when it returns nothing (null, or a promise of
 * null) no datagram is sent and no 'send' event is observed, while the query itself is still observed as received; when it
 * returns a message the message is sent. The handler is told the address the datagram was addressed to, as its fifth
 * argument, after the source address, the source port and the raw payload. Discrimination (run on the tree before the
 * change): 4 of 5 cases fall, the two that return null at once, the one that returns a promise of null (the reply built
 * from nothing threw inside a detached promise: nothing was sent, but a rejection was left behind, which the case reads
 * through the unhandledRejection event) and the one about the addresses (the fifth argument was never passed). The case of
 * the answers is the WITNESS that the lab delivers queries and replies.
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
import { bindDnsUdpServer, queryDnsOverUdp, type DnsDatagramHandler } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsPacketEvent } from '@/network/dns/transport/DnsPacketObserver';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

const SERVER = '10.0.1.10';
const CLIENT = '10.0.1.2';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

function question(id: number): DnsMessage {
  return {
    id,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname: 'web.corp.test', qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

function reply(query: DnsMessage): DnsMessage {
  return { ...query, flags: { ...query.flags, qr: true, aa: true }, answers: [], authorities: [], additionals: [] };
}

function lab(handler: DnsDatagramHandler) {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const server = new LinuxServer('linux-server', 'DNS1');
  const mask = new SubnetMask('255.255.255.0');
  pc.configureInterface('eth0', new IPAddress(CLIENT), mask);
  server.configureInterface('eth0', new IPAddress(SERVER), mask);
  new Cable('c1').connect(pc.getPort('eth0')!, server.getPort('eth0')!);
  const events: DnsPacketEvent[] = [];
  bindDnsUdpServer(server, handler, 53, 'dns', undefined, undefined, {}, event => events.push(event));
  const ask = (id: number, timeoutMs = 40) => queryDnsOverUdp(pc, new IPAddress(SERVER), question(id), 53, timeoutMs);
  return { ask, events };
}

describe('a handler that declines to answer', () => {
  it('sends nothing when it returns null, and the query is still observed as received', async () => {
    const { ask, events } = lab(() => null);
    expect(await ask(1)).toBeNull();
    expect(events.map(event => event.direction)).toEqual(['receive']);
  });

  it('sends nothing when it returns a promise of null, and leaves no rejection behind', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      const { ask, events } = lab(() => Promise.resolve(null));
      expect(await ask(2)).toBeNull();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(events.map(event => event.direction)).toEqual(['receive']);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
  });

  it('declines one query and answers the next', async () => {
    const { ask, events } = lab(query => (query.id === 3 ? null : reply(query)));
    expect(await ask(3)).toBeNull();
    expect((await ask(4))?.id).toBe(4);
    expect(events.map(event => event.direction)).toEqual(['receive', 'receive', 'send']);
  });
});

describe('a handler that answers', () => {
  it('WITNESS: sends the message it returns, synchronously or in a promise', async () => {
    const synchronous = lab(query => reply(query));
    expect((await synchronous.ask(5))?.id).toBe(5);
    const asynchronous = lab(query => Promise.resolve(reply(query)));
    expect((await asynchronous.ask(6))?.id).toBe(6);
  });
});

describe('what the handler is told', () => {
  it('receives the source address and port, the raw datagram and the address the datagram was sent to', async () => {
    const seen: Array<{ source: string; port: number; size: number; destination: string }> = [];
    const { ask } = lab((query, source, port, raw, destination) => {
      seen.push({ source: String(source), port: port ?? 0, size: raw?.length ?? 0, destination: String(destination) });
      return reply(query);
    });
    await ask(7);
    expect(seen).toHaveLength(1);
    expect(seen[0].source).toBe(CLIENT);
    expect(seen[0].destination).toBe(SERVER);
    expect(seen[0].port).toBeGreaterThan(1023);
    expect(seen[0].size).toBeGreaterThan(12);
  });
});
