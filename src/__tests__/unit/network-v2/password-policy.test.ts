/**
 * Password-policy domain model — unit tests.
 *
 * Exercises the three sub-policies and the {@link PasswordPolicy} aggregate
 * that make up a host's password posture:
 *   - PasswordQualityPolicy  — the `pam_pwquality` strength check
 *   - PasswordAgingPolicy    — the system-wide aging defaults
 *   - AccountLockoutPolicy   — the `pam_faillock` lockout rules
 *
 * Coverage spans the happy path and the awkward edges: empty input, length
 * credits, negative (class-minimum) credits, repeats, monotonic sequences,
 * similarity, palindromes, username/GECOS containment and dictionary words.
 */

import { describe, it, expect } from 'vitest';
import { PasswordQualityPolicy } from '@/network/devices/linux/iam/policy/PasswordQualityPolicy';
import { PasswordQualityRule } from '@/network/devices/linux/iam/policy/PasswordQualityResult';
import {
  PasswordAgingPolicy,
  PASSWORD_NEVER_EXPIRES,
} from '@/network/devices/linux/iam/policy/PasswordAgingPolicy';
import { AccountLockoutPolicy } from '@/network/devices/linux/iam/policy/AccountLockoutPolicy';
import { PasswordPolicy } from '@/network/devices/linux/iam/policy/PasswordPolicy';

// ═══════════════════════════════════════════════════════════════════
// PasswordQualityPolicy
// ═══════════════════════════════════════════════════════════════════

