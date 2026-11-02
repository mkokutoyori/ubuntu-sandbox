/*
 * Structure — the DNS policies a Windows DNS server holds, at server level and at zone level, as [MS-DNSP] 3.1.4.1 describes
 * CreatePolicy, UpdatePolicy and DeletePolicy and 3.1.8.3 validates them: a name is unique across a level whatever its case and
 * whatever the type of the policy (9971), a name that is not held is refused (9972), a combination of level, type, action and
 * content that the table of 3.1.8.3 does not list, or a policy with no criterion, has no valid settings (9974), a criterion
 * that is malformed or names something that cannot be is refused under its own text (9990 to 9996), a weight of 0 or beyond
 * 0xFFFFFFFF is refused (9981) and so is a scope that does not exist (9959); the processing order is kept contiguous per
 * level and type (a new order that exists shifts the others, 0 appends, more than the highest is refused, a removal closes
 * the gap, a change moves the policy); a policy holds for a query when its enabled criteria, combined with its condition,
 * hold, the first one in order deciding; a criterion that cannot be decided, for want of a source address, an interface
 * address, a query name, a query type, a protocol or a time, does not hold; removing a zone removes its policies; a client
 * subnet record is referenced by a policy under EQ and under NE. Discrimination (run on the tree before the change): the
 * store of the exception lists existed with another interface, so all 116 cases fall on it (the constructor, the scopes
 * and the types they take did not exist); the mutation round is what proves the cases say something.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, IPv6Address } from '@/network/core/types';
import {
  DnsPolicyStore, POLICY_REFUSALS, type NewPolicy, type PolicyEnvironment, type PolicyFacts, type PolicyKind, type PolicyScope,
} from '@/network/devices/windows/server/dns/DnsPolicies';

const SUBNETS: Record<string, string[]> = { america: ['10.1.0.', '2001:db8:a:'], asia: ['10.2.0.', '2001:db8:b:'], europe: ['10.3.0.', '2001:db8:c:'] };

const ZONE_SCOPES: Record<string, string[]> = { 'contoso.com': ['contoso.com', 'northamerica', 'europe'] };

const RECURSION_SCOPES = ['.', 'internal'];

const environment: PolicyEnvironment = {
  clientSubnetExists: name => SUBNETS[name.toLowerCase()] !== undefined,
  clientSubnetContains: (name, address) => (SUBNETS[name.toLowerCase()] ?? []).some(prefix => address.toString().startsWith(prefix)),
  scopeExists: (kind, zone, scope) => (kind === 'Recursion' ? RECURSION_SCOPES : ZONE_SCOPES[zone ?? ''] ?? []).includes(scope.toLowerCase()),
};

const store = () => new DnsPolicyStore(environment);

const SERVER: PolicyScope = { zone: null, kinds: ['QueryProcessing', 'Recursion'] };
const CONTOSO: PolicyScope = { zone: 'contoso.com', kinds: ['QueryProcessing'] };
const RRL: PolicyScope = { zone: null, kinds: ['RrlException'] };
const WHOLE_SERVER: PolicyScope = { zone: null, kinds: ['QueryProcessing', 'Recursion', 'ZoneTransfer', 'RrlException'] };

const v4 = (address: string) => new IPAddress(address);
const v6 = (address: string) => new IPv6Address(address);

function policy(name: string, overrides: Partial<NewPolicy> = {}): NewPolicy {
  return {
    name, kind: 'QueryProcessing', action: 'DENY', condition: 'AND', enabled: true, criteria: { fqdn: 'EQ,a.test' }, content: [], ...overrides,
  };
}

const NO_FACTS: PolicyFacts = {
  queryName: null, queryType: null, transport: null, internetProtocol: null, minuteOfDay: null,
};

function facts(overrides: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    queryName: 'a.test', queryType: 1, transport: 'UDP', internetProtocol: 'IPv4', minuteOfDay: 600,
    source: v4('10.1.0.5'), destination: v4('10.0.0.3'), ...overrides,
  };
}

describe('creating a policy', () => {
  it('keeps the name as written and shows the criteria in their normalised form, with every member of the policy', () => {
    const policies = store();
    expect(policies.create(SERVER, policy('Blackhole', {
      action: 'IGNORE', condition: 'OR',
      criteria: { fqdn: 'eq, *.contoso.com', clientSubnet: 'EQ,America,Asia,NE,Europe', serverInterface: 'EQ,10.0.0.3', queryType: 'eq,txt;ne,mx', timeOfDay: 'EQ,10:00-12:00', transportProtocol: 'eq,tcp', internetProtocol: 'NE,ipv6' },
    }))).toBeNull();
    expect(policies.list(SERVER)).toEqual([{
      name: 'Blackhole', kind: 'QueryProcessing', zone: null, action: 'IGNORE', condition: 'OR', enabled: true, processingOrder: 1, content: [],
      criteria: {
        clientSubnet: 'EQ,America,Asia,NE,Europe', transportProtocol: 'EQ,tcp', internetProtocol: 'NE,ipv6', serverInterface: 'EQ,10.0.0.3',
        fqdn: 'EQ,*.contoso.com', queryType: 'EQ,txt,NE,mx', timeOfDay: 'EQ,10:00-12:00',
      },
    }]);
  });

  it('shows a criterion that was not given as null', () => {
    const policies = store();
    policies.create(SERVER, policy('OnlyName'));
    expect(policies.list(SERVER)[0].criteria).toEqual({
      clientSubnet: null, transportProtocol: null, internetProtocol: null, serverInterface: null, fqdn: 'EQ,a.test', queryType: null, timeOfDay: null,
    });
  });

  it('refuses a name that is taken whatever its case, and keeps the first policy', () => {
    const policies = store();
    policies.create(SERVER, policy('Blackhole'));
    expect(policies.create(SERVER, policy('BLACKHOLE', { action: 'IGNORE' }))).toBe(POLICY_REFUSALS.exists);
    expect(policies.list(SERVER)).toHaveLength(1);
    expect(policies.list(SERVER)[0].action).toBe('DENY');
  });

  it.each<[string, PolicyKind]>([
    ['a query processing policy', 'QueryProcessing'],
    ['a recursion policy', 'Recursion'],
    ['an exception list', 'RrlException'],
  ])('keeps a name taken across the types of a level: %s holds it for the others', (_label, kind) => {
    const policies = store();
    const make = (name: string, as: PolicyKind): NewPolicy => (as === 'Recursion'
      ? policy(name, { kind: as, action: 'ALLOW', content: [{ scope: '.', weight: 1 }] })
      : policy(name, { kind: as, action: as === 'RrlException' ? 'DENY' : 'IGNORE' }));
    expect(policies.create(WHOLE_SERVER, make('Shared', kind))).toBeNull();
    for (const other of ['QueryProcessing', 'Recursion', 'RrlException'] as const) {
      expect(policies.create(WHOLE_SERVER, make('shared', other))).toBe(POLICY_REFUSALS.exists);
    }
  });

  it('lets the same name live on the server and in two zones', () => {
    const policies = store();
    expect(policies.create(SERVER, policy('P'))).toBeNull();
    expect(policies.create(CONTOSO, policy('P'))).toBeNull();
    expect(policies.create({ zone: 'fabrikam.com', kinds: ['QueryProcessing'] }, policy('P'))).toBeNull();
  });

  it.each([
    ['a server level query processing policy that allows', { kind: 'QueryProcessing', action: 'ALLOW', content: [{ scope: '.', weight: 1 }] }, SERVER],
    ['a server level query processing policy with content', { kind: 'QueryProcessing', action: 'DENY', content: [{ scope: '.', weight: 1 }] }, SERVER],
    ['a recursion policy that allows no scope', { kind: 'Recursion', action: 'ALLOW', content: [] }, SERVER],
    ['a recursion policy that denies and names a scope', { kind: 'Recursion', action: 'DENY', content: [{ scope: '.', weight: 1 }] }, SERVER],
    ['a zone level policy that allows no scope', { kind: 'QueryProcessing', action: 'ALLOW', content: [] }, CONTOSO],
    ['a zone level policy that ignores and names a scope', { kind: 'QueryProcessing', action: 'IGNORE', content: [{ scope: 'contoso.com', weight: 1 }] }, CONTOSO],
    ['a zone level recursion policy', { kind: 'Recursion', action: 'DENY', content: [] }, { zone: 'contoso.com', kinds: ['Recursion'] }],
    ['a zone level exception list', { kind: 'RrlException', action: 'DENY', content: [] }, { zone: 'contoso.com', kinds: ['RrlException'] }],
    ['an exception list that ignores', { kind: 'RrlException', action: 'IGNORE', content: [] }, RRL],
    ['a server level zone transfer policy that allows', { kind: 'ZoneTransfer', action: 'ALLOW', content: [{ scope: '.', weight: 1 }] }, { zone: null, kinds: ['ZoneTransfer'] }],
    ['a zone level zone transfer policy that allows', { kind: 'ZoneTransfer', action: 'ALLOW', content: [{ scope: 'contoso.com', weight: 1 }] }, { zone: 'contoso.com', kinds: ['ZoneTransfer'] }],
    ['a policy with no criterion', { criteria: {} }, SERVER],
  ] as Array<[string, Partial<NewPolicy>, PolicyScope]>)('refuses %s as having no valid settings', (_label, overrides, scope) => {
    const policies = store();
    expect(policies.create(scope, policy('Bad', overrides))).toBe(POLICY_REFUSALS.invalidSettings);
    expect(policies.list(scope)).toEqual([]);
  });

  it.each([
    ['server level recursion', SERVER, { kind: 'Recursion', action: 'ALLOW', content: [{ scope: '.', weight: 3 }] }],
    ['zone level allow', CONTOSO, { kind: 'QueryProcessing', action: 'ALLOW', content: [{ scope: 'NorthAmerica', weight: 4 }, { scope: 'Europe', weight: 1 }] }],
    ['zone level transfer', { zone: 'contoso.com', kinds: ['ZoneTransfer'] } as PolicyScope, { kind: 'ZoneTransfer', action: 'IGNORE' }],
    ['server level transfer', { zone: null, kinds: ['ZoneTransfer'] } as PolicyScope, { kind: 'ZoneTransfer', action: 'DENY' }],
  ] as Array<[string, PolicyScope, Partial<NewPolicy>]>)('accepts %s with the content the table asks for', (_label, scope, overrides) => {
    const policies = store();
    expect(policies.create(scope, policy('Good', overrides))).toBeNull();
    expect(policies.list(scope)).toHaveLength(1);
  });

  it.each([
    ['a client subnet that is not a criterion', { clientSubnet: 'America' }, POLICY_REFUSALS.clientSubnet],
    ['a client subnet record that does not exist', { clientSubnet: 'EQ,Atlantis' }, POLICY_REFUSALS.clientSubnet],
    ['a client subnet record that does not exist, after one that does', { clientSubnet: 'EQ,America,NE,Atlantis' }, POLICY_REFUSALS.clientSubnet],
    ['an FQDN that is not a criterion', { fqdn: '*.contoso.com' }, POLICY_REFUSALS.fqdn],
    ['an FQDN that is not a name', { fqdn: 'EQ,a..b' }, POLICY_REFUSALS.fqdn],
    ['a wildcard that is not the first label', { fqdn: 'EQ,a.*.b' }, POLICY_REFUSALS.fqdn],
    ['an interface that is not a criterion', { serverInterface: '10.0.0.3' }, POLICY_REFUSALS.serverInterface],
    ['an interface that is not an address', { serverInterface: 'EQ,eth0' }, POLICY_REFUSALS.serverInterface],
    ['a query type that is no type', { queryType: 'EQ,NOPE' }, POLICY_REFUSALS.queryType],
    ['a query type with no comparator', { queryType: 'TXT' }, POLICY_REFUSALS.queryType],
    ['a transport that is neither TCP nor UDP', { transportProtocol: 'EQ,SCTP' }, POLICY_REFUSALS.transportProtocol],
    ['an internet protocol that is neither IPv4 nor IPv6', { internetProtocol: 'EQ,IPX' }, POLICY_REFUSALS.internetProtocol],
    ['a time of day that is no range', { timeOfDay: 'EQ,noon' }, POLICY_REFUSALS.timeOfDay],
    ['a time of day beyond the day', { timeOfDay: 'EQ,10:00-24:00' }, POLICY_REFUSALS.timeOfDay],
    ['a time of day that ends before it starts', { timeOfDay: 'EQ,12:00-10:00' }, POLICY_REFUSALS.timeOfDay],
    ['an empty criterion', { fqdn: '' }, POLICY_REFUSALS.fqdn],
    ['an FQDN list with one value that is not a name', { fqdn: 'EQ,a.test,a..b' }, POLICY_REFUSALS.fqdn],
    ['an interface list with one value that is not an address', { serverInterface: 'EQ,10.0.0.3,eth0' }, POLICY_REFUSALS.serverInterface],
    ['a query type list with one value that is no type', { queryType: 'EQ,A,NOPE' }, POLICY_REFUSALS.queryType],
    ['a transport list with one value that is neither TCP nor UDP', { transportProtocol: 'EQ,TCP,SCTP' }, POLICY_REFUSALS.transportProtocol],
    ['an internet protocol list with one value that is neither IPv4 nor IPv6', { internetProtocol: 'EQ,IPv4,IPX' }, POLICY_REFUSALS.internetProtocol],
    ['a time of day list with one value that is no range', { timeOfDay: 'EQ,10:00-11:00,noon' }, POLICY_REFUSALS.timeOfDay],
  ])('refuses %s and creates nothing', (_label, criteria, refusal) => {
    const policies = store();
    expect(policies.create(SERVER, policy('Bad', { criteria }))).toBe(refusal);
    expect(policies.list(SERVER)).toEqual([]);
  });

  it('says which criterion is wrong when several are given and one is, the first of them in the order of the specification', () => {
    const policies = store();
    expect(policies.create(SERVER, policy('Bad', { criteria: { clientSubnet: 'EQ,America', fqdn: 'EQ,a.test', serverInterface: 'EQ,nowhere' } }))).toBe(POLICY_REFUSALS.serverInterface);
    expect(policies.create(SERVER, policy('Bad', { criteria: { fqdn: 'EQ,a..b', clientSubnet: 'EQ,Atlantis' } }))).toBe(POLICY_REFUSALS.clientSubnet);
    expect(policies.create(SERVER, policy('Bad', { criteria: { timeOfDay: 'EQ,x', queryType: 'EQ,x', transportProtocol: 'EQ,x' } }))).toBe(POLICY_REFUSALS.transportProtocol);
  });

  it('refuses a weight of 0, beyond 0xFFFFFFFF or not a whole number, and a scope that does not exist, after the name check', () => {
    const policies = store();
    const allow = (content: NewPolicy['content'], name = 'Z') => policy(name, { action: 'ALLOW', content });
    expect(policies.create(CONTOSO, allow([{ scope: 'Europe', weight: 0 }]))).toBe(POLICY_REFUSALS.invalidWeight);
    expect(policies.create(CONTOSO, allow([{ scope: 'Europe', weight: 0x100000000 }]))).toBe(POLICY_REFUSALS.invalidWeight);
    expect(policies.create(CONTOSO, allow([{ scope: 'Europe', weight: 1.5 }]))).toBe(POLICY_REFUSALS.invalidWeight);
    expect(policies.create(CONTOSO, allow([{ scope: 'Europe', weight: Number.NaN }]))).toBe(POLICY_REFUSALS.invalidWeight);
    expect(policies.create(CONTOSO, allow([{ scope: 'Atlantis', weight: 1 }]))).toBe(POLICY_REFUSALS.scopeMissing);
    expect(policies.create(CONTOSO, allow([{ scope: 'Europe', weight: 0xffffffff }]))).toBeNull();
    expect(policies.create(CONTOSO, allow([{ scope: 'Atlantis', weight: 0 }], 'z'))).toBe(POLICY_REFUSALS.exists);
  });

  it('copies the content it is given, so that later changes of the caller do not reach it', () => {
    const policies = store();
    const content = [{ scope: 'Europe', weight: 2 }];
    policies.create(CONTOSO, policy('Z', { action: 'ALLOW', content }));
    content[0].weight = 9;
    expect(policies.find(CONTOSO, 'Z')?.content).toEqual([{ scope: 'Europe', weight: 2 }]);
  });
});

describe('the processing order', () => {
  const created = (...names: string[]) => {
    const policies = store();
    for (const name of names) policies.create(SERVER, policy(name));
    return policies;
  };
  const order = (policies: DnsPolicyStore, scope: PolicyScope = SERVER) => policies.list(scope).map(view => `${view.name}:${view.processingOrder}`);

  it('appends a policy that gives no order, and one that gives 0', () => {
    const policies = created('A', 'B');
    policies.create(SERVER, policy('C', { processingOrder: 0 }));
    expect(order(policies)).toEqual(['A:1', 'B:2', 'C:3']);
  });

  it('inserts a policy at an order that exists and shifts the others down', () => {
    const policies = created('A', 'B', 'C');
    policies.create(SERVER, policy('X', { processingOrder: 2 }));
    expect(order(policies)).toEqual(['A:1', 'X:2', 'B:3', 'C:4']);
    policies.create(SERVER, policy('Y', { processingOrder: 1 }));
    expect(order(policies)).toEqual(['Y:1', 'A:2', 'X:3', 'B:4', 'C:5']);
  });

  it('refuses an order beyond the highest one, the first policy of a group included, and creates nothing', () => {
    const policies = created('A', 'B');
    expect(policies.create(SERVER, policy('X', { processingOrder: 3 }))).toBe(POLICY_REFUSALS.invalidSettings);
    expect(store().create(SERVER, policy('X', { processingOrder: 1 }))).toBe(POLICY_REFUSALS.invalidSettings);
    expect(order(policies)).toEqual(['A:1', 'B:2']);
  });

  it('keeps the order of each level and each type apart', () => {
    const policies = store();
    policies.create(SERVER, policy('Q1'));
    policies.create(SERVER, policy('R1', { kind: 'Recursion', action: 'IGNORE' }));
    policies.create(CONTOSO, policy('Z1'));
    policies.create(SERVER, policy('Q2'));
    expect(order(policies)).toEqual(['Q1:1', 'Q2:2', 'R1:1']);
    expect(order(policies, CONTOSO)).toEqual(['Z1:1']);
  });

  it('closes the gap when a policy is removed', () => {
    const policies = created('A', 'B', 'C', 'D');
    expect(policies.remove(SERVER, 'b')).toBeNull();
    expect(order(policies)).toEqual(['A:1', 'C:2', 'D:3']);
  });

  it.each([
    ['to the front', 'D', 1, ['D:1', 'A:2', 'B:3', 'C:4']],
    ['to the middle', 'A', 3, ['B:1', 'C:2', 'A:3', 'D:4']],
    ['to the back', 'A', 4, ['B:1', 'C:2', 'D:3', 'A:4']],
    ['to the back with 0', 'B', 0, ['A:1', 'C:2', 'D:3', 'B:4']],
    ['where it is', 'B', 2, ['A:1', 'B:2', 'C:3', 'D:4']],
  ])('moves a policy %s and shifts the others', (_label, name, to, expected) => {
    const policies = created('A', 'B', 'C', 'D');
    expect(policies.change(SERVER, name, { processingOrder: to })).toBeNull();
    expect(order(policies)).toEqual(expected);
  });

  it('refuses a move beyond the highest order and changes nothing', () => {
    const policies = created('A', 'B');
    expect(policies.change(SERVER, 'A', { processingOrder: 3, condition: 'OR' })).toBe(POLICY_REFUSALS.invalidSettings);
    expect(order(policies)).toEqual(['A:1', 'B:2']);
    expect(policies.find(SERVER, 'A')?.condition).toBe('AND');
  });

  it('lists the query processing policies before the recursion ones, each in its order', () => {
    const policies = store();
    policies.create(SERVER, policy('R1', { kind: 'Recursion', action: 'DENY' }));
    policies.create(SERVER, policy('Q1'));
    policies.create(SERVER, policy('R2', { kind: 'Recursion', action: 'DENY' }));
    expect(order(policies)).toEqual(['Q1:1', 'R1:1', 'R2:2']);
  });
});

describe('finding, changing and removing', () => {
  const held = () => {
    const policies = store();
    policies.create(SERVER, policy('P', { criteria: { fqdn: 'EQ,*.contoso.com', serverInterface: 'EQ,10.0.0.3' } }));
    return policies;
  };

  it('finds a policy whatever the case of its name, and only within the types it is asked for', () => {
    expect(held().find(SERVER, 'p')?.name).toBe('P');
    expect(held().find(SERVER, 'Other')).toBeNull();
    expect(held().find(RRL, 'P')).toBeNull();
    expect(held().find({ zone: 'contoso.com', kinds: ['QueryProcessing'] }, 'P')).toBeNull();
  });

  it('replaces only the criteria it is given, and the condition when it is given', () => {
    const policies = held();
    expect(policies.change(SERVER, 'p', { condition: 'OR', criteria: { serverInterface: 'EQ,10.0.0.1' } })).toBeNull();
    expect(policies.find(SERVER, 'P')).toMatchObject({
      condition: 'OR', criteria: { fqdn: 'EQ,*.contoso.com', serverInterface: 'EQ,10.0.0.1', clientSubnet: null },
    });
  });

  it('adds a criterion it was not holding and keeps the condition when none is given', () => {
    const policies = held();
    expect(policies.change(SERVER, 'P', { criteria: { clientSubnet: 'EQ,Asia', queryType: 'EQ,A' } })).toBeNull();
    expect(policies.find(SERVER, 'P')).toMatchObject({ condition: 'AND', criteria: { clientSubnet: 'EQ,Asia', queryType: 'EQ,A', fqdn: 'EQ,*.contoso.com' } });
  });

  it('replaces the content of a policy that allows, and refuses content on one that denies', () => {
    const policies = store();
    policies.create(CONTOSO, policy('Z', { action: 'ALLOW', content: [{ scope: 'Europe', weight: 1 }] }));
    policies.create(CONTOSO, policy('D'));
    expect(policies.change(CONTOSO, 'Z', { content: [{ scope: 'NorthAmerica', weight: 3 }] })).toBeNull();
    expect(policies.find(CONTOSO, 'Z')?.content).toEqual([{ scope: 'NorthAmerica', weight: 3 }]);
    expect(policies.change(CONTOSO, 'D', { content: [{ scope: 'Europe', weight: 1 }] })).toBe(POLICY_REFUSALS.invalidSettings);
    expect(policies.change(CONTOSO, 'Z', { content: [] })).toBe(POLICY_REFUSALS.invalidSettings);
    expect(policies.change(CONTOSO, 'Z', { content: [{ scope: 'Europe', weight: 0 }] })).toBe(POLICY_REFUSALS.invalidWeight);
    expect(policies.change(CONTOSO, 'Z', { content: [{ scope: 'Atlantis', weight: 1 }] })).toBe(POLICY_REFUSALS.scopeMissing);
    expect(policies.find(CONTOSO, 'Z')?.content).toEqual([{ scope: 'NorthAmerica', weight: 3 }]);
  });

  it('refuses a policy that is not held', () => {
    expect(store().change(SERVER, 'Nope', { criteria: { fqdn: 'EQ,a.test' } })).toBe(POLICY_REFUSALS.missing);
    expect(store().remove(SERVER, 'Nope')).toBe(POLICY_REFUSALS.missing);
  });

  it('refuses an invalid criterion and changes nothing, not even the condition or the criteria before it', () => {
    const policies = held();
    expect(policies.change(SERVER, 'P', { condition: 'OR', criteria: { fqdn: 'EQ,b.test', serverInterface: 'EQ,eth0' } })).toBe(POLICY_REFUSALS.serverInterface);
    expect(policies.find(SERVER, 'P')).toMatchObject({ condition: 'AND', criteria: { fqdn: 'EQ,*.contoso.com', serverInterface: 'EQ,10.0.0.3' } });
  });

  it('removes a policy, and a removed name is free again', () => {
    const policies = held();
    expect(policies.remove(SERVER, 'P')).toBeNull();
    expect(policies.list(SERVER)).toEqual([]);
    expect(policies.create(SERVER, policy('P'))).toBeNull();
  });

  it('hands out views that cannot change the policy', () => {
    const policies = held();
    const view = policies.find(SERVER, 'P') as unknown as { condition: string; criteria: { fqdn: string | null } };
    view.condition = 'OR';
    view.criteria.fqdn = 'EQ,other.test';
    expect(policies.find(SERVER, 'P')).toMatchObject({ condition: 'AND', criteria: { fqdn: 'EQ,*.contoso.com' } });
  });

  it('drops the policies of a zone and no others when the zone goes', () => {
    const policies = store();
    policies.create(SERVER, policy('S'));
    policies.create(CONTOSO, policy('Z'));
    policies.create({ zone: 'fabrikam.com', kinds: ['QueryProcessing'] }, policy('F'));
    policies.removeZone('contoso.com');
    expect(policies.list(CONTOSO)).toEqual([]);
    expect(policies.list(SERVER)).toHaveLength(1);
    expect(policies.list({ zone: 'fabrikam.com', kinds: ['QueryProcessing'] })).toHaveLength(1);
  });
});

describe('enabling and disabling', () => {
  it('creates a policy disabled when asked, and never lets a disabled policy decide', () => {
    const policies = store();
    policies.create(SERVER, policy('Off', { enabled: false }));
    expect(policies.find(SERVER, 'Off')?.enabled).toBe(false);
    expect(policies.decide(null, 'QueryProcessing', facts())).toBeNull();
    expect(policies.setEnabled(SERVER, 'off', true)).toBeNull();
    expect(policies.decide(null, 'QueryProcessing', facts())?.name).toBe('Off');
    expect(policies.setEnabled(SERVER, 'OFF', false)).toBeNull();
    expect(policies.decide(null, 'QueryProcessing', facts())).toBeNull();
  });

  it('lets the next policy decide while the first is disabled', () => {
    const policies = store();
    policies.create(SERVER, policy('First'));
    policies.create(SERVER, policy('Second', { action: 'IGNORE' }));
    expect(policies.decide(null, 'QueryProcessing', facts())?.name).toBe('First');
    policies.setEnabled(SERVER, 'First', false);
    expect(policies.decide(null, 'QueryProcessing', facts())?.name).toBe('Second');
  });

  it('changes every policy of the scope when no name is given, and only that scope', () => {
    const policies = store();
    policies.create(SERVER, policy('A'));
    policies.create(SERVER, policy('B', { kind: 'Recursion', action: 'DENY' }));
    policies.create(CONTOSO, policy('Z'));
    expect(policies.setEnabled(SERVER, null, false)).toBeNull();
    expect(policies.list(SERVER).map(view => view.enabled)).toEqual([false, false]);
    expect(policies.find(CONTOSO, 'Z')?.enabled).toBe(true);
    expect(policies.setEnabled(CONTOSO, null, false)).toBeNull();
    expect(policies.find(CONTOSO, 'Z')?.enabled).toBe(false);
  });

  it('refuses a policy that is not held, and accepts a scope with no policy when no name is given', () => {
    expect(store().setEnabled(SERVER, 'Nope', true)).toBe(POLICY_REFUSALS.missing);
    expect(store().setEnabled(SERVER, null, true)).toBeNull();
  });
});

describe('deciding for a query', () => {
  const deciding = (criteria: NewPolicy['criteria'], seen: PolicyFacts, condition: NewPolicy['condition'] = 'AND') => {
    const policies = store();
    policies.create(SERVER, policy('P', { criteria, condition }));
    return policies.decide(null, 'QueryProcessing', seen) !== null;
  };

  it.each([
    ['a name under a wildcard', { fqdn: 'EQ,*.test' }, {}, true],
    ['a name outside the wildcard', { fqdn: 'EQ,*.other' }, {}, false],
    ['a name an NE leaves out', { fqdn: 'NE,a.test' }, {}, false],
    ['a name an NE lets through', { fqdn: 'NE,b.test' }, {}, true],
    ['a query type listed', { queryType: 'EQ,A,AAAA' }, {}, true],
    ['a query type listed by an NE', { queryType: 'NE,A' }, {}, false],
    ['a query type written in lower case', { queryType: 'EQ,a' }, {}, true],
    ['a query type beyond the model', { queryType: 'EQ,HINFO' }, { queryType: 13 }, true],
    ['a transport that is the one used', { transportProtocol: 'EQ,UDP' }, {}, true],
    ['a transport that is not the one used', { transportProtocol: 'EQ,TCP' }, {}, false],
    ['a transport an NE excludes', { transportProtocol: 'NE,UDP' }, {}, false],
    ['an internet protocol that is the one used', { internetProtocol: 'EQ,IPv4' }, {}, true],
    ['an internet protocol of the other family', { internetProtocol: 'EQ,IPv6' }, {}, false],
    ['an IPv6 query against IPv6', { internetProtocol: 'EQ,IPv6' }, { internetProtocol: 'IPv6' }, true],
    ['an interface that received the query', { serverInterface: 'EQ,10.0.0.3' }, {}, true],
    ['an interface that did not', { serverInterface: 'EQ,10.0.0.4' }, {}, false],
    ['an IPv6 interface', { serverInterface: 'EQ,2001:db8::53' }, { destination: v6('2001:db8:0:0:0:0:0:53') }, true],
    ['a client in the record', { clientSubnet: 'EQ,America' }, {}, true],
    ['a client outside the record', { clientSubnet: 'EQ,Asia' }, {}, false],
    ['an IPv6 client in the record', { clientSubnet: 'EQ,America' }, { source: v6('2001:db8:a::1') }, true],
    ['a minute inside the range', { timeOfDay: 'EQ,10:00-10:00' }, {}, true],
    ['a minute at the start of the range', { timeOfDay: 'EQ,10:00-12:00' }, {}, true],
    ['a minute at the end of the range', { timeOfDay: 'EQ,08:00-10:00' }, {}, true],
    ['a minute before the range', { timeOfDay: 'EQ,10:01-12:00' }, {}, false],
    ['a minute after the range', { timeOfDay: 'EQ,08:00-09:59' }, {}, false],
    ['a minute in one of two ranges', { timeOfDay: 'EQ,01:00-02:00,10:00-11:00' }, {}, true],
    ['a minute an NE range excludes', { timeOfDay: 'NE,09:00-11:00' }, {}, false],
  ] as Array<[string, NewPolicy['criteria'], Partial<PolicyFacts>, boolean]>)('holds for %s: %s', (_label, criteria, overrides, expected) => {
    expect(deciding(criteria, facts(overrides))).toBe(expected);
  });

  it.each([
    ['AND', { fqdn: 'EQ,a.test', queryType: 'EQ,A' }, true],
    ['AND', { fqdn: 'EQ,a.test', queryType: 'EQ,MX' }, false],
    ['OR', { fqdn: 'EQ,a.test', queryType: 'EQ,MX' }, true],
    ['OR', { fqdn: 'EQ,b.test', queryType: 'EQ,MX' }, false],
  ] as const)('combines two criteria under %s', (condition, criteria, expected) => {
    expect(deciding(criteria, facts(), condition)).toBe(expected);
  });

  it('combines EQ and NE of one criterion with the condition', () => {
    expect(deciding({ clientSubnet: 'EQ,America,NE,Asia' }, facts({ source: v4('10.1.0.9') }), 'AND')).toBe(true);
    expect(deciding({ queryType: 'EQ,MX,NE,TXT' }, facts(), 'AND')).toBe(false);
    expect(deciding({ queryType: 'EQ,MX,NE,TXT' }, facts(), 'OR')).toBe(true);
  });

  it.each([
    ['client subnet', { clientSubnet: 'EQ,America' }, { source: undefined }],
    ['client subnet, negated', { clientSubnet: 'NE,Asia' }, { source: undefined }],
    ['FQDN', { fqdn: 'EQ,*' }, { queryName: null }],
    ['FQDN, negated', { fqdn: 'NE,x.test' }, { queryName: null }],
    ['interface', { serverInterface: 'EQ,10.0.0.3' }, { destination: undefined }],
    ['interface, negated', { serverInterface: 'NE,10.0.0.9' }, { destination: undefined }],
    ['query type', { queryType: 'EQ,A' }, { queryType: null }],
    ['query type, negated', { queryType: 'NE,MX' }, { queryType: null }],
    ['transport', { transportProtocol: 'EQ,UDP' }, { transport: null }],
    ['transport, negated', { transportProtocol: 'NE,TCP' }, { transport: null }],
    ['internet protocol', { internetProtocol: 'EQ,IPv4' }, { internetProtocol: null }],
    ['internet protocol, negated', { internetProtocol: 'NE,IPv6' }, { internetProtocol: null }],
    ['time of day', { timeOfDay: 'EQ,00:00-23:59' }, { minuteOfDay: null }],
    ['time of day, negated', { timeOfDay: 'NE,03:00-04:00' }, { minuteOfDay: null }],
  ] as Array<[string, NewPolicy['criteria'], Partial<PolicyFacts>]>)('does not hold when the %s cannot be decided, which makes the policy fail closed', (_label, criteria, undecidable) => {
    expect(deciding(criteria, facts())).toBe(true);
    expect(deciding(criteria, { ...facts(), ...undecidable })).toBe(false);
  });

  it('holds for nothing when every fact is missing', () => {
    expect(deciding({ fqdn: 'EQ,a.test' }, NO_FACTS)).toBe(false);
  });

  it('lets the first policy in order decide, and reports it', () => {
    const policies = store();
    policies.create(SERVER, policy('Loose', { criteria: { queryType: 'EQ,A' }, action: 'IGNORE' }));
    policies.create(SERVER, policy('Tight', { criteria: { fqdn: 'EQ,a.test' }, processingOrder: 1 }));
    expect(policies.decide(null, 'QueryProcessing', facts())).toMatchObject({ name: 'Tight', action: 'DENY' });
    expect(policies.decide(null, 'QueryProcessing', facts({ queryName: 'b.test' }))).toMatchObject({ name: 'Loose', action: 'IGNORE' });
  });

  it('decides within the zone and the type it is asked for only', () => {
    const policies = store();
    policies.create(SERVER, policy('S'));
    policies.create(CONTOSO, policy('Z', { action: 'IGNORE' }));
    policies.create(SERVER, policy('R', { kind: 'Recursion', action: 'IGNORE' }));
    policies.create(RRL, policy('L', { kind: 'RrlException' }));
    expect(policies.decide(null, 'QueryProcessing', facts())?.name).toBe('S');
    expect(policies.decide('contoso.com', 'QueryProcessing', facts())?.name).toBe('Z');
    expect(policies.decide(null, 'Recursion', facts())?.name).toBe('R');
    expect(policies.decide(null, 'RrlException', facts())?.name).toBe('L');
    expect(policies.decide(null, 'ZoneTransfer', facts())).toBeNull();
    expect(policies.decide('fabrikam.com', 'QueryProcessing', facts())).toBeNull();
  });
});

describe('the client subnet records the policies name', () => {
  it('are referenced under EQ and under NE, whatever the case, by a policy of any type or level', () => {
    const policies = store();
    policies.create(CONTOSO, policy('Z', { criteria: { clientSubnet: 'EQ,Asia,NE,Europe' } }));
    expect(policies.referencesClientSubnet('asia')).toBe(true);
    expect(policies.referencesClientSubnet('EUROPE')).toBe(true);
    expect(policies.referencesClientSubnet('America')).toBe(false);
    policies.create(RRL, policy('L', { kind: 'RrlException', criteria: { clientSubnet: 'EQ,America' } }));
    expect(policies.referencesClientSubnet('America')).toBe(true);
    policies.remove(CONTOSO, 'Z');
    expect(policies.referencesClientSubnet('Asia')).toBe(false);
  });

  it('WITNESS: stay unreferenced by a policy that names none', () => {
    const policies = store();
    policies.create(SERVER, policy('P', { criteria: { fqdn: 'EQ,asia.test' } }));
    expect(policies.referencesClientSubnet('Asia')).toBe(false);
  });
});
