import type { IPAddress, IPv6Address } from '@/network/core/types';
import {
  addressCriterionMatches, criterionText, evaluateCriterion, fqdnCriterionMatches, internetProtocolCriterionMatches,
  isValidCriterionAddress, isValidCriterionFqdn, isValidCriterionInternetProtocol, isValidCriterionQueryType,
  isValidCriterionTimeRange, isValidCriterionTransport, parseCriterion, queryTypeCriterionMatches, timeRangeCriterionMatches,
  transportCriterionMatches, type CriterionExpression, type InternetProtocol, type PolicyCondition, type TransportProtocol,
} from './DnsPolicyCriteria';

export type PolicyKind = 'QueryProcessing' | 'Recursion' | 'ZoneTransfer' | 'RrlException';

export type PolicyAction = 'ALLOW' | 'DENY' | 'IGNORE';

export type PolicyCriterionType =
  'clientSubnet' | 'transportProtocol' | 'internetProtocol' | 'serverInterface' | 'fqdn' | 'queryType' | 'timeOfDay';

export const POLICY_CRITERION_TYPES: readonly PolicyCriterionType[] = [
  'clientSubnet', 'transportProtocol', 'internetProtocol', 'serverInterface', 'fqdn', 'queryType', 'timeOfDay',
];

export const POLICY_ACTIONS: readonly PolicyAction[] = ['ALLOW', 'DENY', 'IGNORE'];

export type PolicyCriteriaText = Partial<Record<PolicyCriterionType, string>>;

export interface PolicyContentEntry {
  readonly scope: string;
  readonly weight: number;
}

export interface PolicyView {
  readonly name: string;
  readonly kind: PolicyKind;
  readonly zone: string | null;
  readonly action: PolicyAction;
  readonly condition: PolicyCondition;
  readonly enabled: boolean;
  readonly processingOrder: number;
  readonly criteria: Readonly<Record<PolicyCriterionType, string | null>>;
  readonly content: readonly PolicyContentEntry[];
}

export interface PolicyScope {
  readonly zone: string | null;
  readonly kinds: readonly PolicyKind[];
}

export interface NewPolicy {
  readonly name: string;
  readonly kind: PolicyKind;
  readonly action: PolicyAction;
  readonly condition: PolicyCondition;
  readonly enabled: boolean;
  readonly processingOrder?: number;
  readonly criteria: PolicyCriteriaText;
  readonly content: readonly PolicyContentEntry[];
}

export interface PolicyChanges {
  readonly condition?: PolicyCondition;
  readonly processingOrder?: number;
  readonly criteria?: PolicyCriteriaText;
  readonly content?: readonly PolicyContentEntry[];
}

export interface PolicyFacts {
  readonly queryName: string | null;
  readonly queryType: number | null;
  readonly transport: TransportProtocol | null;
  readonly internetProtocol: InternetProtocol | null;
  readonly minuteOfDay: number | null;
  readonly source?: IPAddress | IPv6Address;
  readonly destination?: IPAddress | IPv6Address;
}

export interface PolicyEnvironment {
  readonly clientSubnetExists: (name: string) => boolean;
  readonly clientSubnetContains: (name: string, address: IPAddress | IPv6Address) => boolean;
  readonly scopeExists: (kind: PolicyKind, zone: string | null, scope: string) => boolean;
}

export const POLICY_REFUSALS = {
  exists: 'A policy with the same name already exists on this level (server level or zone level) on the DNS server.',
  missing: 'No policy with this name exists on this level (server level or zone level) on the DNS server.',
  invalidSettings: 'At least one of the settings of this policy is invalid.',
  scopeMissing: 'The scope does not exist.',
  invalidWeight: 'The weight of the scope in the policy is invalid.',
  clientSubnet: 'The criterion client subnet provided in the policy is invalid.',
  transportProtocol: 'The criterion transport protocol provided in the policy is invalid.',
  internetProtocol: 'The criterion network protocol provided in the policy is invalid.',
  serverInterface: 'The criterion interface provided in the policy is invalid.',
  fqdn: 'The criterion FQDN provided in the policy is invalid.',
  queryType: 'The criterion query type provided in the policy is invalid.',
  timeOfDay: 'The criterion time of day provided in the policy is invalid.',
} as const;