describe('PasswordQualityPolicy — evaluation', () => {
  it('accepts a strong password under the default policy', () => {
    const result = PasswordQualityPolicy.defaults().evaluate('Abcdef1!xy');
    expect(result.acceptable).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('rejects an empty password with a single Empty violation', () => {
    const result = PasswordQualityPolicy.defaults().evaluate('');
    expect(result.acceptable).toBe(false);
    expect(result.failedRules).toEqual([PasswordQualityRule.Empty]);
  });

  it('rejects a password shorter than the credited minimum length', () => {
    // 3 chars + 3 class credits = 6 credited, still below the minlen of 8.
    const result = PasswordQualityPolicy.defaults().evaluate('Aa1');
    expect(result.violated(PasswordQualityRule.MinLength)).toBe(true);
  });

  it('counts per-class credits towards the required length', () => {
    // 7 chars + 4 class credits (one each) = 11 credited ≥ 8 → length ok.
    const result = PasswordQualityPolicy.defaults().evaluate('aB3!cdz');
    expect(result.violated(PasswordQualityRule.MinLength)).toBe(false);
  });

  it('treats a negative credit as a class minimum', () => {
    const policy = new PasswordQualityPolicy({ digitCredit: -2, minLength: 4 });
    const result = policy.evaluate('abcdefgh');
    expect(result.violated(PasswordQualityRule.MinDigits)).toBe(true);
  });

  it('enforces a minimum number of character classes', () => {
    const policy = new PasswordQualityPolicy({ minClasses: 3, minLength: 4 });
    expect(policy.evaluate('abcdefghij').violated(PasswordQualityRule.MinClasses)).toBe(true);
    expect(policy.evaluate('Abcdef1jij').violated(PasswordQualityRule.MinClasses)).toBe(false);
  });

  it('rejects too many identical characters in a row', () => {
    const policy = new PasswordQualityPolicy({ maxRepeat: 2, minLength: 4 });
    expect(policy.evaluate('aaabcdef').violated(PasswordQualityRule.MaxRepeat)).toBe(true);
    expect(policy.evaluate('aabbccdd').violated(PasswordQualityRule.MaxRepeat)).toBe(false);
  });

  it('rejects a monotonic sequence longer than maxsequence', () => {
    const policy = new PasswordQualityPolicy({ maxSequence: 3, minLength: 4 });
    expect(policy.evaluate('abcdezzz').violated(PasswordQualityRule.MaxSequence)).toBe(true);
    expect(policy.evaluate('4321zzzz').violated(PasswordQualityRule.MaxSequence)).toBe(true);
  });

  it('rejects a password too similar to the previous one', () => {
    const policy = new PasswordQualityPolicy({ difOk: 4, minLength: 4 });
    const result = policy.evaluate('abcdefgX', { oldPassword: 'abcdefgh' });
    expect(result.violated(PasswordQualityRule.TooSimilar)).toBe(true);
  });

  it('rejects a password identical to the previous one', () => {
    const result = PasswordQualityPolicy.defaults().evaluate('Abcdef1!xy', {
      oldPassword: 'Abcdef1!xy',
    });
    expect(result.violated(PasswordQualityRule.TooSimilar)).toBe(true);
  });

  it('rejects a password containing the user name', () => {
    const result = PasswordQualityPolicy.defaults().evaluate('XaliceY1!z', {
      username: 'alice',
    });
    expect(result.violated(PasswordQualityRule.ContainsUsername)).toBe(true);
  });

  it('rejects a password containing a word from the GECOS field', () => {
    const result = PasswordQualityPolicy.defaults().evaluate('Carpenter1!', {
      gecos: 'John Carpenter,Room 4',
    });
    expect(result.violated(PasswordQualityRule.ContainsGecos)).toBe(true);
  });

  it('rejects a dictionary word', () => {
    const result = PasswordQualityPolicy.defaults().evaluate('password');
    expect(result.violated(PasswordQualityRule.DictionaryWord)).toBe(true);
  });

  it('rejects a palindrome', () => {
    const policy = new PasswordQualityPolicy({ minLength: 4, dictCheck: false });
    expect(policy.evaluate('Ab1!1bA').violated(PasswordQualityRule.Palindrome)).toBe(true);
  });

  it('surfaces a faithful BAD PASSWORD line for the first violation', () => {
    const line = PasswordQualityPolicy.defaults().evaluate('ab').toBadPasswordLine();
    expect(line).toMatch(/^BAD PASSWORD: /);
  });
});

describe('PasswordQualityPolicy — enforcement scope', () => {
  it('blocks non-root callers when enforcing', () => {
    expect(PasswordQualityPolicy.defaults().blocksFor(1000)).toBe(true);
  });

  it('only warns root unless enforce_for_root is set', () => {
    expect(PasswordQualityPolicy.defaults().blocksFor(0)).toBe(false);
    expect(new PasswordQualityPolicy({ enforceForRoot: true }).blocksFor(0)).toBe(true);
  });

  it('never blocks anyone when not enforcing', () => {
    const policy = new PasswordQualityPolicy({ enforcing: false });
    expect(policy.blocksFor(0)).toBe(false);
    expect(policy.blocksFor(1000)).toBe(false);
  });
});

describe('PasswordQualityPolicy — rendering & overrides', () => {
  it('renders the canonical pwquality.conf directives', () => {
    const content = PasswordQualityPolicy.defaults().render();
    expect(content).toContain('minlen = 8');
    expect(content).toContain('dcredit = 1');
    expect(content).toContain('enforcing = 1');
    expect(content).toContain('retry = 3');
  });

  it('applies overrides and reports the changed fields', () => {
    const policy = PasswordQualityPolicy.defaults();
    const changed = policy.apply({ minLength: 12, minClasses: 3 });
    expect(changed.sort()).toEqual(['minClasses', 'minLength']);
    expect(policy.minLength).toBe(12);
  });

  it('reports no change when an override matches the current value', () => {
    expect(PasswordQualityPolicy.defaults().apply({ minLength: 8 })).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PasswordAgingPolicy
// ═══════════════════════════════════════════════════════════════════

describe('PasswordAgingPolicy', () => {
  it('defaults to a never-expiring password', () => {
    const aging = PasswordAgingPolicy.defaults();
    expect(aging.maxDays).toBe(PASSWORD_NEVER_EXPIRES);
    expect(aging.neverExpires).toBe(true);
  });

  it('returns a new instance from withChanges, leaving the original intact', () => {
    const base = PasswordAgingPolicy.defaults();
    const next = base.withChanges({ maxDays: 90, warnDays: 14 });
    expect(next.maxDays).toBe(90);
    expect(next.warnDays).toBe(14);
    expect(base.maxDays).toBe(PASSWORD_NEVER_EXPIRES);
  });

  it('diffs two policies field by field', () => {
    const base = PasswordAgingPolicy.defaults();
    const next = base.withChanges({ maxDays: 60, minDays: 1 });
    expect(next.diff(base).sort()).toEqual(['maxDays', 'minDays']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// AccountLockoutPolicy
// ═══════════════════════════════════════════════════════════════════

describe('AccountLockoutPolicy', () => {
  it('locks an account once the deny threshold is reached', () => {
    const policy = AccountLockoutPolicy.defaults();
    expect(policy.shouldLockOut(2)).toBe(false);
    expect(policy.shouldLockOut(3)).toBe(true);
  });

  it('exempts root unless even_deny_root is set', () => {
    expect(AccountLockoutPolicy.defaults().shouldLockOut(5, true)).toBe(false);
    expect(new AccountLockoutPolicy({ evenDenyRoot: true }).shouldLockOut(5, true)).toBe(true);
  });

  it('treats deny=0 as lockout disabled', () => {
    const policy = new AccountLockoutPolicy({ deny: 0 });
    expect(policy.enabled).toBe(false);
    expect(policy.shouldLockOut(100)).toBe(false);
  });

  it('reports the attempts remaining before the lock trips', () => {
    expect(AccountLockoutPolicy.defaults().attemptsRemaining(1)).toBe(2);
    expect(AccountLockoutPolicy.defaults().attemptsRemaining(9)).toBe(0);
  });

  it('renders the canonical faillock.conf directives', () => {
    const content = AccountLockoutPolicy.defaults().render();
    expect(content).toContain('deny = 3');
    expect(content).toContain('unlock_time = 600');
    expect(content).toContain('dir = /var/run/faillock');
  });
});

// ═══════════════════════════════════════════════════════════════════
// PasswordPolicy aggregate
// ═══════════════════════════════════════════════════════════════════

describe('PasswordPolicy aggregate', () => {
  it('composes the three default sub-policies', () => {
    const policy = PasswordPolicy.defaults();
    expect(policy.quality.minLength).toBe(8);
    expect(policy.aging.neverExpires).toBe(true);
    expect(policy.lockout.deny).toBe(3);
  });

  it('reports a quality change with its section and fields', () => {
    const change = PasswordPolicy.defaults().configureQuality({ minLength: 14 });
    expect(change).toEqual({ section: 'quality', changedFields: ['minLength'] });
  });

  it('reports an aging change and swaps in the new immutable value object', () => {
    const policy = PasswordPolicy.defaults();
    const change = policy.configureAging({ maxDays: 30 });
    expect(change).toEqual({ section: 'aging', changedFields: ['maxDays'] });
    expect(policy.aging.maxDays).toBe(30);
  });

  it('reports a lockout change', () => {
    const change = PasswordPolicy.defaults().configureLockout({ deny: 5 });
    expect(change).toEqual({ section: 'lockout', changedFields: ['deny'] });
  });

  it('returns null for a no-op reconfiguration', () => {
    expect(PasswordPolicy.defaults().configureQuality({ minLength: 8 })).toBeNull();
  });
});
