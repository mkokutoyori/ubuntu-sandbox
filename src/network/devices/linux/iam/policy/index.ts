/**
 * Password-policy domain — barrel export.
 *
 * The IAM layer's complete password posture: strength rules, aging defaults
 * and account-lockout rules, plus the {@link PasswordPolicy} aggregate that
 * binds them together.
 */

export { PasswordPolicy } from './PasswordPolicy';
export type { PasswordPolicySection, PolicyChange } from './PasswordPolicy';

export { PasswordQualityPolicy } from './PasswordQualityPolicy';
export type { PasswordQualityPolicyInit, PasswordQualityContext } from './PasswordQualityPolicy';

export {
  PasswordQualityResult,
  PasswordQualityRule,
} from './PasswordQualityResult';
export type { PasswordQualityViolation } from './PasswordQualityResult';

export {
  PasswordAgingPolicy,
  PASSWORD_NEVER_EXPIRES,
  AGING_DISABLED,
} from './PasswordAgingPolicy';
export type { PasswordAgingPolicyInit } from './PasswordAgingPolicy';

export { AccountLockoutPolicy } from './AccountLockoutPolicy';
export type { AccountLockoutPolicyInit } from './AccountLockoutPolicy';