type StoredCriteria = Partial<Record<PolicyCriterionType, CriterionExpression>>;

interface StoredPolicy {
  readonly name: string;
  readonly kind: PolicyKind;
  readonly zone: string | null;
  action: PolicyAction;
  condition: PolicyCondition;
  enabled: boolean;
  order: number;
  criteria: StoredCriteria;
  content: PolicyContentEntry[];
}

const CRITERION_REFUSALS: Record<PolicyCriterionType, string> = {
  clientSubnet: POLICY_REFUSALS.clientSubnet,
  transportProtocol: POLICY_REFUSALS.transportProtocol,
  internetProtocol: POLICY_REFUSALS.internetProtocol,
  serverInterface: POLICY_REFUSALS.serverInterface,
  fqdn: POLICY_REFUSALS.fqdn,
  queryType: POLICY_REFUSALS.queryType,
  timeOfDay: POLICY_REFUSALS.timeOfDay,
};

const MAXIMUM_WEIGHT = 0xffffffff;

const ACTIONS_ALLOWED: Record<'server' | 'zone', Partial<Record<PolicyKind, readonly PolicyAction[]>>> = {
  server: { QueryProcessing: ['DENY', 'IGNORE'], Recursion: POLICY_ACTIONS, ZoneTransfer: ['DENY', 'IGNORE'], RrlException: ['DENY'] },
  zone: { QueryProcessing: POLICY_ACTIONS, ZoneTransfer: ['DENY', 'IGNORE'] },
};

export class DnsPolicyStore {
  private readonly policies: StoredPolicy[] = [];

  constructor(private readonly environment: PolicyEnvironment) {}

  list(scope: PolicyScope): PolicyView[] {
    const rank = (policy: StoredPolicy): number => scope.kinds.indexOf(policy.kind);
    return this.within(scope).sort((left, right) => rank(left) - rank(right) || byProcessingOrder(left, right)).map(policy => this.view(policy));
  }

  find(scope: PolicyScope, name: string): PolicyView | null {
    const policy = this.named(scope, name);
    return policy === undefined ? null : this.view(policy);
  }

  create(scope: PolicyScope, spec: NewPolicy): string | null {
    const criteria = this.parse(spec.criteria);
    if (typeof criteria === 'string') return criteria;
    const level = scope.zone === null ? 'server' : 'zone';
    const allowed = ACTIONS_ALLOWED[level][spec.kind];
    if (allowed === undefined || !allowed.includes(spec.action)) return POLICY_REFUSALS.invalidSettings;
    if ((spec.action === 'ALLOW') !== (spec.content.length > 0)) return POLICY_REFUSALS.invalidSettings;
    if (Object.keys(criteria).length === 0) return POLICY_REFUSALS.invalidSettings;
    const group = this.group(scope.zone, spec.kind);
    if (spec.processingOrder !== undefined && spec.processingOrder > group.length) return POLICY_REFUSALS.invalidSettings;
    if (this.policies.some(policy => policy.zone === scope.zone && sameName(policy.name, spec.name))) return POLICY_REFUSALS.exists;
    const refusal = this.checkContent(spec.kind, scope.zone, spec.content);
    if (refusal !== null) return refusal;
    const order = spec.processingOrder === undefined || spec.processingOrder === 0 ? group.length + 1 : spec.processingOrder;
    for (const policy of group) if (policy.order >= order) policy.order += 1;
    this.policies.push({
      name: spec.name, kind: spec.kind, zone: scope.zone, action: spec.action, condition: spec.condition,
      enabled: spec.enabled, order, criteria, content: spec.content.map(entry => ({ ...entry })),
    });
    return null;
  }

