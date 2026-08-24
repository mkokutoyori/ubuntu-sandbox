import type { FortiSchemaEnvironment } from './types';
import {
  charactersAbsentFrom, DEFAULT_PASSWORD_HISTORY_THRESHOLD,
  type PasswordHistory,
} from '../../../identity/PasswordHistory';

export type PasswordPolicyScope = 'admin-password' | 'ipsec-preshared-key';

const POLICY_PATH = 'system password-policy';

function reading(env: FortiSchemaEnvironment, attribute: string): readonly string[] {
  return env.setting(POLICY_PATH, attribute);
}

function threshold(env: FortiSchemaEnvironment, attribute: string): number {
  return Number.parseInt(reading(env, attribute)[0] ?? '', 10) || 0;
}

function countMatching(value: string, pattern: RegExp): number {
  return (value.match(pattern) ?? []).length;
}

export function passwordPolicyRefusal(
  value: string, env: FortiSchemaEnvironment, scope: PasswordPolicyScope,
): string | null {
  if (reading(env, 'status')[0] !== 'enable') return null;

  const appliesTo = reading(env, 'apply-to');
  if (appliesTo.length > 0 && !appliesTo.includes(scope)) return null;

  const minimum = threshold(env, 'minimum-length') || 8;
  if (value.length < minimum) {
    return `the password policy asks for at least ${minimum} characters.`;
  }

  const rules: ReadonlyArray<readonly [string, RegExp, string]> = [
    ['min-lower-case-letter', /[a-z]/g, 'lowercase letter'],
    ['min-upper-case-letter', /[A-Z]/g, 'uppercase letter'],
    ['min-number', /[0-9]/g, 'digit'],
    ['min-non-alphanumeric', /[^A-Za-z0-9]/g, 'non-alphanumeric character'],
  ];
  for (const [attribute, pattern, label] of rules) {
    const wanted = threshold(env, attribute);
    if (wanted > 0 && countMatching(value, pattern) < wanted) {
      return `the password policy asks for at least ${wanted} ${label}`
        + `${wanted > 1 ? 's' : ''}.`;
    }
  }
  return null;
}

export function passwordHistoryThreshold(env: FortiSchemaEnvironment): number {
  const declared = Number.parseInt(
    env.setting('system global', 'user-history-password-threshold')[0] ?? '', 10);
  return Number.isNaN(declared) ? DEFAULT_PASSWORD_HISTORY_THRESHOLD : declared;
}

export function passwordHistoryRefusal(
  name: string, value: string, env: FortiSchemaEnvironment,
  history: PasswordHistory,
): string | null {
  if (reading(env, 'status')[0] !== 'enable') return null;

  const appliesTo = reading(env, 'apply-to');
  if (appliesTo.length > 0 && !appliesTo.includes('admin-password')) return null;

  const wanted = threshold(env, 'min-change-characters');
  const previous = history.previous(name);
  if (wanted > 0 && previous !== undefined
    && charactersAbsentFrom(previous, value) < wanted) {
    return `the password policy asks for at least ${wanted} character`
      + `${wanted > 1 ? 's' : ''} that the previous password does not contain.`;
  }

  if (reading(env, 'reuse-password')[0] !== 'disable') return null;
  const kept = passwordHistoryThreshold(env);
  const reusable = Math.min(threshold(env, 'reuse-password-limit'), kept);
  if (!history.wasUsed(name, value, kept, reusable)) return null;
  return 'the password policy refuses a password that has already been used.';
}
