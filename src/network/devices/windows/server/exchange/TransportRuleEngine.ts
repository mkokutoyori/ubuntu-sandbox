export type TransportRuleConditionField = 'From' | 'To' | 'SubjectContains' | 'HasAttachment';

export interface TransportRuleCondition {
  readonly field: TransportRuleConditionField;
  readonly value?: string;
}

export type TransportRuleAction =
  | { readonly kind: 'Reject'; readonly message: string }
  | { readonly kind: 'AppendDisclaimer'; readonly text: string }
  | { readonly kind: 'RedirectTo'; readonly address: string }
  | { readonly kind: 'BlindCopyTo'; readonly address: string };

export interface TransportRule {
  readonly name: string;
  readonly priority: number;
  readonly conditions: readonly TransportRuleCondition[];
  readonly actions: readonly TransportRuleAction[];
  enabled: boolean;
  readonly system?: boolean;
}

export interface EvaluatedMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly hasAttachment: boolean;
  readonly body: string;
}

export interface TransportRuleOutcome {
  readonly reject?: { readonly message: string };
  readonly redirectTo?: string;
  readonly blindCopyTo: readonly string[];
  readonly finalBody: string;
}

function conditionMatches(condition: TransportRuleCondition, message: EvaluatedMessage): boolean {
  switch (condition.field) {
    case 'From':
      return condition.value !== undefined && message.from.toLowerCase() === condition.value.toLowerCase();
    case 'To':
      return condition.value !== undefined && message.to.some((t) => t.toLowerCase() === condition.value!.toLowerCase());
    case 'SubjectContains':
      return condition.value !== undefined && message.subject.toLowerCase().includes(condition.value.toLowerCase());
    case 'HasAttachment':
      return message.hasAttachment;
  }
}

function ruleMatches(rule: TransportRule, message: EvaluatedMessage): boolean {
  return rule.enabled && rule.conditions.every((c) => conditionMatches(c, message));
}

export function evaluateTransportRules(rules: readonly TransportRule[], message: EvaluatedMessage): TransportRuleOutcome {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  let body = message.body;
  const blindCopyTo: string[] = [];
  let redirectTo: string | undefined;

  for (const rule of sorted) {
    if (!ruleMatches(rule, message)) continue;
    for (const action of rule.actions) {
      if (action.kind === 'Reject') return { reject: { message: action.message }, blindCopyTo, finalBody: body };
      if (action.kind === 'AppendDisclaimer') body = `${body}\r\n\r\n${action.text}`;
      if (action.kind === 'RedirectTo') redirectTo = action.address;
      if (action.kind === 'BlindCopyTo') blindCopyTo.push(action.address);
    }
  }
  return { redirectTo, blindCopyTo, finalBody: body };
}

export interface TransportRuleOpResult { ok: boolean; message: string }

export class TransportRuleStore {
  private readonly rules = new Map<string, TransportRule>();

  newRule(rule: TransportRule): TransportRuleOpResult {
    const key = rule.name.toLowerCase();
    if (this.rules.has(key)) return { ok: false, message: `New-TransportRule : A rule named '${rule.name}' already exists.` };
    this.rules.set(key, rule);
    return { ok: true, message: '' };
  }

  get(name: string): TransportRule | null {
    return this.rules.get(name.toLowerCase()) ?? null;
  }

  list(): TransportRule[] {
    return [...this.rules.values()];
  }
}
