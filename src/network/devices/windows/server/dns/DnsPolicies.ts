import type { IPAddress, IPv6Address } from '@/network/core/types';
import {
  addressCriterionMatches, criterionText, evaluateCriterion, fqdnCriterionMatches, isValidCriterionAddress,
  isValidCriterionFqdn, parseCriterion, type CriterionExpression, type PolicyCondition,
} from './DnsPolicyCriteria';

export type PolicyCriterionType = 'clientSubnet' | 'fqdn' | 'serverInterface';

export interface PolicyCriteriaText {
  readonly clientSubnet?: string;
  readonly fqdn?: string;
  readonly serverInterface?: string;
}

export interface PolicyView {
  readonly name: string;
  readonly condition: PolicyCondition;
  readonly clientSubnet: string | null;
  readonly fqdn: string | null;
  readonly serverInterface: string | null;
}

export interface PolicyFacts {
  readonly queryName: string | null;
  readonly source?: IPAddress | IPv6Address;
  readonly destination?: IPAddress | IPv6Address;
}

export interface PolicyEnvironment {
  readonly clientSubnetExists: (name: string) => boolean;
  readonly clientSubnetContains: (name: string, address: IPAddress | IPv6Address) => boolean;
}

export const POLICY_REFUSALS = {
  exists: 'A policy with the same name already exists on this level (server level or zone level) on the DNS server.',
  missing: 'No policy with this name exists on this level (server level or zone level) on the DNS server.',
  invalidSettings: 'At least one of the settings of this policy is invalid.',
  clientSubnet: 'The criterion client subnet provided in the policy is invalid.',
  serverInterface: 'The criterion interface provided in the policy is invalid.',
  fqdn: 'The criterion FQDN provided in the policy is invalid.',
} as const;

type StoredCriteria = Partial<Record<PolicyCriterionType, CriterionExpression>>;

interface StoredPolicy {
  readonly name: string;
  condition: PolicyCondition;
  criteria: StoredCriteria;
}

const CRITERION_TYPES: readonly PolicyCriterionType[] = ['clientSubnet', 'fqdn', 'serverInterface'];

export class DnsPolicyStore {
  private readonly policies = new Map<string, StoredPolicy>();

  constructor(private readonly environment: PolicyEnvironment) {}

  list(): PolicyView[] {
    return [...this.policies.values()].map(policy => this.view(policy));
  }

  find(name: string): PolicyView | null {
    const policy = this.policies.get(name.toLowerCase());
    return policy === undefined ? null : this.view(policy);
  }

  create(name: string, condition: PolicyCondition, given: PolicyCriteriaText): string | null {
    if (this.policies.has(name.toLowerCase())) return POLICY_REFUSALS.exists;
    const criteria = this.parse(given);
    if (typeof criteria === 'string') return criteria;
    if (Object.keys(criteria).length === 0) return POLICY_REFUSALS.invalidSettings;
    this.policies.set(name.toLowerCase(), { name, condition, criteria });
    return null;
  }

  change(name: string, condition: PolicyCondition | undefined, given: PolicyCriteriaText): string | null {
    const policy = this.policies.get(name.toLowerCase());
    if (policy === undefined) return POLICY_REFUSALS.missing;
    const criteria = this.parse(given);
    if (typeof criteria === 'string') return criteria;
    policy.criteria = { ...policy.criteria, ...criteria };
    if (condition !== undefined) policy.condition = condition;
    return null;
  }

  remove(name: string): string | null {
    return this.policies.delete(name.toLowerCase()) ? null : POLICY_REFUSALS.missing;
  }

  referencesClientSubnet(name: string): boolean {
    const wanted = name.toLowerCase();
    return [...this.policies.values()].some(policy => {
      const expression = policy.criteria.clientSubnet;
      return expression !== undefined && [...expression.equal, ...expression.different].some(value => value.toLowerCase() === wanted);
    });
  }

  matches(facts: PolicyFacts): boolean {
    return [...this.policies.values()].some(policy => this.holds(policy, facts));
  }

  private holds(policy: StoredPolicy, facts: PolicyFacts): boolean {
    const results = CRITERION_TYPES.flatMap(type => {
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
    }
  }

  private parse(given: PolicyCriteriaText): StoredCriteria | string {
    const criteria: StoredCriteria = {};
    const refusals: Record<PolicyCriterionType, string> = {
      clientSubnet: POLICY_REFUSALS.clientSubnet, fqdn: POLICY_REFUSALS.fqdn, serverInterface: POLICY_REFUSALS.serverInterface,
    };
    for (const type of CRITERION_TYPES) {
      const text = given[type];
      if (text === undefined) continue;
      const expression = parseCriterion(text);
      if (expression === null || !this.valuesAreValid(type, expression)) return refusals[type];
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
    }
  }

  private view(policy: StoredPolicy): PolicyView {
    const text = (type: PolicyCriterionType): string | null => {
      const expression = policy.criteria[type];
      return expression === undefined ? null : criterionText(expression);
    };
    return {
      name: policy.name, condition: policy.condition,
      clientSubnet: text('clientSubnet'), fqdn: text('fqdn'), serverInterface: text('serverInterface'),
    };
  }
}
