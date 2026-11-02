/*
 * Structure — the recursion scopes a Windows DNS server holds besides the default one: a scope is a name with a list of
 * forwarders and a flag that says whether recursion is on (Learn: Add-DnsServerRecursionScope and the class
 * DnsServerRecursionScope); the default scope "." is not held here, it is the legacy forwarders and recursion setting; a
 * name is unique whatever its case (9963), the default name can be neither added nor removed (9960), a scope that is not held
 * is refused (9959), a scope that a policy names cannot be removed (9988). The policy store keeps, per policy, the count of
 * its matches and spreads them over the scopes of its content in the ratio of their weights ([MS-DNSP] DNS_RPC_POLICY_CONTENT:
 * {Scope1,2} and {Scope2,3} use Scope1 for the first two matches and Scope2 for the next three, then start again).
 * Discrimination (run on the tree before the change): every case falls, the module did not exist.
 */
import { describe, it, expect } from 'vitest';
import { DnsRecursionScopes, RECURSION_SCOPE_REFUSALS, isDefaultRecursionScope } from '@/network/devices/windows/server/dns/DnsRecursionScopes';
import { DnsPolicyStore, type NewPolicy } from '@/network/devices/windows/server/dns/DnsPolicies';

describe('the recursion scopes besides the default one', () => {
  it('holds none at first, and keeps a scope as it was written with its forwarders and its flag', () => {
    const scopes = new DnsRecursionScopes();
    expect(scopes.list()).toEqual([]);
    expect(scopes.create('ScopeInternal', ['10.0.0.1', '172.22.0.1'], true)).toBeNull();
    expect(scopes.list()).toEqual([{ name: 'ScopeInternal', forwarders: ['10.0.0.1', '172.22.0.1'], enableRecursion: true }]);
  });

  it('finds a scope whatever the case of its name, and nothing else', () => {
    const scopes = new DnsRecursionScopes();
    scopes.create('ScopeInternal', [], false);
    expect(scopes.find('SCOPEINTERNAL')?.name).toBe('ScopeInternal');
    expect(scopes.find('Other')).toBeNull();
  });

  it('refuses a name that is taken whatever its case, and the default name', () => {
    const scopes = new DnsRecursionScopes();
    scopes.create('A', [], true);
    expect(scopes.create('a', ['10.0.0.9'], false)).toBe(RECURSION_SCOPE_REFUSALS.exists);
    expect(scopes.create('.', [], true)).toBe(RECURSION_SCOPE_REFUSALS.isDefault);
    expect(scopes.list()).toEqual([{ name: 'A', forwarders: [], enableRecursion: true }]);
  });

  it('changes the forwarders, the flag, or both, and keeps what it is not given', () => {
    const scopes = new DnsRecursionScopes();
    scopes.create('A', ['10.0.0.1'], true);
    expect(scopes.change('a', { enableRecursion: false })).toBeNull();
    expect(scopes.find('A')).toEqual({ name: 'A', forwarders: ['10.0.0.1'], enableRecursion: false });
    expect(scopes.change('A', { forwarders: ['10.0.0.2', '10.0.0.3'] })).toBeNull();
    expect(scopes.find('A')).toEqual({ name: 'A', forwarders: ['10.0.0.2', '10.0.0.3'], enableRecursion: false });
    expect(scopes.change('A', { forwarders: [], enableRecursion: true })).toBeNull();
    expect(scopes.find('A')).toEqual({ name: 'A', forwarders: [], enableRecursion: true });
    expect(scopes.change('Nope', { enableRecursion: true })).toBe(RECURSION_SCOPE_REFUSALS.missing);
  });

  it('hands out views that cannot change the scope', () => {
    const scopes = new DnsRecursionScopes();
    scopes.create('A', ['10.0.0.1'], true);
    (scopes.list()[0].forwarders as string[]).push('10.9.9.9');
    (scopes.find('A')!.forwarders as string[]).push('10.9.9.9');
    expect(scopes.find('A')?.forwarders).toEqual(['10.0.0.1']);
  });

  it('removes a scope unless it is the default one, absent, or referenced, in that order of refusal', () => {
    const scopes = new DnsRecursionScopes();
    scopes.create('A', [], true);
    expect(scopes.remove('.', () => false)).toBe(RECURSION_SCOPE_REFUSALS.isDefault);
    expect(scopes.remove('Nope', () => true)).toBe(RECURSION_SCOPE_REFUSALS.missing);
    expect(scopes.remove('A', name => name === 'A')).toBe(RECURSION_SCOPE_REFUSALS.referenced);
    expect(scopes.find('A')).not.toBeNull();
    expect(scopes.remove('a', () => false)).toBeNull();
    expect(scopes.find('A')).toBeNull();
    expect(scopes.create('A', [], false)).toBeNull();
  });

  it('knows the default scope by its name alone', () => {
    expect(isDefaultRecursionScope('.')).toBe(true);
    expect(isDefaultRecursionScope(' . ')).toBe(true);
    expect(isDefaultRecursionScope('..')).toBe(false);
    expect(isDefaultRecursionScope('')).toBe(false);
  });
});

