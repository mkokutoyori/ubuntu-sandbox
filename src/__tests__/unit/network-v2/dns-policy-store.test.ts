/*
 * Structure — the server-level DNS policies a Windows DNS server holds, here the RRL exception lists, as [MS-DNSP] 3.1.4.1
 * describes CreatePolicy, UpdatePolicy and DeletePolicy: a name that is taken is refused whatever its case (9971), a name that
 * is not held is refused (9972), a policy with no criterion has no valid settings (9974), and a criterion that is malformed
 * or names something that cannot be (an unknown client subnet record, an FQDN that is no name, an interface that is no
 * address) is refused under its own text (9990, 9994, 9993) and creates or changes nothing. UpdatePolicy replaces the
 * criteria it is given and keeps the others. A policy holds for a query when its criteria, combined with its condition,
 * hold; a criterion that cannot be decided, for want of a source address, an interface address or a query name, does not
 * hold; a client subnet record is referenced by a policy under EQ and under NE. Discrimination (run on the tree before the
 * change): every case falls, the module did not exist.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, IPv6Address } from '@/network/core/types';
import { DnsPolicyStore, POLICY_REFUSALS, type PolicyEnvironment } from '@/network/devices/windows/server/dns/DnsPolicies';

const SUBNETS: Record<string, string[]> = { america: ['10.1.0.', '2001:db8:a:'], asia: ['10.2.0.', '2001:db8:b:'], europe: ['10.3.0.', '2001:db8:c:'] };

const environment: PolicyEnvironment = {
  clientSubnetExists: name => SUBNETS[name.toLowerCase()] !== undefined,
  clientSubnetContains: (name, address) => (SUBNETS[name.toLowerCase()] ?? []).some(prefix => address.toString().startsWith(prefix)),
};

const store = () => new DnsPolicyStore(environment);

const v4 = (address: string) => new IPAddress(address);
const v6 = (address: string) => new IPv6Address(address);

describe('creating a policy', () => {
  it('keeps the name as written and shows the criteria in their written form', () => {
    const policies = store();
    expect(policies.create('SafeList1', 'AND', { fqdn: 'eq, *.contoso.com', clientSubnet: 'EQ,America,Asia,NE,Europe', serverInterface: 'EQ,10.0.0.3' })).toBeNull();
    expect(policies.list()).toEqual([{
      name: 'SafeList1', condition: 'AND', fqdn: 'EQ,*.contoso.com', clientSubnet: 'EQ,America,Asia,NE,Europe', serverInterface: 'EQ,10.0.0.3',
    }]);
  });

  it('shows a criterion that was not given as null', () => {
    const policies = store();
    policies.create('OnlyName', 'OR', { fqdn: 'EQ,a.test' });
    expect(policies.list()[0]).toEqual({ name: 'OnlyName', condition: 'OR', fqdn: 'EQ,a.test', clientSubnet: null, serverInterface: null });
  });

  it('refuses a name that is taken whatever its case, and keeps the first policy', () => {
    const policies = store();
    policies.create('SafeList1', 'AND', { fqdn: 'EQ,a.test' });
    expect(policies.create('SAFELIST1', 'OR', { fqdn: 'EQ,b.test' })).toBe(POLICY_REFUSALS.exists);
    expect(policies.list()).toHaveLength(1);
    expect(policies.list()[0]).toMatchObject({ name: 'SafeList1', condition: 'AND', fqdn: 'EQ,a.test' });
  });

  it('refuses a policy that has no criterion', () => {
    const policies = store();
    expect(policies.create('Empty', 'AND', {})).toBe(POLICY_REFUSALS.invalidSettings);
    expect(policies.list()).toEqual([]);
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
    ['an empty criterion', { fqdn: '' }, POLICY_REFUSALS.fqdn],
  ])('refuses %s and creates nothing', (_label, criteria, refusal) => {
    const policies = store();
    expect(policies.create('Bad', 'AND', { ...criteria })).toBe(refusal);
    expect(policies.list()).toEqual([]);
  });

  it('says which criterion is wrong when several are given and one is', () => {
    const policies = store();
    expect(policies.create('Bad', 'AND', { clientSubnet: 'EQ,America', fqdn: 'EQ,a.test', serverInterface: 'EQ,nowhere' })).toBe(POLICY_REFUSALS.serverInterface);
    expect(policies.create('Bad', 'AND', { clientSubnet: 'EQ,Atlantis', fqdn: 'EQ,a..b' })).toBe(POLICY_REFUSALS.clientSubnet);
  });
});

describe('finding, changing and removing', () => {
  const held = () => {
    const policies = store();
    policies.create('SafeList1', 'AND', { fqdn: 'EQ,*.contoso.com', serverInterface: 'EQ,10.0.0.3' });
    return policies;
  };

  it('finds a policy whatever the case of its name', () => {
    expect(held().find('safelist1')?.name).toBe('SafeList1');
    expect(held().find('Other')).toBeNull();
  });

  it('replaces only the criteria it is given, and the condition when it is given', () => {
    const policies = held();
    expect(policies.change('safelist1', 'OR', { serverInterface: 'EQ,10.0.0.1' })).toBeNull();
    expect(policies.find('SafeList1')).toEqual({
      name: 'SafeList1', condition: 'OR', fqdn: 'EQ,*.contoso.com', clientSubnet: null, serverInterface: 'EQ,10.0.0.1',
    });
  });

  it('adds a criterion it was not holding', () => {
    const policies = held();
    expect(policies.change('SafeList1', undefined, { clientSubnet: 'EQ,Asia' })).toBeNull();
    expect(policies.find('SafeList1')).toMatchObject({ condition: 'AND', clientSubnet: 'EQ,Asia', fqdn: 'EQ,*.contoso.com' });
  });

  it('keeps the condition when none is given', () => {
    const policies = store();
    policies.create('P', 'OR', { fqdn: 'EQ,a.test' });
    policies.change('P', undefined, { fqdn: 'EQ,b.test' });
    expect(policies.find('P')?.condition).toBe('OR');
  });

  it('refuses a policy that is not held', () => {
    expect(store().change('Nope', 'AND', { fqdn: 'EQ,a.test' })).toBe(POLICY_REFUSALS.missing);
    expect(store().remove('Nope')).toBe(POLICY_REFUSALS.missing);
  });

  it('refuses an invalid criterion and changes nothing, not even the condition or the criteria before it', () => {
    const policies = held();
    expect(policies.change('SafeList1', 'OR', { fqdn: 'EQ,b.test', serverInterface: 'EQ,eth0' })).toBe(POLICY_REFUSALS.serverInterface);
    expect(policies.find('SafeList1')).toMatchObject({ condition: 'AND', fqdn: 'EQ,*.contoso.com', serverInterface: 'EQ,10.0.0.3' });
  });

  it('removes a policy whatever the case of its name, and then holds nothing', () => {
    const policies = held();
    expect(policies.remove('SAFELIST1')).toBeNull();
    expect(policies.list()).toEqual([]);
    expect(policies.matches({ queryName: 'a.contoso.com', destination: v4('10.0.0.3') })).toBe(false);
  });
});

describe('referencing a client subnet record', () => {
  it('holds for a record named under EQ or under NE, whatever its case, and not for another', () => {
    const policies = store();
    policies.create('P', 'AND', { clientSubnet: 'EQ,America,NE,Europe' });
    expect(policies.referencesClientSubnet('america')).toBe(true);
    expect(policies.referencesClientSubnet('EUROPE')).toBe(true);
    expect(policies.referencesClientSubnet('Asia')).toBe(false);
  });

  it('does not hold for a name that only appears as an FQDN or an interface', () => {
    const policies = store();
    policies.create('P', 'AND', { fqdn: 'EQ,america', serverInterface: 'EQ,10.0.0.3' });
    expect(policies.referencesClientSubnet('america')).toBe(false);
  });

  it('stops holding when the policy is removed or no longer names the record', () => {
    const policies = store();
    policies.create('P', 'AND', { clientSubnet: 'EQ,America' });
    policies.change('P', undefined, { clientSubnet: 'EQ,Asia' });
    expect(policies.referencesClientSubnet('America')).toBe(false);
    expect(policies.referencesClientSubnet('Asia')).toBe(true);
    policies.remove('P');
    expect(policies.referencesClientSubnet('Asia')).toBe(false);
  });
});

describe('a policy holding for a query', () => {
  it('holds for a query name under a wildcard, and for no other', () => {
    const policies = store();
    policies.create('P', 'AND', { fqdn: 'EQ,*.contoso.com' });
    expect(policies.matches({ queryName: 'a.contoso.com' })).toBe(true);
    expect(policies.matches({ queryName: 'a.fabrikam.com' })).toBe(false);
  });

  it('holds for a source inside a client subnet record, over IPv4 and over IPv6', () => {
    const policies = store();
    policies.create('P', 'AND', { clientSubnet: 'EQ,America' });
    expect(policies.matches({ queryName: 'x', source: v4('10.1.0.9') })).toBe(true);
    expect(policies.matches({ queryName: 'x', source: v6('2001:db8:a::9') })).toBe(true);
    expect(policies.matches({ queryName: 'x', source: v4('10.2.0.9') })).toBe(false);
  });

  it('holds for a source outside the record named under NE', () => {
    const policies = store();
    policies.create('P', 'AND', { clientSubnet: 'NE,Europe' });
    expect(policies.matches({ queryName: 'x', source: v4('10.1.0.9') })).toBe(true);
    expect(policies.matches({ queryName: 'x', source: v4('10.3.0.9') })).toBe(false);
  });

  it('holds for a query received on the interface named, and for no other', () => {
    const policies = store();
    policies.create('P', 'AND', { serverInterface: 'EQ,10.0.0.3,2001:db8::3' });
    expect(policies.matches({ queryName: 'x', destination: v4('10.0.0.3') })).toBe(true);
    expect(policies.matches({ queryName: 'x', destination: v6('2001:db8::3') })).toBe(true);
    expect(policies.matches({ queryName: 'x', destination: v4('10.0.0.4') })).toBe(false);
  });

  it('combines the criteria with AND: all must hold', () => {
    const policies = store();
    policies.create('P', 'AND', { clientSubnet: 'EQ,America', fqdn: 'EQ,*.contoso.com', serverInterface: 'EQ,10.0.0.3' });
    const all = { queryName: 'a.contoso.com', source: v4('10.1.0.9'), destination: v4('10.0.0.3') };
    expect(policies.matches(all)).toBe(true);
    expect(policies.matches({ ...all, source: v4('10.2.0.9') })).toBe(false);
    expect(policies.matches({ ...all, queryName: 'a.fabrikam.com' })).toBe(false);
    expect(policies.matches({ ...all, destination: v4('10.0.0.4') })).toBe(false);
  });

  it('combines the criteria with OR: one is enough', () => {
    const policies = store();
    policies.create('P', 'OR', { clientSubnet: 'EQ,America', fqdn: 'EQ,*.contoso.com', serverInterface: 'EQ,10.0.0.3' });
    const none = { queryName: 'a.fabrikam.com', source: v4('10.2.0.9'), destination: v4('10.0.0.4') };
    expect(policies.matches(none)).toBe(false);
    expect(policies.matches({ ...none, queryName: 'a.contoso.com' })).toBe(true);
    expect(policies.matches({ ...none, source: v4('10.1.0.9') })).toBe(true);
    expect(policies.matches({ ...none, destination: v4('10.0.0.3') })).toBe(true);
  });

  it('combines EQ and NE inside a criterion with the condition of the policy', () => {
    const anded = store();
    anded.create('P', 'AND', { clientSubnet: 'EQ,America,Asia,NE,Europe' });
    const ored = store();
    ored.create('P', 'OR', { clientSubnet: 'EQ,America,NE,Europe' });
    expect(anded.matches({ queryName: 'x', source: v4('10.1.0.9') })).toBe(true);
    expect(anded.matches({ queryName: 'x', source: v4('10.4.0.9') })).toBe(false);
    expect(ored.matches({ queryName: 'x', source: v4('10.4.0.9') })).toBe(true);
    expect(ored.matches({ queryName: 'x', source: v4('10.3.0.9') })).toBe(false);
  });

  it('holds when any of the policies holds', () => {
    const policies = store();
    policies.create('First', 'AND', { fqdn: 'EQ,a.test' });
    policies.create('Second', 'AND', { fqdn: 'EQ,b.test' });
    expect(policies.matches({ queryName: 'b.test' })).toBe(true);
    expect(policies.matches({ queryName: 'c.test' })).toBe(false);
  });

  it('does not hold for a criterion it cannot decide', () => {
    const policies = store();
    policies.create('Subnet', 'AND', { clientSubnet: 'EQ,America' });
    policies.create('Name', 'AND', { fqdn: 'EQ,*' });
    policies.create('Interface', 'AND', { serverInterface: 'NE,10.0.0.9' });
    expect(policies.matches({ queryName: null, source: undefined, destination: undefined })).toBe(false);
    const negated = store();
    negated.create('Not', 'AND', { clientSubnet: 'NE,Europe' });
    expect(negated.matches({ queryName: 'x' })).toBe(false);
  });

  it('holds for nothing when there is no policy', () => {
    expect(store().matches({ queryName: 'a.test', source: v4('10.1.0.9'), destination: v4('10.0.0.3') })).toBe(false);
  });
});