  change(scope: PolicyScope, name: string, changes: PolicyChanges): string | null {
    const policy = this.named(scope, name);
    if (policy === undefined) return POLICY_REFUSALS.missing;
    const given = this.parse(changes.criteria ?? {});
    if (typeof given === 'string') return given;
    const group = this.group(policy.zone, policy.kind);
    if (changes.processingOrder !== undefined && changes.processingOrder > group.length) return POLICY_REFUSALS.invalidSettings;
    const order = changes.processingOrder === 0 ? group.length : changes.processingOrder;
    if (changes.content !== undefined) {
      if ((policy.action === 'ALLOW') !== (changes.content.length > 0)) return POLICY_REFUSALS.invalidSettings;
      const refusal = this.checkContent(policy.kind, policy.zone, changes.content);
      if (refusal !== null) return refusal;
    }
    policy.criteria = { ...policy.criteria, ...given };
    if (changes.condition !== undefined) policy.condition = changes.condition;
    if (changes.content !== undefined) policy.content = changes.content.map(entry => ({ ...entry }));
    if (order !== undefined) this.move(policy, order);
    return null;
  }

  remove(scope: PolicyScope, name: string): string | null {
    const policy = this.named(scope, name);
    if (policy === undefined) return POLICY_REFUSALS.missing;
    this.policies.splice(this.policies.indexOf(policy), 1);
    for (const other of this.group(policy.zone, policy.kind)) if (other.order > policy.order) other.order -= 1;
    return null;
  }

  setEnabled(scope: PolicyScope, name: string | null, enabled: boolean): string | null {
    if (name === null) {
      for (const policy of this.within(scope)) policy.enabled = enabled;
      return null;
    }
    const policy = this.named(scope, name);
    if (policy === undefined) return POLICY_REFUSALS.missing;
    policy.enabled = enabled;
    return null;
  }

  removeZone(zone: string): void {
    for (let index = this.policies.length - 1; index >= 0; index--) {
      if (this.policies[index].zone === zone) this.policies.splice(index, 1);
    }
  }

  referencesClientSubnet(name: string): boolean {
    const wanted = name.toLowerCase();
    return this.policies.some(policy => {
      const expression = policy.criteria.clientSubnet;
      return expression !== undefined && [...expression.equal, ...expression.different].some(value => value.toLowerCase() === wanted);
    });
  }

  decide(zone: string | null, kind: PolicyKind, facts: PolicyFacts): PolicyView | null {
    const deciding = this.group(zone, kind).find(policy => policy.enabled && this.holds(policy, facts));
    return deciding === undefined ? null : this.view(deciding);
  }

  private named(scope: PolicyScope, name: string): StoredPolicy | undefined {
    return this.within(scope).find(policy => sameName(policy.name, name));
  }

  private within(scope: PolicyScope): StoredPolicy[] {
    return this.policies.filter(policy => policy.zone === scope.zone && scope.kinds.includes(policy.kind));
  }

  private group(zone: string | null, kind: PolicyKind): StoredPolicy[] {
    return this.policies.filter(policy => policy.zone === zone && policy.kind === kind).sort(byProcessingOrder);
  }

  private move(policy: StoredPolicy, order: number): void {
    const others = this.group(policy.zone, policy.kind).filter(other => other !== policy);
    others.splice(order - 1, 0, policy);
    others.forEach((member, index) => { member.order = index + 1; });
  }

  private checkContent(kind: PolicyKind, zone: string | null, content: readonly PolicyContentEntry[]): string | null {
    if (content.some(entry => entry.weight < 1 || entry.weight > MAXIMUM_WEIGHT || !Number.isInteger(entry.weight))) {
      return POLICY_REFUSALS.invalidWeight;
    }
    return content.every(entry => this.environment.scopeExists(kind, zone, entry.scope)) ? null : POLICY_REFUSALS.scopeMissing;
  }

