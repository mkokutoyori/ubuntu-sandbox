/**
 * firewall policy: srcaddr6-negate, dstaddr6-negate, tos / tos-mask /
 * tos-negate and policy-expiry used to be refused by the grammar; they are
 * now accepted AND decide.
 *
 * Measured on a git worktree of HEAD before the change: 6 of the 9 cases fall
 * (both negations, the masked tos match, tos-negate, the expired rule and the
 * grammar acceptance). The 3 witnesses pass either way: the plain IPv6 rule,
 * the rule without tos, and the not-yet-expired rule; they prove the lab is
 * sound and that the new fields do not disturb a rule that does not use them.
 */
import { describe, it, expect } from 'vitest';
import { PolicyEvaluator } from '@/network/devices/firewall/policy/PolicyEvaluator';
import { makeRule, type SecurityRule } from '@/network/devices/firewall/model/SecurityRule';
import { ObjectStore } from '@/network/devices/firewall/model/ObjectStore';
import { anyAddress6 } from '@/network/devices/firewall/model/AddressObject';
import { IP_PROTO_TCP } from '@/network/core/types';
import type { PolicyProbe } from '@/network/devices/firewall/policy/PolicyProbe';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';

function probe(over: Partial<PolicyProbe> = {}): PolicyProbe {
  return {
    ingressZone: '', egressZone: '', ingressInterface: 'port1', egressInterface: 'port2',
    sourceIP: '10.0.0.1', destIP: '10.0.1.1', protocol: IP_PROTO_TCP,
    sourcePort: 40000, destPort: 80, ...over,
  };
}

function rule(over: Partial<SecurityRule> = {}): SecurityRule {
  return makeRule({
    id: 'R', seq: 1, from: ['port1'], to: ['port2'], source: ['any'], destination: ['any'],
    source6: ['any6'], destination6: ['any6'], service: ['any'], action: 'allow', ...over,
  });
}

const v6 = { sourceIP: '2001:db8::1', destIP: '2001:db8:1::1' };

function decide(over: Partial<SecurityRule>, p: Partial<PolicyProbe> = {}, now = 1_000_000): string {
  const objects = new ObjectStore();
  objects.addAddress(anyAddress6('any6'));
  const evaluator = new PolicyEvaluator({ objects, policyKeyedBy: 'interface', now: () => now });
  return evaluator.evaluate([rule(over)], probe(p)).action;
}

describe('IPv6 negation is decided per family', () => {
  it('witness: the plain rule accepts the IPv6 flow', () => {
    expect(decide({}, v6)).toBe('allow');
  });
  it('srcaddr6-negate on "all" turns the source match around', () => {
    expect(decide({ source6Negated: true }, v6)).not.toBe('allow');
  });
  it('dstaddr6-negate on "all" turns the destination match around', () => {
    expect(decide({ destination6Negated: true }, v6)).not.toBe('allow');
  });
});

describe('tos match', () => {
  const tos = (value: number, mask: number, negated = false) => ({ tos: { value, mask, negated } });
  it('witness: a rule without tos ignores the field', () => {
    expect(decide({}, { tos: 0x10 })).toBe('allow');
  });
  it('matches only the masked bits', () => {
    expect(decide(tos(0x10, 0x3c), { tos: 0x10 })).toBe('allow');
    expect(decide(tos(0x10, 0x3c), { tos: 0x20 })).not.toBe('allow');
  });
  it('tos-negate inverts it, and a missing tos fails closed', () => {
    expect(decide(tos(0x10, 0x3c, true), { tos: 0x20 })).toBe('allow');
    expect(decide(tos(0x10, 0x3c), {})).not.toBe('allow');
  });
});

describe('policy-expiry', () => {
  it('witness: a rule not yet expired matches', () => {
    expect(decide({ expiresAt: 2_000_000 }, {}, 1_000_000)).toBe('allow');
  });
  it('an expired rule no longer matches', () => {
    expect(decide({ expiresAt: 500_000 }, {}, 1_000_000)).not.toBe('allow');
  });
});

describe('the grammar accepts the attributes it now evaluates', () => {
  it('set tos, tos-mask, policy-expiry and the date are no longer refused', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const out: string[] = [];
    for (const line of ['config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "port2"', 'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set tos 0x10', 'set tos-mask 0x3c',
      'set tos-negate enable', 'set srcaddr6-negate enable', 'set dstaddr6-negate enable',
      'set policy-expiry enable', 'set policy-expiry-date 2099-01-01 00:00:00', 'next', 'end']) {
      out.push(await fgt.executeCommand(line));
    }
    expect(out.join('\n')).not.toMatch(/unknown|not supported|Command fail|does not evaluate/i);
  });
});
