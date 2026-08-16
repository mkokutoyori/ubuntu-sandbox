import type { ObjectStore } from '../model/ObjectStore';
import { makeRule, type RuleAction, type SecurityRule } from '../model/SecurityRule';
import type { PolicyProbe } from './PolicyProbe';

export type PolicyKeyedBy = 'zone' | 'interface';
export type ImplicitPolicyMode = 'deny-all' | 'security-level';

export type MatchOutcome = 'match' | 'no-match' | 'pending';

export interface PolicyDecision {
  readonly rule: SecurityRule;
  readonly action: RuleAction;
  readonly implicit: boolean;
  readonly sawPending: boolean;
}

export interface PolicyEvaluatorDeps {
  objects: ObjectStore;
  policyKeyedBy?: PolicyKeyedBy;
  implicitPolicy?: ImplicitPolicyMode;
  applicationShift?: boolean;
  securityLevelOf?: (zone: string) => number | undefined;
  interfaceHasBoundPolicy?: (iface: string) => boolean;
  scheduleActive?: (schedule: string, at: number) => boolean;
  userOf?: (ip: string) => string | undefined;
  userGroupsOf?: (user: string) => readonly string[];
  now?: () => number;
}

const ANY = 'any';

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
      id: '__implicit__', seq: Number.MAX_SAFE_INTEGER, name: 'implicit',
      from: [ANY], to: [ANY], source: [ANY], destination: [ANY], service: [ANY],
      action: 'deny', implicit: true,
    });
  }

  implicitRule(): SecurityRule {
    return this.implicit;
  }

  evaluate(rules: readonly SecurityRule[], probe: PolicyProbe, bytes = 0): PolicyDecision {
    let sawPending = false;

    for (const rule of [...rules].sort((a, b) => a.seq - b.seq)) {
      if (!rule.enabled) continue;

      const outcome = this.match(rule, probe);
      if (outcome === 'pending') { sawPending = true; continue; }
      if (outcome === 'no-match') continue;

      this.countHit(rule, bytes);
      return Object.freeze({ rule, action: rule.action, implicit: false, sawPending });
    }

    return this.implicitDecision(probe, bytes, sawPending);
  }

  private implicitDecision(probe: PolicyProbe, bytes: number, sawPending: boolean): PolicyDecision {
    this.countHit(this.implicit, bytes);
    const action: RuleAction = this.securityLevelAllows(probe) ? 'allow' : 'deny';
    return Object.freeze({ rule: this.implicit, action, implicit: true, sawPending });
  }

  private securityLevelAllows(probe: PolicyProbe): boolean {
    if (this.implicitMode !== 'security-level') return false;
    if (this.deps.interfaceHasBoundPolicy?.(probe.ingressInterface)) return false;

    const from = this.deps.securityLevelOf?.(probe.ingressZone);
    const to = this.deps.securityLevelOf?.(probe.egressZone);
    if (from === undefined || to === undefined) return false;
    return from > to;
  }

  private countHit(rule: SecurityRule, bytes: number): void {
    rule.hitCount++;
    rule.byteCount += bytes;
    rule.lastHitAt = this.now();
  }

  private match(rule: SecurityRule, probe: PolicyProbe): MatchOutcome {
    if (!this.matchesEndpoints(rule, probe)) return 'no-match';
    if (!this.matchesAddresses(rule, probe)) return 'no-match';
    if (!this.matchesService(rule, probe)) return 'no-match';
    if (!this.matchesSchedule(rule)) return 'no-match';
    if (!this.matchesUser(rule, probe)) return 'no-match';
    return this.matchesApplication(rule, probe);
  }

  private matchesEndpoints(rule: SecurityRule, probe: PolicyProbe): boolean {
    const source = this.keyedBy === 'zone' ? probe.ingressZone : probe.ingressInterface;
    const dest = this.keyedBy === 'zone' ? probe.egressZone : probe.egressInterface;
    return listMatches(rule.from, source) && listMatches(rule.to, dest);
  }

  private matchesAddresses(rule: SecurityRule, probe: PolicyProbe): boolean {
    const sourceHit = this.objects.matchesAnyAddress(rule.source, probe.sourceIP);
    if (sourceHit === rule.sourceNegated) return false;

    const destHit = this.objects.matchesAnyAddress(rule.destination, probe.destIP);
    return destHit !== rule.destinationNegated;
  }

  private matchesService(rule: SecurityRule, probe: PolicyProbe): boolean {
    const hit = this.objects.matchesAnyService(rule.service, {
      protocol: probe.protocol,
      sourcePort: probe.sourcePort,
      destPort: probe.destPort,
      icmpType: probe.icmpType,
      icmpCode: probe.icmpCode,
    });
    return hit !== rule.serviceNegated;
  }

  private matchesSchedule(rule: SecurityRule): boolean {
    if (rule.schedule === undefined) return true;
    return this.deps.scheduleActive?.(rule.schedule, this.now()) ?? false;
  }

  private matchesUser(rule: SecurityRule, probe: PolicyProbe): boolean {
    if (rule.user.length === 0) return true;

    const user = this.deps.userOf?.(probe.sourceIP);
    if (user === undefined) return false;
    if (rule.user.includes(user)) return true;

    const groups = this.deps.userGroupsOf?.(user) ?? [];
    return groups.some(group => rule.user.includes(group));
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