  private holds(policy: StoredPolicy, facts: PolicyFacts): boolean {
    const results = POLICY_CRITERION_TYPES.flatMap(type => {
      const expression = policy.criteria[type];
      return expression === undefined ? [] : [this.holdsFor(type, expression, policy.condition, facts)];
    });
    if (results.length === 0) return false;
    return policy.condition === 'AND' ? results.every(result => result) : results.some(result => result);
  }

  private holdsFor(type: PolicyCriterionType, expression: CriterionExpression, condition: PolicyCondition, facts: PolicyFacts): boolean {
    switch (type) {
      case 'clientSubnet': {
        const { source } = facts;
        return source !== undefined && evaluateCriterion(expression, condition, name => this.environment.clientSubnetContains(name, source));
      }
      case 'fqdn': {
        const { queryName } = facts;
        return queryName !== null && evaluateCriterion(expression, condition, value => fqdnCriterionMatches(value, queryName));
      }
      case 'serverInterface': {
        const { destination } = facts;
        return destination !== undefined && evaluateCriterion(expression, condition, value => addressCriterionMatches(value, destination));
      }
      case 'queryType': {
        const { queryType } = facts;
        return queryType !== null && evaluateCriterion(expression, condition, value => queryTypeCriterionMatches(value, queryType));
      }
      case 'transportProtocol': {
        const { transport } = facts;
        return transport !== null && evaluateCriterion(expression, condition, value => transportCriterionMatches(value, transport));
      }
      case 'internetProtocol': {
        const { internetProtocol } = facts;
        return internetProtocol !== null
          && evaluateCriterion(expression, condition, value => internetProtocolCriterionMatches(value, internetProtocol));
      }
      case 'timeOfDay': {
        const { minuteOfDay } = facts;
        return minuteOfDay !== null && evaluateCriterion(expression, condition, value => timeRangeCriterionMatches(value, minuteOfDay));
      }
    }
  }

  private parse(given: PolicyCriteriaText): StoredCriteria | string {
    const criteria: StoredCriteria = {};
    for (const type of POLICY_CRITERION_TYPES) {
      const text = given[type];
      if (text === undefined) continue;
      const expression = parseCriterion(text);
      if (expression === null || !this.valuesAreValid(type, expression)) return CRITERION_REFUSALS[type];
      criteria[type] = expression;
    }
    return criteria;
  }

  private valuesAreValid(type: PolicyCriterionType, expression: CriterionExpression): boolean {
    const values = [...expression.equal, ...expression.different];
    switch (type) {
      case 'clientSubnet': return values.every(this.environment.clientSubnetExists);
      case 'fqdn': return values.every(isValidCriterionFqdn);
      case 'serverInterface': return values.every(isValidCriterionAddress);
      case 'queryType': return values.every(isValidCriterionQueryType);
      case 'transportProtocol': return values.every(isValidCriterionTransport);
      case 'internetProtocol': return values.every(isValidCriterionInternetProtocol);
      case 'timeOfDay': return values.every(isValidCriterionTimeRange);
    }
  }

  private view(policy: StoredPolicy): PolicyView {
    const text = (type: PolicyCriterionType): string | null => {
      const expression = policy.criteria[type];
      return expression === undefined ? null : criterionText(expression);
    };
    return {
      name: policy.name, kind: policy.kind, zone: policy.zone, action: policy.action, condition: policy.condition,
      enabled: policy.enabled, processingOrder: policy.order,
      criteria: {
        clientSubnet: text('clientSubnet'), transportProtocol: text('transportProtocol'), internetProtocol: text('internetProtocol'),
        serverInterface: text('serverInterface'), fqdn: text('fqdn'), queryType: text('queryType'), timeOfDay: text('timeOfDay'),
      },
      content: policy.content.map(entry => ({ ...entry })),
    };
  }
}

function sameName(held: string, wanted: string): boolean {
  return held.toLowerCase() === wanted.toLowerCase();
}

function byProcessingOrder(left: StoredPolicy, right: StoredPolicy): number {
  return left.order - right.order;
}
