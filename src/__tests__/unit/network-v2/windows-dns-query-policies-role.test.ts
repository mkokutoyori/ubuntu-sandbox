/*
 * Structure — query resolution policies on the DNS role of a Windows server, without the PowerShell layer, over real UDP and
 * TCP exchanges in both families: a server-level policy that DENYs answers REFUSED and one that IGNOREs answers nothing (over a
 * stream as over a datagram); each of the seven criteria decides on its own fact (the requestor against a client subnet record,
 * the transport, the family of the requestor, the address of the server interface the query came in on, the name asked, the
 * type asked, the minute of the day on the clock of the role read in its time zone); AND and OR combine the criteria; the first
 * enabled policy in processing order that holds is the one that decides, and a disabled policy is skipped; a zone-level policy
 * governs the names of its zone only, after the server-level ones, and an ALLOW ends the search; a recursion policy decides
 * for the names the server would resolve and not for the ones its cache already holds; messages that are not queries (a zone
 * transfer) are not governed by them; removing a zone removes its policies.
 * Discrimination (run on the tree before the change): 32 of 34 cases fall, the role had no policy to add. The two that pass
 * either way are the WITNESSES "answers every query while no policy exists" and "resolves the name of another zone through
 * the forwarder while no policy exists": they prove the lab answers and resolves, so that every refusal and every silence the
 * other cases observe comes from a policy.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { POLICY_REFUSALS, type NewPolicy, type PolicyAction, type PolicyCriteriaText } from '@/network/devices/windows/server/dns/DnsPolicies';
import { RRType } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { SERVER_V4, SERVER_V6, question, roleLab, verdictOf, type Verdict } from './dnsRoleLab';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const WEB = 'web.corp.test';
const MAIL = 'mail.corp.test';
const ZONE_MISSING = 'Zone "nope.test" does not exist on this server.';

function policy(name: string, action: PolicyAction, criteria: PolicyCriteriaText, extra: Partial<NewPolicy> = {}): NewPolicy {
  return { name, kind: 'QueryProcessing', action, condition: 'AND', enabled: true, criteria, content: [], ...extra };
}

const deny = (name: string, criteria: PolicyCriteriaText, extra: Partial<NewPolicy> = {}) => policy(name, 'DENY', criteria, extra);

const ignore = (name: string, criteria: PolicyCriteriaText, extra: Partial<NewPolicy> = {}) => policy(name, 'IGNORE', criteria, extra);

async function served(options: Parameters<typeof roleLab>[0] = {}) {
  const context = roleLab(options);
  context.role.addARecord('corp.test', 'mail', '10.0.9.3');
  const verdict = async (
    name: string, client = 0, over: 4 | 6 = 4, transport: 'udp' | 'tcp' = 'udp', qtype: number = RRType.A,
  ): Promise<Verdict> => verdictOf(await context.ask(client, over, question(name, qtype), transport));
  return { ...context, verdict };
}

describe('a server-level policy', () => {
  it('answers every query while no policy exists', async () => {
    const { verdict } = await served();
    expect([await verdict(WEB), await verdict(MAIL), await verdict(WEB, 0, 6), await verdict(WEB, 0, 4, 'tcp')]).toEqual(Array(4).fill('answered'));
  });

  it('answers REFUSED to the query it denies and leaves the other names alone', async () => {
    const { role, verdict } = await served();
    expect(role.addQueryResolutionPolicy(null, deny('P', { fqdn: `EQ,${WEB}` }))).toEqual({ ok: true, message: '' });
    expect([await verdict(WEB), await verdict(MAIL)]).toEqual(['refused', 'answered']);
  });

  it('answers the refusal as a response to the question, not as an authority', async () => {
    const { role, ask } = await served();
    role.addQueryResolutionPolicy(null, deny('P', { fqdn: `EQ,${WEB}` }));
    const reply = await ask(0, 4, question(WEB));
    expect(reply?.flags).toMatchObject({ qr: true, aa: false, rcode: DnsRcode.REFUSED });
    expect(reply?.id).toBe(question(WEB).id);
    expect(reply?.questions).toEqual(question(WEB).questions);
    expect(reply?.answers).toEqual([]);
  });

  it('answers nothing to the query it ignores, over a datagram and over a stream', async () => {
    const { role, verdict } = await served();
    role.addQueryResolutionPolicy(null, ignore('P', { fqdn: `EQ,${WEB}` }));
    expect([await verdict(WEB), await verdict(WEB, 0, 4, 'tcp'), await verdict(WEB, 0, 6)]).toEqual(['dropped', 'dropped', 'dropped']);
    expect([await verdict(MAIL), await verdict(MAIL, 0, 4, 'tcp')]).toEqual(['answered', 'answered']);
  });

  it('applies to the next query as soon as it is added and no longer once it is removed', async () => {
    const { role, verdict } = await served();
    expect(await verdict(WEB)).toBe('answered');
    role.addQueryResolutionPolicy(null, deny('P', { fqdn: `EQ,${WEB}` }));
    expect(await verdict(WEB)).toBe('refused');
    role.removeQueryResolutionPolicy(null, 'P');
    expect(await verdict(WEB)).toBe('answered');
  });
});

describe('the seven criteria', () => {
  it('ClientSubnet EQ holds for the requestors inside the record, over both families', async () => {
    const { role, verdict } = await served();
    role.addClientSubnet('Lan', ['10.0.1.2/31'], ['2001:db8::/64']);
    role.addQueryResolutionPolicy(null, deny('P', { clientSubnet: 'EQ,Lan' }));
    expect([await verdict(WEB, 0), await verdict(WEB, 1), await verdict(WEB, 2)]).toEqual(['refused', 'refused', 'answered']);
    expect([await verdict(WEB, 0, 6), await verdict(WEB, 1, 6), await verdict(WEB, 2, 6)]).toEqual(['refused', 'refused', 'answered']);
  });

  it('ClientSubnet NE holds for the requestors outside the record', async () => {
    const { role, verdict } = await served();
    role.addClientSubnet('Lan', ['10.0.1.2/31'], ['2001:db8::/64']);
    role.addQueryResolutionPolicy(null, deny('P', { clientSubnet: 'NE,Lan' }));
    expect([await verdict(WEB, 0), await verdict(WEB, 1), await verdict(WEB, 2)]).toEqual(['answered', 'answered', 'refused']);
  });

  it('TransportProtocol decides on the transport of the query', async () => {
    const { role, verdict } = await served();
    role.addQueryResolutionPolicy(null, deny('P', { transportProtocol: 'EQ,TCP' }));
    expect([await verdict(WEB), await verdict(WEB, 0, 4, 'tcp'), await verdict(WEB, 0, 6, 'tcp')]).toEqual(['answered', 'refused', 'refused']);
  });

  it('InternetProtocol decides on the family of the requestor', async () => {
    const { role, verdict } = await served();
    role.addQueryResolutionPolicy(null, deny('P', { internetProtocol: 'EQ,IPv6' }));
    expect([await verdict(WEB, 0, 4), await verdict(WEB, 0, 6), await verdict(WEB, 0, 6, 'tcp'), await verdict(WEB, 0, 4, 'tcp')])
      .toEqual(['answered', 'refused', 'refused', 'answered']);
  });

  it('ServerInterfaceIP decides on the address the query came in on', async () => {
    const { role, verdict } = await served();
    role.addQueryResolutionPolicy(null, deny('P', { serverInterface: `EQ,${SERVER_V6}` }));
    expect([await verdict(WEB, 0, 6), await verdict(WEB, 0, 4), await verdict(WEB, 0, 6, 'tcp'), await verdict(WEB, 0, 4, 'tcp')])
      .toEqual(['refused', 'answered', 'refused', 'answered']);
    role.changeQueryResolutionPolicy(null, 'P', { criteria: { serverInterface: `EQ,${SERVER_V4}` } });
    expect([await verdict(WEB, 0, 6), await verdict(WEB, 0, 4)]).toEqual(['answered', 'refused']);
  });

  it('Fqdn decides on the name asked, a wildcard covering the name and everything below it', async () => {
    const { role, verdict } = await served();
    role.addQueryResolutionPolicy(null, deny('P', { fqdn: 'EQ,*.corp.test' }));
    expect([await verdict(WEB), await verdict('WEB.Corp.TEST'), await verdict('corp.test')]).toEqual(['refused', 'refused', 'refused']);
    role.changeQueryResolutionPolicy(null, 'P', { criteria: { fqdn: `NE,${MAIL}` } });
    expect([await verdict(WEB), await verdict(MAIL)]).toEqual(['refused', 'answered']);
  });

  it('QType decides on the type asked', async () => {
    const { role, verdict } = await served();
    role.addQueryResolutionPolicy(null, deny('P', { queryType: 'EQ,AAAA' }));
    expect([await verdict(WEB, 0, 4, 'udp', RRType.A), await verdict(WEB, 0, 4, 'udp', RRType.AAAA), await verdict(WEB, 0, 4, 'tcp', RRType.AAAA)])
      .toEqual(['answered', 'refused', 'refused']);
    role.changeQueryResolutionPolicy(null, 'P', { criteria: { queryType: 'NE,A' } });
    expect([await verdict(WEB, 0, 4, 'udp', RRType.A), await verdict(WEB, 0, 4, 'udp', RRType.MX)]).toEqual(['answered', 'refused']);
  });

  it('TimeOfDay decides on the minute of the day of the role clock, inclusive at both ends', async () => {
    const { role, verdict, setClock } = await served();
    role.addQueryResolutionPolicy(null, deny('P', { timeOfDay: 'EQ,22:00-23:00' }));
    const at = (hour: number, minute: number) => setClock(Date.UTC(2024, 5, 3, hour, minute, 30));
    const seen: Verdict[] = [];
    for (const [hour, minute] of [[21, 59], [22, 0], [22, 30], [23, 0], [23, 1]]) {
      at(hour, minute);
      seen.push(await verdict(WEB));
    }
    expect(seen).toEqual(['answered', 'refused', 'refused', 'refused', 'answered']);
  });

  it('TimeOfDay reads the clock in the time zone of the role', async () => {
    const { role, verdict, setClock, setZone } = await served();
    setClock(Date.UTC(2024, 5, 3, 22, 30, 0));
    role.addQueryResolutionPolicy(null, deny('P', { timeOfDay: 'EQ,22:00-23:00' }));
    expect(await verdict(WEB)).toBe('refused');
    setZone('Asia/Tokyo');
    expect(await verdict(WEB)).toBe('answered');
    role.changeQueryResolutionPolicy(null, 'P', { criteria: { timeOfDay: 'EQ,07:00-08:00' } });
    expect(await verdict(WEB)).toBe('refused');
    setZone('America/New_York');
    expect(await verdict(WEB)).toBe('answered');
  });

  it('TimeOfDay NE holds outside the window', async () => {
    const { role, verdict, setClock } = await served();
    role.addQueryResolutionPolicy(null, deny('P', { timeOfDay: 'NE,08:00-18:00' }));
    setClock(Date.UTC(2024, 5, 3, 12, 0, 0));
    expect(await verdict(WEB)).toBe('answered');
    setClock(Date.UTC(2024, 5, 3, 3, 0, 0));
    expect(await verdict(WEB)).toBe('refused');
  });
});

describe('the condition that combines the criteria', () => {
  it('AND holds only when every criterion does', async () => {
    const { role, verdict } = await served();
    role.addQueryResolutionPolicy(null, deny('P', { fqdn: `EQ,${WEB}`, queryType: 'EQ,AAAA' }, { condition: 'AND' }));
    expect([
      await verdict(WEB, 0, 4, 'udp', RRType.AAAA), await verdict(WEB, 0, 4, 'udp', RRType.A), await verdict(MAIL, 0, 4, 'udp', RRType.AAAA),
    ]).toEqual(['refused', 'answered', 'answered']);
  });

  it('OR holds when either criterion does', async () => {
    const { role, verdict } = await served();
    role.addQueryResolutionPolicy(null, deny('P', { fqdn: `EQ,${WEB}`, queryType: 'EQ,AAAA' }, { condition: 'OR' }));
    expect([
      await verdict(WEB, 0, 4, 'udp', RRType.AAAA), await verdict(WEB, 0, 4, 'udp', RRType.A), await verdict(MAIL, 0, 4, 'udp', RRType.AAAA),
      await verdict(MAIL, 0, 4, 'udp', RRType.A),
    ]).toEqual(['refused', 'refused', 'refused', 'answered']);
  });
});

describe('the order and the state of the policies', () => {
  it('lets the first policy in processing order that holds decide', async () => {
    const { role, verdict } = await served();
    role.addQueryResolutionPolicy(null, ignore('First', { fqdn: `EQ,${WEB}` }));
    role.addQueryResolutionPolicy(null, deny('Second', { fqdn: 'EQ,*.corp.test' }));
    expect([await verdict(WEB), await verdict(MAIL)]).toEqual(['dropped', 'refused']);
    role.changeQueryResolutionPolicy(null, 'Second', { processingOrder: 1 });
    expect([await verdict(WEB), await verdict(MAIL)]).toEqual(['refused', 'refused']);
  });

  it('skips a disabled policy and applies it again once enabled', async () => {
    const { role, verdict } = await served();
    role.addQueryResolutionPolicy(null, deny('P', { fqdn: `EQ,${WEB}` }, { enabled: false }));
    expect(await verdict(WEB)).toBe('answered');
    expect(role.setPolicyEnabled(null, 'P', true)).toEqual({ ok: true, message: '' });
    expect(await verdict(WEB)).toBe('refused');
    expect(role.setPolicyEnabled(null, 'P', false)).toEqual({ ok: true, message: '' });
    expect(await verdict(WEB)).toBe('answered');
  });

  it('enables and disables every policy of the level when no name is given', async () => {
    const { role, verdict } = await served();
    role.addQueryResolutionPolicy(null, deny('A', { fqdn: `EQ,${WEB}` }));
    role.addQueryResolutionPolicy(null, deny('B', { fqdn: `EQ,${MAIL}` }));
    role.setPolicyEnabled(null, null, false);
    expect([await verdict(WEB), await verdict(MAIL)]).toEqual(['answered', 'answered']);
    role.setPolicyEnabled(null, null, true);
    expect([await verdict(WEB), await verdict(MAIL)]).toEqual(['refused', 'refused']);
  });
});

describe('a zone-level policy', () => {
  it('governs the names of its zone and no others', async () => {
    const { role, verdict } = await served();
    role.addPrimaryZone('other.test');
    role.addARecord('other.test', 'host', '10.0.8.8');
    expect(role.addQueryResolutionPolicy('corp.test', deny('Z', { queryType: 'EQ,A' }))).toEqual({ ok: true, message: '' });
    expect([await verdict(WEB), await verdict('host.other.test')]).toEqual(['refused', 'answered']);
  });

  it('is kept apart from the policies of the server', async () => {
    const { role } = await served();
    role.addQueryResolutionPolicy('corp.test', deny('Same', { queryType: 'EQ,A' }));
    expect(role.addQueryResolutionPolicy(null, deny('Same', { queryType: 'EQ,A' }))).toEqual({ ok: true, message: '' });
    expect(role.getQueryResolutionPolicies('corp.test').policies.map(entry => entry.zone)).toEqual(['corp.test']);
    expect(role.getQueryResolutionPolicies(null).policies.map(entry => entry.zone)).toEqual([null]);
  });

  it('is evaluated after the server-level policies', async () => {
    const { role, verdict } = await served();
    role.addQueryResolutionPolicy('corp.test', deny('Z', { fqdn: `EQ,${WEB}` }));
    role.addQueryResolutionPolicy(null, ignore('S', { fqdn: `EQ,${WEB}` }));
    expect(await verdict(WEB)).toBe('dropped');
    role.removeQueryResolutionPolicy(null, 'S');
    expect(await verdict(WEB)).toBe('refused');
  });

  it('ends the search with an ALLOW that holds, so that a later DENY does not apply', async () => {
    const { role, verdict } = await served();
    role.addClientSubnet('Lan', ['10.0.1.2/32'], []);
    expect(role.addQueryResolutionPolicy('corp.test', policy('Allow', 'ALLOW', { clientSubnet: 'EQ,Lan' }, { content: [{ scope: 'corp.test', weight: 1 }] })))
      .toEqual({ ok: true, message: '' });
    role.addQueryResolutionPolicy('corp.test', deny('Everyone', { queryType: 'EQ,A' }));
    expect([await verdict(WEB, 0), await verdict(WEB, 1), await verdict(WEB, 2)]).toEqual(['answered', 'refused', 'refused']);
  });

  it('is refused for a zone the server does not host', async () => {
    const { role } = await served();
    expect(role.addQueryResolutionPolicy('nope.test', deny('Z', { queryType: 'EQ,A' }))).toEqual({ ok: false, message: ZONE_MISSING });
    expect(role.getQueryResolutionPolicies('nope.test')).toEqual({ ok: false, message: ZONE_MISSING, policies: [] });
    expect(role.setPolicyEnabled('nope.test', null, false)).toEqual({ ok: false, message: ZONE_MISSING });
  });

  it('disappears with its zone', async () => {
    const { role } = await served();
    role.addQueryResolutionPolicy('corp.test', deny('Z', { queryType: 'EQ,A' }));
    expect(role.getQueryResolutionPolicies('corp.test').policies).toHaveLength(1);
    role.removeZone('corp.test');
    role.addPrimaryZone('corp.test');
    expect(role.getQueryResolutionPolicies('corp.test').policies).toEqual([]);
    expect(role.removeQueryResolutionPolicy('corp.test', 'Z')).toEqual({ ok: false, message: POLICY_REFUSALS.missing });
  });
});

describe('a recursion policy', () => {
  const recursion = (name: string, action: PolicyAction, criteria: PolicyCriteriaText): NewPolicy =>
    ({ name, kind: 'Recursion', action, condition: 'AND', enabled: true, criteria, content: [] });

  it('resolves the name of another zone through the forwarder while no policy exists', async () => {
    const { ask } = await served({ remote: true });
    const reply = await ask(0, 4, question('host.ext.test'));
    expect(verdictOf(reply)).toBe('answered');
    expect(reply?.answers.map(rr => rr.name)).toEqual(['host.ext.test']);
  });

  it('denies the resolution with REFUSED and keeps answering the names the server holds', async () => {
    const { role, verdict } = await served({ remote: true });
    expect(role.addQueryResolutionPolicy(null, recursion('R', 'DENY', { fqdn: 'EQ,*.ext.test' }))).toEqual({ ok: true, message: '' });
    expect([await verdict('host.ext.test'), await verdict(WEB)]).toEqual(['refused', 'answered']);
  });

  it('ignores the resolution it is told to ignore', async () => {
    const { role, verdict } = await served({ remote: true });
    role.addQueryResolutionPolicy(null, recursion('R', 'IGNORE', { fqdn: 'EQ,*.ext.test' }));
    expect(await verdict('host.ext.test')).toBe('dropped');
  });

  it('does not govern a name the cache already holds', async () => {
    const { role, verdict } = await served({ remote: true });
    expect(await verdict('host.ext.test')).toBe('answered');
    role.addQueryResolutionPolicy(null, recursion('R', 'DENY', { fqdn: 'EQ,*.ext.test' }));
    expect(await verdict('host.ext.test')).toBe('answered');
    expect(await verdict('other.ext.test')).toBe('refused');
  });

  it('is not consulted for a query that does not ask for recursion', async () => {
    const { role, ask } = await served({ remote: true });
    role.addQueryResolutionPolicy(null, recursion('R', 'IGNORE', { fqdn: 'EQ,*.ext.test' }));
    const reply = await ask(0, 4, question('host.ext.test', RRType.A, DnsOpcode.QUERY, false));
    expect(verdictOf(reply)).toBe('refused');
  });

  it('comes after the query processing policies', async () => {
    const { role, verdict } = await served({ remote: true });
    role.addQueryResolutionPolicy(null, recursion('R', 'DENY', { fqdn: 'EQ,*.ext.test' }));
    role.addQueryResolutionPolicy(null, ignore('Q', { fqdn: 'EQ,*.ext.test' }));
    expect(await verdict('host.ext.test')).toBe('dropped');
  });
});

describe('the messages that are not queries', () => {
  it('answers a zone transfer while a policy denies every TCP query', async () => {
    const { role, ask } = await served();
    role.setPrimaryZone('corp.test', { secureSecondaries: 'TransferAnyServer' });
    role.addQueryResolutionPolicy(null, deny('P', { transportProtocol: 'EQ,TCP' }));
    expect(verdictOf(await ask(0, 4, question(WEB), 'tcp'))).toBe('refused');
    const transfer = await ask(0, 4, question('corp.test', RRType.AXFR), 'tcp');
    expect(transfer?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(transfer?.answers.length).toBeGreaterThan(0);
  });
});

describe('a query that carries no question', () => {
  it('is not governed by a policy on the name and gets the answer it got before', async () => {
    const { role, ask } = await served();
    const withoutQuestion = { ...question(WEB), questions: [] };
    const before = verdictOf(await ask(0, 4, withoutQuestion));
    expect(before).not.toBe('dropped');
    role.addQueryResolutionPolicy(null, ignore('P', { fqdn: 'EQ,*' }));
    expect(verdictOf(await ask(0, 4, withoutQuestion))).toBe(before);
  });
});