describe('the scopes a recursion policy names', () => {
  const SERVER = { zone: null, kinds: ['Recursion'] } as const;
  const store = () => new DnsPolicyStore({ clientSubnetExists: () => true, clientSubnetContains: () => true, scopeExists: () => true });
  const allow = (name: string, content: Array<[string, number]>): NewPolicy => ({
    name, kind: 'Recursion', action: 'ALLOW', condition: 'AND', enabled: true, criteria: { fqdn: 'EQ,*' },
    content: content.map(([scope, weight]) => ({ scope, weight })),
  });
  const pick = (policies: DnsPolicyStore, count: number, name = 'P') => Array.from({ length: count }, () => policies.nextScope(null, 'Recursion', name));

  it('spreads the matches over the scopes in the ratio of their weights, then starts again', () => {
    const policies = store();
    policies.create(SERVER, allow('P', [['One', 2], ['Two', 3]]));
    expect(pick(policies, 11)).toEqual(['One', 'One', 'Two', 'Two', 'Two', 'One', 'One', 'Two', 'Two', 'Two', 'One']);
  });

  it('gives one scope all the matches when the content names one', () => {
    const policies = store();
    policies.create(SERVER, allow('P', [['Only', 1]]));
    expect(pick(policies, 3)).toEqual(['Only', 'Only', 'Only']);
  });

  it('counts the matches of each policy apart, and finds the policy whatever the case of its name', () => {
    const policies = store();
    policies.create(SERVER, allow('P', [['A', 1], ['B', 1]]));
    policies.create(SERVER, allow('Q', [['C', 1], ['D', 1]]));
    expect([policies.nextScope(null, 'Recursion', 'p'), policies.nextScope(null, 'Recursion', 'Q'), policies.nextScope(null, 'Recursion', 'P')])
      .toEqual(['A', 'C', 'B']);
  });

  it('starts again from the first scope when the content is replaced', () => {
    const policies = store();
    policies.create(SERVER, allow('P', [['A', 1], ['B', 1]]));
    pick(policies, 1);
    policies.change(SERVER, 'P', { content: [{ scope: 'C', weight: 1 }, { scope: 'D', weight: 1 }] });
    expect(pick(policies, 2)).toEqual(['C', 'D']);
  });

  it('names no scope for a policy that is not held or that holds none', () => {
    const policies = store();
    policies.create(SERVER, { name: 'Deny', kind: 'Recursion', action: 'DENY', condition: 'AND', enabled: true, criteria: { fqdn: 'EQ,*' }, content: [] });
    expect(policies.nextScope(null, 'Recursion', 'Deny')).toBeNull();
    expect(policies.nextScope(null, 'Recursion', 'Nope')).toBeNull();
  });

  it('says whether a scope is named by a policy of the kind, whatever the case', () => {
    const policies = store();
    policies.create(SERVER, allow('P', [['Internal', 1]]));
    expect(policies.referencesScope('Recursion', null, 'INTERNAL')).toBe(true);
    expect(policies.referencesScope('Recursion', null, 'External')).toBe(false);
    expect(policies.referencesScope('QueryProcessing', null, 'Internal')).toBe(false);
  });
});
