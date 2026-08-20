import { describe, it, expect } from 'vitest';
import { evaluateTransportRules, TransportRuleStore, type TransportRule, type EvaluatedMessage } from '@/network/devices/windows/server/exchange/TransportRuleEngine';

function baseMessage(overrides: Partial<EvaluatedMessage> = {}): EvaluatedMessage {
  return { from: 'alice@mandeng.lan', to: ['bob@mandeng.lan'], subject: 'Hello', hasAttachment: false, body: 'Subject: Hello\r\n\r\nHi Bob.', ...overrides };
}

describe('TransportRuleStore (docs/PRD-Exchange.md §4.3, P6)', () => {
  it('newRule() fails for a duplicate name', () => {
    const store = new TransportRuleStore();
    const rule: TransportRule = { name: 'R1', priority: 1, conditions: [], actions: [], enabled: true };
    expect(store.newRule(rule).ok).toBe(true);
    expect(store.newRule(rule).ok).toBe(false);
  });
});

describe('evaluateTransportRules() — conditions', () => {
  it('SubjectContains matches case-insensitively', () => {
    const rules: TransportRule[] = [{ name: 'R1', priority: 1, conditions: [{ field: 'SubjectContains', value: 'confidential' }], actions: [{ kind: 'Reject', message: 'Blocked' }], enabled: true }];
    const outcome = evaluateTransportRules(rules, baseMessage({ subject: 'CONFIDENTIAL report' }));
    expect(outcome.reject?.message).toBe('Blocked');
  });

  it('a non-matching condition does not trigger the rule', () => {
    const rules: TransportRule[] = [{ name: 'R1', priority: 1, conditions: [{ field: 'SubjectContains', value: 'confidential' }], actions: [{ kind: 'Reject', message: 'Blocked' }], enabled: true }];
    const outcome = evaluateTransportRules(rules, baseMessage({ subject: 'Lunch plans' }));
    expect(outcome.reject).toBeUndefined();
  });

  it('multiple conditions on one rule are ANDed', () => {
    const rules: TransportRule[] = [{
      name: 'R1', priority: 1,
      conditions: [{ field: 'From', value: 'alice@mandeng.lan' }, { field: 'SubjectContains', value: 'urgent' }],
      actions: [{ kind: 'Reject', message: 'Blocked' }], enabled: true,
    }];
    expect(evaluateTransportRules(rules, baseMessage({ subject: 'urgent: help' })).reject).toBeDefined();
    expect(evaluateTransportRules(rules, baseMessage({ subject: 'not it' })).reject).toBeUndefined();
  });

  it('HasAttachment matches only when the message declares one', () => {
    const rules: TransportRule[] = [{ name: 'R1', priority: 1, conditions: [{ field: 'HasAttachment' }], actions: [{ kind: 'Reject', message: 'No attachments' }], enabled: true }];
    expect(evaluateTransportRules(rules, baseMessage({ hasAttachment: true })).reject).toBeDefined();
    expect(evaluateTransportRules(rules, baseMessage({ hasAttachment: false })).reject).toBeUndefined();
  });

  it('a disabled rule never matches', () => {
    const rules: TransportRule[] = [{ name: 'R1', priority: 1, conditions: [], actions: [{ kind: 'Reject', message: 'Blocked' }], enabled: false }];
    expect(evaluateTransportRules(rules, baseMessage()).reject).toBeUndefined();
  });
});

describe('evaluateTransportRules() — actions', () => {
  it('AppendDisclaimer appends text to the message body', () => {
    const rules: TransportRule[] = [{ name: 'R1', priority: 1, conditions: [], actions: [{ kind: 'AppendDisclaimer', text: 'This email is confidential.' }], enabled: true }];
    const outcome = evaluateTransportRules(rules, baseMessage());
    expect(outcome.finalBody).toContain('Hi Bob.');
    expect(outcome.finalBody).toContain('This email is confidential.');
  });

  it('RedirectTo overrides the delivery address', () => {
    const rules: TransportRule[] = [{ name: 'R1', priority: 1, conditions: [], actions: [{ kind: 'RedirectTo', address: 'archive@mandeng.lan' }], enabled: true }];
    const outcome = evaluateTransportRules(rules, baseMessage());
    expect(outcome.redirectTo).toBe('archive@mandeng.lan');
  });

  it('BlindCopyTo collects every BCC target across matching rules', () => {
    const rules: TransportRule[] = [
      { name: 'R1', priority: 1, conditions: [], actions: [{ kind: 'BlindCopyTo', address: 'audit1@mandeng.lan' }], enabled: true },
      { name: 'R2', priority: 2, conditions: [], actions: [{ kind: 'BlindCopyTo', address: 'audit2@mandeng.lan' }], enabled: true },
    ];
    const outcome = evaluateTransportRules(rules, baseMessage());
    expect(outcome.blindCopyTo).toEqual(['audit1@mandeng.lan', 'audit2@mandeng.lan']);
  });

  it('rules apply in priority order, lowest number first', () => {
    const rules: TransportRule[] = [
      { name: 'Second', priority: 2, conditions: [], actions: [{ kind: 'AppendDisclaimer', text: 'Second' }], enabled: true },
      { name: 'First', priority: 1, conditions: [], actions: [{ kind: 'AppendDisclaimer', text: 'First' }], enabled: true },
    ];
    const outcome = evaluateTransportRules(rules, baseMessage());
    expect(outcome.finalBody.indexOf('First')).toBeLessThan(outcome.finalBody.indexOf('Second'));
  });

  it('a Reject action short-circuits — later rules and actions never run', () => {
    const rules: TransportRule[] = [
      { name: 'Blocker', priority: 1, conditions: [], actions: [{ kind: 'Reject', message: 'Blocked' }], enabled: true },
      { name: 'Later', priority: 2, conditions: [], actions: [{ kind: 'BlindCopyTo', address: 'audit@mandeng.lan' }], enabled: true },
    ];
    const outcome = evaluateTransportRules(rules, baseMessage());
    expect(outcome.reject?.message).toBe('Blocked');
    expect(outcome.blindCopyTo).toEqual([]);
  });

  it('with no matching rules at all, the message passes through unchanged', () => {
    const outcome = evaluateTransportRules([], baseMessage());
    expect(outcome.reject).toBeUndefined();
    expect(outcome.redirectTo).toBeUndefined();
    expect(outcome.blindCopyTo).toEqual([]);
    expect(outcome.finalBody).toBe(baseMessage().body);
  });
});
