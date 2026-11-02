/*
 * Structure — response rate limiting on the DNS role of a Windows server, without the PowerShell layer: the settings the
 * role holds (defaults, a copy on every read, a refusal that changes nothing), the requestors it tells apart over IPv4 and
 * IPv6 (the address masked to IPv4PrefixLength or IPv6PrefixLength, never one family for the other), the queries it leaves
 * alone (an opcode other than QUERY), what LogOnly hands to the analytic sink it was given and what it does when it was
 * given none, and the service restart that forgets every allowance. Time is the role's own clock, set by hand.
 * Discrimination (run on the tree before the change): every case falls, the file cannot even be loaded, the module of
 * the settings did not exist and the role had neither the settings nor the limiter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, IPv6Address, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { WindowsDnsServerRole } from '@/network/devices/windows/server/dns/WindowsDnsServerRole';
import type { DnsAnalyticEvent } from '@/network/devices/windows/server/dns/DnsAnalyticLog';
import { DEFAULT_RESPONSE_RATE_LIMITING, RESPONSE_RATE_LIMITING_REFUSALS } from '@/network/devices/windows/server/dns/DnsResponseRateLimiting';
import type { EndHost } from '@/network/devices/EndHost';
import { queryDnsOverUdp, type DnsDatagramHandler } from '@/network/dns/transport/DnsUdpTransport';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

const SERVER4 = '10.0.1.10';
const SERVER6 = '2001:db8::53';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

type Verdict = 'answered' | 'truncated' | 'dropped';

function question(qname: string, opcode: number = DnsOpcode.QUERY): DnsMessage {
  return {
    id: 0x5151,
    flags: { qr: false, opcode, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname, qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

function lab(options: { sink?: (event: DnsAnalyticEvent) => void } = {}) {
  let at = 1_700_000_000_000;
  const server = new LinuxPC('linux-pc', 'DNSHOST');
  const clients = [0, 1, 2].map(index => new LinuxPC('linux-pc', `CLIENT${index}`));
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c0').connect(server.getPorts()[0], sw.getPorts()[0]);
  clients.forEach((client, index) => new Cable(`c${index + 1}`).connect(client.getPorts()[0], sw.getPorts()[index + 1]));
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress(SERVER4), mask);
  server.configureIPv6Interface('eth0', new IPv6Address(SERVER6), 48);
  const v4 = ['10.0.1.2', '10.0.1.3', '10.0.1.4'];
  const v6 = ['2001:db8::10', '2001:db8::11', '2001:db8:0:100::10'];
  clients.forEach((client, index) => {
    client.getPorts()[0].configureIP(new IPAddress(v4[index]), mask);
    client.configureIPv6Interface('eth0', new IPv6Address(v6[index]), 48);
  });
  const role = new WindowsDnsServerRole(server as unknown as EndHost, { now: () => at, analytic: options.sink });
  role.addPrimaryZone('corp.test');
  role.addARecord('corp.test', 'web', '10.0.9.1');
  role.start();
  const ask = async (client: number, over: 4 | 6, qname = 'web.corp.test', opcode: number = DnsOpcode.QUERY): Promise<Verdict> => {
    const reply = await queryDnsOverUdp(
      clients[client], over === 4 ? new IPAddress(SERVER4) : new IPv6Address(SERVER6), question(qname, opcode), 53, 40,
    );
    return reply === null ? 'dropped' : reply.flags.tc ? 'truncated' : 'answered';
  };
  const flood = async (client: number, over: 4 | 6, count: number, qname?: string, opcode?: number): Promise<Verdict[]> => {
    const verdicts: Verdict[] = [];
    for (let index = 0; index < count; index++) verdicts.push(await ask(client, over, qname, opcode));
    return verdicts;
  };
  return { role, flood, advance: (milliseconds: number) => { at += milliseconds; } };
}

const FIVE: Verdict[] = ['answered', 'answered', 'answered', 'answered', 'answered'];

describe('the settings the role holds', () => {
  it('start as DNS_RPC_RRL_PARAMS defaults with the mode off', () => {
    expect(lab().role.getResponseRateLimiting()).toEqual(DEFAULT_RESPONSE_RATE_LIMITING);
  });

  it('are handed out as a copy that cannot change them', () => {
    const { role } = lab();
    const copy = role.getResponseRateLimiting() as { mode: string; windowSeconds: number };
    copy.mode = 'Enable';
    copy.windowSeconds = 99;
    expect(role.getResponseRateLimiting()).toEqual(DEFAULT_RESPONSE_RATE_LIMITING);
  });

  it('change on request and report a refusal without changing anything', () => {
    const { role } = lab();
    expect(role.setResponseRateLimiting({ mode: 'LogOnly', windowSeconds: 9 })).toEqual({ ok: true, message: '' });
    expect(role.getResponseRateLimiting()).toMatchObject({ mode: 'LogOnly', windowSeconds: 9 });
    expect(role.setResponseRateLimiting({ windowSeconds: 0, mode: 'Enable' })).toEqual({ ok: false, message: RESPONSE_RATE_LIMITING_REFUSALS.windowSize });
    expect(role.getResponseRateLimiting()).toMatchObject({ mode: 'LogOnly', windowSeconds: 9 });
  });
});

describe('the requestors the role tells apart', () => {
  it('limits the clients of one IPv6 /56 together and not another /56', async () => {
    const { role, flood } = lab();
    role.setResponseRateLimiting({ mode: 'Enable', leakRate: 0, truncateRate: 0 });
    expect(await flood(0, 6, 5)).toEqual(FIVE);
    expect(await flood(1, 6, 2)).toEqual(['dropped', 'dropped']);
    expect(await flood(2, 6, 5)).toEqual(FIVE);
  });

  it('follows IPv6PrefixLength: 128 separates the clients of one /56', async () => {
    const { role, flood } = lab();
    role.setResponseRateLimiting({ mode: 'Enable', ipv6PrefixLength: 128, leakRate: 0, truncateRate: 0 });
    await flood(0, 6, 5);
    expect(await flood(1, 6, 5)).toEqual(FIVE);
  });

  it('never lets an IPv4 client use the allowance of an IPv6 one', async () => {
    const { role, flood } = lab();
    role.setResponseRateLimiting({ mode: 'Enable', ipv4PrefixLength: 0, ipv6PrefixLength: 0, leakRate: 0, truncateRate: 0 });
    await flood(0, 4, 5);
    expect(await flood(0, 4, 1)).toEqual(['dropped']);
    expect(await flood(0, 6, 5)).toEqual(FIVE);
  });
});

describe('the queries the role leaves alone', () => {
  it('does not limit a message whose opcode is not QUERY', async () => {
    const { role, flood } = lab();
    role.setResponseRateLimiting({ mode: 'Enable', leakRate: 0, truncateRate: 0 });
    expect(await flood(0, 4, 9, 'web.corp.test', DnsOpcode.STATUS)).toEqual(Array.from({ length: 9 }, () => 'answered'));
    expect(await flood(0, 4, 6)).toEqual([...FIVE, 'dropped']);
  });
});

describe('a datagram handed to the role without a source address', () => {
  it('is answered and never limited', async () => {
    const { role, flood } = lab();
    role.setResponseRateLimiting({ mode: 'Enable', leakRate: 0, truncateRate: 0 });
    const handle = (role as unknown as { handleUdp: DnsDatagramHandler }).handleUdp;
    for (let attempt = 0; attempt < 8; attempt++) {
      const reply = await handle(question('web.corp.test'));
      expect(reply?.answers).toHaveLength(1);
    }
    expect(await flood(0, 4, 6)).toEqual([...FIVE, 'dropped']);
  });
});

describe('the mode LogOnly', () => {
  it('hands each dropped, truncated and leaked response to the sink with the fields of the event', async () => {
    const events: DnsAnalyticEvent[] = [];
    const { role, flood } = lab({ sink: event => events.push(event) });
    role.setResponseRateLimiting({ mode: 'LogOnly' });
    expect(await flood(0, 6, 9)).toEqual(Array.from({ length: 9 }, () => 'answered'));
    expect(events.map(event => [event.id, event.name])).toEqual([
      [281, 'RRL_TO_BE_DROPPED_RESPONSE'], [282, 'RRL_TO_BE_TRUNCATED_RESPONSE'], [283, 'RRL_TO_BE_LEAKED_RESPONSE'],
      [282, 'RRL_TO_BE_TRUNCATED_RESPONSE'],
    ]);
    expect(events[0].fields).toMatchObject({
      InterfaceIP: SERVER6, Destination: '2001:db8::10', QNAME: 'web.corp.test.', QTYPE: '1', XID: String(0x5151), RCODE: '0',
    });
    expect(Object.keys(events[0].fields)).toEqual([
      'InterfaceIP', 'Destination', 'QNAME', 'QTYPE', 'XID', 'RCODE', 'Port', 'BufferSize', 'PacketData',
    ]);
  });

  it('records the response code and the name of the response it would have dropped', async () => {
    const events: DnsAnalyticEvent[] = [];
    const { role, flood } = lab({ sink: event => events.push(event) });
    role.setResponseRateLimiting({ mode: 'LogOnly' });
    await flood(0, 4, 6, 'Nowhere.corp.test');
    expect(events).toHaveLength(1);
    expect(events[0].fields).toMatchObject({ RCODE: String(DnsRcode.NXDOMAIN), QNAME: 'nowhere.corp.test.', QTYPE: '1' });
  });

  it('answers everything when no sink was given', async () => {
    const { role, flood } = lab();
    role.setResponseRateLimiting({ mode: 'LogOnly' });
    expect(await flood(0, 4, 12)).toEqual(Array.from({ length: 12 }, () => 'answered'));
    role.setResponseRateLimiting({ mode: 'Enable', leakRate: 0, truncateRate: 0 });
    expect(await flood(2, 6, 6)).toEqual([...FIVE, 'dropped']);
  });
});

describe('the service restart', () => {
  it('forgets every allowance', async () => {
    const { role, flood } = lab();
    role.setResponseRateLimiting({ mode: 'Enable', leakRate: 0, truncateRate: 0 });
    await flood(0, 4, 6);
    role.stop();
    role.start();
    expect(await flood(0, 4, 6)).toEqual([...FIVE, 'dropped']);
  });

  it('keeps the allowance across a second of the role clock only as long as a second has not passed', async () => {
    const { role, flood, advance } = lab();
    role.setResponseRateLimiting({ mode: 'Enable', leakRate: 0, truncateRate: 0 });
    await flood(0, 4, 5);
    advance(999);
    expect(await flood(0, 4, 1)).toEqual(['dropped']);
    advance(1);
    expect(await flood(0, 4, 1)).toEqual(['answered']);
  });
});
