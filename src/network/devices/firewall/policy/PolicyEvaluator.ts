import type { ObjectStore } from '../model/ObjectStore';
import {
  IMPLICIT_RULE_ID, isDenyAction, makeRule,
  type RuleAction, type SecurityRule,
} from '../model/SecurityRule';
import type { PolicyProbe } from './PolicyProbe';
import type { ServiceObject, ServiceProbe } from '../model/ServiceObject';
import { familyOf } from '../model/AddressObject';

export type PolicyKeyedBy = 'zone' | 'interface';
export type ImplicitPolicyMode = 'deny-all' | 'security-level';

export type MatchOutcome = 'match' | 'no-match' | 'pending';

export interface PolicyDecision {
  readonly rule: SecurityRule;
  readonly action: RuleAction;
  readonly implicit: boolean;
  readonly sawPending: boolean;
  readonly sawIdentityGate: boolean;
  readonly service?: ServiceObject;
}

export interface PolicyEvaluatorDeps {
  objects: ObjectStore;
  policyKeyedBy?: PolicyKeyedBy;
  implicitPolicy?: ImplicitPolicyMode;
  applicationShift?: boolean;
  securityLevelOf?: (zone: string) => number | undefined;
  interfaceHasBoundPolicy?: (iface: string) => boolean;
  sameSecurityInterAllowed?: () => boolean;
  scheduleActive?: (schedule: string, at: number) => boolean;
  userOf?: (ip: string) => string | undefined;
  userGroupsOf?: (user: string) => readonly string[];
  now?: () => number;
}

const VIP_RULE_PREFIX = 'vip:';

function catchesVipWithoutNaming(rule: SecurityRule): boolean {
  return isDenyAction(rule.action) && rule.matchTranslatedDestination !== false;
}

const ANY = 'any';

function namedIdentities(rule: SecurityRule): readonly string[] {
  return [...rule.user, ...(rule.authUsers ?? []), ...(rule.authGroups ?? [])];
}

export class PolicyEvaluator {
  private readonly objects: ObjectStore;
  private readonly keyedBy: PolicyKeyedBy;
  private readonly implicitMode: ImplicitPolicyMode;
  private readonly applicationShift: boolean;
  private readonly deps: PolicyEvaluatorDeps;
  private readonly now: () => number;
  private readonly implicit: SecurityRule;

  constructor(deps: PolicyEvaluatorDeps) {
    this.deps = deps;
    this.objects = deps.objects;
    this.keyedBy = deps.policyKeyedBy ?? 'zone';
    this.implicitMode = deps.implicitPolicy ?? 'deny-all';
    this.applicationShift = deps.applicationShift ?? false;
    this.now = deps.now ?? (() => Date.now());
    this.implicit = makeRule({
      id: IMPLICIT_RULE_ID, seq: Number.MAX_SAFE_INTEGER, name: 'implicit',
      from: [ANY], to: [ANY], source: [ANY], destination: [ANY], service: [ANY],
      action: 'deny', implicit: true,
    });
  }

  implicitRule(): SecurityRule {
    return this.implicit;
  }

  evaluate(rules: readonly SecurityRule[], probe: PolicyProbe, bytes = 0): PolicyDecision {
    const found = this.firstMatch(rules, probe, bytes);
    if (found.decision) return found.decision;
    return this.implicitDecision(probe, bytes, found.sawPending, found.sawIdentityGate);
  }

  evaluateExplicit(
    rules: readonly SecurityRule[], probe: PolicyProbe, bytes = 0,
  ): PolicyDecision | null {
    return this.firstMatch(rules, probe, bytes).decision;
  }

  private firstMatch(
    rules: readonly SecurityRule[], probe: PolicyProbe, bytes: number,
  ): { decision: PolicyDecision | null; sawPending: boolean; sawIdentityGate: boolean } {
    let sawPending = false;
    let sawIdentityGate = false;

    for (const rule of [...rules].sort((a, b) => a.seq - b.seq)) {
      if (!rule.enabled) continue;

      const outcome = this.match(rule, probe);
      if (outcome === 'pending') { sawPending = true; continue; }
      if (outcome === 'no-match') {
        if (this.heldBackByIdentity(rule, probe)) sawIdentityGate = true;
        continue;
      }

      this.countHit(rule, bytes);
      return {
        decision: Object.freeze({
          rule, action: rule.action, implicit: false, sawPending, sawIdentityGate,
          service: this.serviceMatched(rule, probe),
        }),
        sawPending, sawIdentityGate,
      };
    }

    return { decision: null, sawPending, sawIdentityGate };
  }

  private heldBackByIdentity(rule: SecurityRule, probe: PolicyProbe): boolean {
    if (namedIdentities(rule).length === 0) return false;
    return this.matchesEverythingButIdentity(rule, probe);
  }

  private implicitDecision(
    probe: PolicyProbe, bytes: number, sawPending: boolean, sawIdentityGate: boolean,
  ): PolicyDecision {
    this.countHit(this.implicit, bytes);
    const action: RuleAction = this.securityLevelAllows(probe) ? 'allow' : 'deny';
    return Object.freeze({
      rule: this.implicit, action, implicit: true, sawPending, sawIdentityGate,
    });
  }

