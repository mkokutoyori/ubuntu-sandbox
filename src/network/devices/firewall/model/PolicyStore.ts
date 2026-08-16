import { IMPLICIT_RULE_ID, makeRule, type SecurityRule, type SecurityRuleInit } from './SecurityRule';

export type PolicyError =
  | { kind: 'duplicate-rule'; id: string }
  | { kind: 'unknown-rule'; id: string }
  | { kind: 'implicit-rule'; id: string };

export type PolicyMutation = { ok: true } | { ok: false; error: PolicyError };

const POLICY_OK: PolicyMutation = Object.freeze({ ok: true as const });

function failure(error: PolicyError): PolicyMutation {
  return Object.freeze({ ok: false as const, error: Object.freeze(error) });
}

export type MovePosition = 'before' | 'after';

export interface PolicyStatistics {
  readonly total: number;
  readonly enabled: number;
  readonly disabled: number;
  readonly totalHits: number;
}

export interface PolicyStoreView {
  ordered(): readonly SecurityRule[];
  orderedWithImplicit(): readonly SecurityRule[];
  byId(id: string): SecurityRule | undefined;
  implicitRule(): SecurityRule;
  statistics(): PolicyStatistics;
}

export type RuleDraft = Omit<SecurityRuleInit, 'seq'> & { seq?: number };

const PREDEFINED_OBJECT_NAMES: readonly string[] = Object.freeze(['any', 'all']);
const SEQ_STEP = 10;

export class PolicyStore {
  private rules: SecurityRule[] = [];
  private readonly implicit: SecurityRule;
  private readonly now: () => number;

  constructor(deps: { now?: () => number; implicitAction?: SecurityRule['action'] } = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.implicit = makeRule({
      id: IMPLICIT_RULE_ID, seq: Number.MAX_SAFE_INTEGER, name: 'implicit',
      action: deps.implicitAction ?? 'deny', implicit: true,
    });
  }

  append(draft: RuleDraft): PolicyMutation {
    return this.insertAt(this.rules.length, draft);
  }

  insertAt(index: number, draft: RuleDraft): PolicyMutation {
    if (this.byId(draft.id)) return failure({ kind: 'duplicate-rule', id: draft.id });

    const rule = makeRule({ ...draft, seq: 0, createdAt: this.now() });
    const at = Math.max(0, Math.min(index, this.rules.length));
    this.rules.splice(at, 0, rule);
    this.renumber();
    return POLICY_OK;
  }

  move(id: string, position: MovePosition, targetId: string): PolicyMutation {
    const from = this.indexOf(id);
    if (from < 0) return failure({ kind: 'unknown-rule', id });
    if (this.indexOf(targetId) < 0) return failure({ kind: 'unknown-rule', id: targetId });
    if (id === targetId) return POLICY_OK;

    const [rule] = this.rules.splice(from, 1);
    const target = this.indexOf(targetId);
    this.rules.splice(position === 'before' ? target : target + 1, 0, rule);
    this.renumber();
    return POLICY_OK;
  }

  moveTop(id: string): PolicyMutation {
    return this.reposition(id, 0);
  }

  moveBottom(id: string): PolicyMutation {
    return this.reposition(id, this.rules.length - 1);
  }

  enable(id: string): PolicyMutation {
    return this.mutate(id, rule => { rule.enabled = true; });
  }

  disable(id: string): PolicyMutation {
    return this.mutate(id, rule => { rule.enabled = false; });
  }

  clone(id: string, newId: string): PolicyMutation {
    const source = this.byId(id);
    if (!source) return failure({ kind: 'unknown-rule', id });
    if (this.byId(newId)) return failure({ kind: 'duplicate-rule', id: newId });

    const copy = makeRule({
      ...source, id: newId, seq: 0, createdAt: this.now(),
      name: source.name === undefined ? undefined : `${source.name}-copy`,
    });
    this.rules.splice(this.indexOf(id) + 1, 0, copy);
    this.renumber();
    return POLICY_OK;
  }

  remove(id: string): PolicyMutation {
    if (id === this.implicit.id) return failure({ kind: 'implicit-rule', id });

    const index = this.indexOf(id);
    if (index < 0) return failure({ kind: 'unknown-rule', id });

    this.rules.splice(index, 1);
    this.renumber();
    return POLICY_OK;
  }

  resetCounters(id?: string): PolicyMutation {
    if (id === undefined) {
      for (const rule of this.rules) clearCounters(rule);
      clearCounters(this.implicit);
      return POLICY_OK;
    }
    return this.mutate(id, clearCounters);
  }

  byId(id: string): SecurityRule | undefined {
    if (id === this.implicit.id) return this.implicit;
    return this.rules.find(rule => rule.id === id);
  }

  implicitRule(): SecurityRule {
    return this.implicit;
  }

  ordered(): readonly SecurityRule[] {
    return Object.freeze([...this.rules]);
  }

  orderedWithImplicit(): readonly SecurityRule[] {
    return Object.freeze([...this.rules, this.implicit]);
  }

  size(): number {
    return this.rules.length;
  }

  zoneReferents(zoneName: string): readonly string[] {
    return this.referentsWhere(rule =>
      rule.from.includes(zoneName) || rule.to.includes(zoneName));
  }

  objectReferents(objectName: string): readonly string[] {
    if (PREDEFINED_OBJECT_NAMES.includes(objectName)) return Object.freeze([]);
    return this.referentsWhere(rule =>
      rule.source.includes(objectName)
      || rule.destination.includes(objectName)
      || rule.service.includes(objectName));
  }

  view(): PolicyStoreView {
    return {
      ordered: () => this.ordered(),
      orderedWithImplicit: () => this.orderedWithImplicit(),
      byId: (id) => this.byId(id),
      implicitRule: () => this.implicit,
      statistics: () => this.statistics(),
    };
  }

  statistics(): PolicyStatistics {
    const enabled = this.rules.filter(rule => rule.enabled).length;
    return Object.freeze({
      total: this.rules.length,
      enabled,
      disabled: this.rules.length - enabled,
      totalHits: this.rules.reduce((sum, rule) => sum + rule.hitCount, 0),
    });
  }

  private referentsWhere(predicate: (rule: SecurityRule) => boolean): readonly string[] {
    return Object.freeze(
      this.rules.filter(predicate).map(rule => `security rule "${rule.name ?? rule.id}"`));
  }

  private reposition(id: string, index: number): PolicyMutation {
    const from = this.indexOf(id);
    if (from < 0) return failure({ kind: 'unknown-rule', id });

    const [rule] = this.rules.splice(from, 1);
    this.rules.splice(index, 0, rule);
    this.renumber();
    return POLICY_OK;
  }

  private mutate(id: string, change: (rule: SecurityRule) => void): PolicyMutation {
    const rule = this.byId(id);
    if (!rule) return failure({ kind: 'unknown-rule', id });

    change(rule);
    rule.modifiedAt = this.now();
    return POLICY_OK;
  }

  private indexOf(id: string): number {
    return this.rules.findIndex(rule => rule.id === id);
  }

  private renumber(): void {
    this.rules.forEach((rule, index) => { rule.seq = (index + 1) * SEQ_STEP; });
  }
}

function clearCounters(rule: SecurityRule): void {
  rule.hitCount = 0;
  rule.byteCount = 0;
  rule.lastHitAt = undefined;
}
