/*
 * Structure — response rate limiting on the DNS role of a Windows server, without the PowerShell layer: the settings the
 * role holds (defaults, a copy on every read, a refusal that changes nothing), the requestors it tells apart over IPv4 and
 * IPv6 (the address masked to IPv4PrefixLength or IPv6PrefixLength, never one family for the other), the queries it leaves
 * alone (an opcode other than QUERY), what LogOnly hands to the analytic sink it was given and what it does when it was
 * given none, and the service restart that forgets every allowance. Time is the role's own clock, set by hand.
 * Discrimination (run on the tree before the change): every case falls, the file cannot even be loaded, the module of
 * the settings did not exist and the role had neither the settings nor the limiter. The exception lists came later: on the
 * tree before them 5 of the 18 cases fall (the five about the lists, which are also what the file cannot load without) and
 * the 13 others pass either way as NON-REGRESSION. The lists became server-level DNS policies (NewPolicy) with the query
 * resolution policies: on the tree before that, the same 5 fall and the same 13 pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { DnsAnalyticEvent } from '@/network/devices/windows/server/dns/DnsAnalyticLog';
import { DEFAULT_RESPONSE_RATE_LIMITING, RESPONSE_RATE_LIMITING_REFUSALS } from '@/network/devices/windows/server/dns/DnsResponseRateLimiting';
import { POLICY_REFUSALS, type NewPolicy, type PolicyCriteriaText } from '@/network/devices/windows/server/dns/DnsPolicies';
import { CLIENT_SUBNET_REFUSALS } from '@/network/devices/windows/server/dns/DnsClientSubnets';
import type { DnsDatagramHandler } from '@/network/dns/transport/DnsUdpTransport';
import { RRType } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { QUERY_ID, SERVER_V6, question, roleLab } from './dnsRoleLab';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

type Verdict = 'answered' | 'truncated' | 'dropped';

const classified = (reply: DnsMessage | null): Verdict => (reply === null ? 'dropped' : reply.flags.tc ? 'truncated' : 'answered');

function lab(options: { sink?: (event: DnsAnalyticEvent) => void } = {}) {
  const { role, ask, advance } = roleLab(options);
  const flood = async (client: number, over: 4 | 6, count: number, qname = 'web.corp.test', opcode: number = DnsOpcode.QUERY): Promise<Verdict[]> => {
    const verdicts: Verdict[] = [];
    for (let index = 0; index < count; index++) verdicts.push(classified(await ask(client, over, question(qname, RRType.A, opcode))));
    return verdicts;
  };
  const send = async (client: number, message: DnsMessage): Promise<Verdict> => classified(await ask(client, 4, message));
  return { role, flood, send, advance };
}

const FIVE: Verdict[] = ['answered', 'answered', 'answered', 'answered', 'answered'];

function exceptionList(name: string, criteria: PolicyCriteriaText, condition: 'AND' | 'OR' = 'AND'): NewPolicy {
  return { name, kind: 'RrlException', action: 'DENY', condition, enabled: true, criteria, content: [] };
}

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
      InterfaceIP: SERVER_V6, Destination: '2001:db8::10', QNAME: 'web.corp.test.', QTYPE: '1', XID: String(QUERY_ID), RCODE: '0',
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

describe('the exception lists of the role', () => {
  it('are held, changed and removed through the role, with the refusals of the policy store', () => {
    const { role } = lab();
    expect(role.addRateLimitingExceptionList(exceptionList('L', { fqdn: 'EQ,a.test' }))).toEqual({ ok: true, message: '' });
    expect(role.addRateLimitingExceptionList(exceptionList('l', { fqdn: 'EQ,b.test' }))).toEqual({ ok: false, message: POLICY_REFUSALS.exists });
    expect(role.changeRateLimitingExceptionList('L', { condition: 'OR', criteria: { serverInterface: 'EQ,10.0.0.3' } })).toEqual({ ok: true, message: '' });
    expect(role.getRateLimitingExceptionLists()).toEqual([{
      name: 'L', kind: 'RrlException', zone: null, action: 'DENY', condition: 'OR', enabled: true, processingOrder: 1, content: [],
      criteria: {
        clientSubnet: null, transportProtocol: null, internetProtocol: null, serverInterface: 'EQ,10.0.0.3', fqdn: 'EQ,a.test',
        queryType: null, timeOfDay: null,
      },
    }]);
    expect(role.changeRateLimitingExceptionList('Nope', { criteria: { fqdn: 'EQ,a.test' } })).toEqual({ ok: false, message: POLICY_REFUSALS.missing });
    expect(role.removeRateLimitingExceptionList('L')).toEqual({ ok: true, message: '' });
    expect(role.removeRateLimitingExceptionList('L')).toEqual({ ok: false, message: POLICY_REFUSALS.missing });
    expect(role.getRateLimitingExceptionLists()).toEqual([]);
  });

  it('keep a client subnet record from being removed while they name it', () => {
    const { role } = lab();
    role.addClientSubnet('Net', ['10.0.1.0/24'], []);
    role.addRateLimitingExceptionList(exceptionList('L', { clientSubnet: 'EQ,Net' }));
    expect(role.removeClientSubnet('Net')).toEqual({ ok: false, message: CLIENT_SUBNET_REFUSALS.referenced });
    expect(role.getClientSubnets()).toHaveLength(1);
    role.removeRateLimitingExceptionList('L');
    expect(role.removeClientSubnet('Net')).toEqual({ ok: true, message: '' });
  });

  it('exempt the clients of an IPv6 client subnet record and not the others', async () => {
    const { role, flood } = lab();
    role.setResponseRateLimiting({ mode: 'Enable', leakRate: 0, truncateRate: 0 });
    role.addClientSubnet('Six', [], ['2001:db8::/64']);
    role.addRateLimitingExceptionList(exceptionList('L', { clientSubnet: 'EQ,Six' }));
    expect(await flood(0, 6, 8)).toEqual(Array.from({ length: 8 }, () => 'answered'));
    expect(await flood(2, 6, 6)).toEqual([...FIVE, 'dropped']);
  });

  it('exempt the queries received on an IPv6 server interface and not those received on the IPv4 one', async () => {
    const { role, flood } = lab();
    role.setResponseRateLimiting({ mode: 'Enable', leakRate: 0, truncateRate: 0 });
    role.addRateLimitingExceptionList(exceptionList('L', { serverInterface: 'EQ,2001:db8::53' }));
    expect(await flood(0, 6, 8)).toEqual(Array.from({ length: 8 }, () => 'answered'));
    expect(await flood(0, 4, 6)).toEqual([...FIVE, 'dropped']);
  });

  it('exempt the queries of the transport their criterion names and no other', async () => {
    const { role, flood } = lab();
    role.setResponseRateLimiting({ mode: 'Enable', leakRate: 0, truncateRate: 0 });
    role.addRateLimitingExceptionList(exceptionList('L', { transportProtocol: 'EQ,TCP' }));
    expect(await flood(0, 4, 6)).toEqual([...FIVE, 'dropped']);
    role.changeRateLimitingExceptionList('L', { criteria: { transportProtocol: 'EQ,UDP' } });
    expect(await flood(1, 4, 8)).toEqual(Array.from({ length: 8 }, () => 'answered'));
  });

  it('do not exempt a message that carries no question under an FQDN criterion', async () => {
    const { role, send } = lab();
    role.setResponseRateLimiting({ mode: 'Enable', leakRate: 0, truncateRate: 0 });
    role.addRateLimitingExceptionList(exceptionList('L', { fqdn: 'EQ,*' }));
    const withoutQuestion = { ...question('web.corp.test'), questions: [] };
    const verdicts: Verdict[] = [];
    for (let index = 0; index < 8; index++) verdicts.push(await send(0, withoutQuestion));
    expect(verdicts).toEqual([...FIVE, 'dropped', 'dropped', 'dropped']);
  });
});