  private securityLevelAllows(probe: PolicyProbe): boolean {
    if (this.implicitMode !== 'security-level') return false;
    if (this.deps.interfaceHasBoundPolicy?.(probe.ingressInterface)) return false;

    const from = this.deps.securityLevelOf?.(probe.ingressZone);
    const to = this.deps.securityLevelOf?.(probe.egressZone);
    if (from === undefined || to === undefined) return false;
    if (from === to) return this.deps.sameSecurityInterAllowed?.() ?? false;
    return from > to;
  }

  private countHit(rule: SecurityRule, bytes: number): void {
    rule.hitCount++;
    rule.byteCount += bytes;
    rule.lastHitAt = this.now();
  }

  private match(rule: SecurityRule, probe: PolicyProbe): MatchOutcome {
    if (!this.matchesEverythingButIdentity(rule, probe)) return 'no-match';
    if (!this.matchesUser(rule, probe)) return 'no-match';
    return this.matchesApplication(rule, probe);
  }

  private matchesEverythingButIdentity(rule: SecurityRule, probe: PolicyProbe): boolean {
    return this.matchesTranslatedDestination(rule, probe)
      && this.matchesEndpoints(rule, probe)
      && this.matchesAddresses(rule, probe)
      && this.matchesService(rule, probe)
      && this.matchesSchedule(rule);
  }

  private matchesTranslatedDestination(rule: SecurityRule, probe: PolicyProbe): boolean {
    if (probe.destinationTranslated !== true) return true;
    if (rule.matchTranslatedDestination !== false) return true;
    return rule.destination.some(name => name !== ANY);
  }

  private matchesEndpoints(rule: SecurityRule, probe: PolicyProbe): boolean {
    const source = this.keyedBy === 'zone' ? probe.ingressZone : probe.ingressInterface;
    const dest = this.keyedBy === 'zone' ? probe.egressZone : probe.egressInterface;
    return listMatches(rule.from, source) && listMatches(rule.to, dest);
  }

  private matchesAddresses(rule: SecurityRule, probe: PolicyProbe): boolean {
    const sources = addressListFor(rule, probe.sourceIP, 'source');
    if (sources.length === 0) return false;

    const sourceHit = this.objects.matchesAnyAddress(sources, probe.sourceIP);
    if (sourceHit === rule.sourceNegated) return false;

    const destHit = this.matchesDestination(rule, probe);
    return destHit !== rule.destinationNegated;
  }

  private matchesDestination(rule: SecurityRule, probe: PolicyProbe): boolean {
    const vipRule = probe.destinationNatRuleId;
    if (vipRule !== undefined && vipRule.startsWith(VIP_RULE_PREFIX)
      && !catchesVipWithoutNaming(rule)) {
      return this.objects.namesVipRule(rule.destination, vipRule);
    }
    const destinations = addressListFor(rule, probe.destIP, 'destination');
    if (destinations.length === 0) return false;
    return this.objects.matchesAnyAddress(destinations, probe.destIP);
  }

  private matchesService(rule: SecurityRule, probe: PolicyProbe): boolean {
    const hit = this.objects.serviceMatching(rule.service, serviceProbe(probe));
    return (hit !== undefined) !== rule.serviceNegated;
  }

  private serviceMatched(
    rule: SecurityRule, probe: PolicyProbe,
  ): ServiceObject | undefined {
    if (rule.serviceNegated) return undefined;
    return this.objects.serviceMatching(rule.service, serviceProbe(probe));
  }

  private matchesSchedule(rule: SecurityRule): boolean {
    if (rule.schedule === undefined) return true;
    return this.deps.scheduleActive?.(rule.schedule, this.now()) ?? false;
  }

  private matchesUser(rule: SecurityRule, probe: PolicyProbe): boolean {
    const named = namedIdentities(rule);
    if (named.length === 0) return true;

    const user = this.deps.userOf?.(probe.sourceIP);
    if (user === undefined) return false;
    if (named.includes(user)) return true;

    const groups = this.deps.userGroupsOf?.(user) ?? [];
    return groups.some(group => named.includes(group));
  }

  private matchesApplication(rule: SecurityRule, probe: PolicyProbe): MatchOutcome {
    if (rule.application.length === 0) return 'match';

    if (probe.application === undefined) {
      return this.applicationShift ? 'pending' : 'no-match';
    }
    return rule.application.includes(probe.application) || rule.application.includes(ANY)
      ? 'match'
      : 'no-match';
  }
}

function listMatches(list: readonly string[], value: string): boolean {
  return list.includes(ANY) || list.includes(value);
}

function addressListFor(
  rule: SecurityRule, candidate: string, side: 'source' | 'destination',
): readonly string[] {
  if (familyOf(candidate) === 'ipv4') {
    return side === 'source' ? rule.source : rule.destination;
  }
  return side === 'source' ? rule.source6 : rule.destination6;
}

function serviceProbe(probe: PolicyProbe): ServiceProbe {
  return {
    protocol: probe.protocol,
    sourcePort: probe.sourcePort,
    destPort: probe.destPort,
    icmpType: probe.icmpType,
    icmpCode: probe.icmpCode,
  };
}
