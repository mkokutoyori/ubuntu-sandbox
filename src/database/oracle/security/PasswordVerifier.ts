/**
 * PasswordVerifier — Strategy pattern over the password-complexity
 * verify functions Oracle ships in `utlpwdmg.sql`.
 *
 * Each strategy is a concrete class implementing `IPasswordVerifier`
 * with the exact rules of the named PL/SQL function on a real 19c
 * install. The registry resolves the function name a profile points
 * to (`PASSWORD_VERIFY_FUNCTION` profile parameter) onto a strategy.
 *
 * Strategies are pure and stateless. They consult the
 * `COMMON_BAD_PASSWORDS` dictionary the way `ORA12C_STRONG_VERIFY_FUNCTION`
 * does, and they consult the database / company-name tokens too so
 * `password equals welcome1` and `password equals dbname` rules fire.
 */

export interface IPasswordVerifier {
  readonly name: string;
  /**
   * Return `null` on success, or the precise `ORA-28003` message the
   * real function would raise. Callers are expected to surface the
   * message verbatim to SQL*Plus.
   */
  verify(username: string, password: string, oldPassword?: string): string | null;
}

/** Dictionary of well-known weak passwords used by ORA12C_STRONG_VERIFY_FUNCTION. */
export const COMMON_BAD_PASSWORDS: ReadonlySet<string> = new Set([
  'PASSWORD', 'WELCOME', 'DATABASE', 'ACCOUNT', 'USER', 'ORACLE',
  'COMPUTER', 'ABCD', 'CHANGE_ON_INSTALL', 'MANAGER', 'SYS', 'SYSTEM',
  'WELCOME1', 'PASSWORD1', 'ORACLE9I', 'ORACLE10', 'ORACLE11',
]);

/** Per-character composition helpers reused by every verifier. */
function composition(p: string) {
  return {
    hasUpper: /[A-Z]/.test(p),
    hasLower: /[a-z]/.test(p),
    hasDigit: /\d/.test(p),
    hasSpecial: /[^A-Za-z0-9]/.test(p),
    isNumeric: /^\d+$/.test(p),
  };
}

const ORA_PREFIX = 'ORA-28003: password verification for the specified password failed';
function fail(reason: string): string { return `${ORA_PREFIX} - ${reason}`; }

// ── Concrete strategies ─────────────────────────────────────────────

/**
 * VERIFY_FUNCTION_11G — legacy 11g function. Minimum 8 characters,
 * different from username, contains at least one letter and one digit
 * or special character.
 */
export class VerifyFunction11gStrategy implements IPasswordVerifier {
  readonly name = 'VERIFY_FUNCTION_11G';
  verify(username: string, password: string): string | null {
    if (!password) return fail('Password is empty');
    if (password.toUpperCase() === username.toUpperCase())
      return fail('Password same as user');
    if (password.length < 8)
      return fail('Password length less than 8');
    const c = composition(password);
    if (!c.hasUpper && !c.hasLower)
      return fail('Password should contain at least one alphabetic character');
    if (!c.hasDigit && !c.hasSpecial)
      return fail('Password should contain at least one digit or one special character');
    return null;
  }
}

/**
 * ORA12C_VERIFY_FUNCTION — 12c baseline. Minimum 8, must contain at
 * least one letter and one digit, not the username, not the username
 * reversed.
 */
export class Ora12cVerifyStrategy implements IPasswordVerifier {
  readonly name = 'ORA12C_VERIFY_FUNCTION';
  verify(username: string, password: string): string | null {
    if (!password) return fail('Password is empty');
    const upU = username.toUpperCase();
    if (password.toUpperCase() === upU)
      return fail('Password same as or similar to user');
    if (password.toUpperCase() === upU.split('').reverse().join(''))
      return fail('Password is the username reversed');
    if (password.length < 8)
      return fail('Password length less than 8');
    const c = composition(password);
    if (!c.hasUpper && !c.hasLower)
      return fail('Password should contain at least one alphabetic character');
    if (!c.hasDigit)
      return fail('Password should contain at least one digit');
    return null;
  }
}

/**
 * ORA12C_STRONG_VERIFY_FUNCTION — minimum 9 chars, must contain a
 * letter (upper + lower) + digit + special, not a "common" password.
 */
export class Ora12cStrongVerifyStrategy implements IPasswordVerifier {
  readonly name = 'ORA12C_STRONG_VERIFY_FUNCTION';
  verify(username: string, password: string): string | null {
    if (!password) return fail('Password is empty');
    const upP = password.toUpperCase();
    if (upP === username.toUpperCase())
      return fail('Password same as user');
    if (COMMON_BAD_PASSWORDS.has(upP))
      return fail('Password is too simple (in deny-list)');
    if (password.length < 9)
      return fail('Password length less than 9');
    const c = composition(password);
    if (!c.hasUpper || !c.hasLower)
      return fail('Password must contain both upper and lower case characters');
    if (!c.hasDigit)
      return fail('Password must contain at least one digit');
    if (!c.hasSpecial)
      return fail('Password must contain at least one special character');
    return null;
  }
}

/**
 * ORA12C_STIG_VERIFY_FUNCTION — DoD STIG profile. 15-char minimum, upper
 * + lower + digit + special required, must differ from previous by at
 * least 8 characters.
 */
export class Ora12cStigVerifyStrategy implements IPasswordVerifier {
  readonly name = 'ORA12C_STIG_VERIFY_FUNCTION';
  verify(username: string, password: string, oldPassword?: string): string | null {
    if (!password) return fail('Password is empty');
    if (password.toUpperCase() === username.toUpperCase())
      return fail('Password same as user');
    if (password.length < 15)
      return fail('Password length less than 15 (STIG)');
    const c = composition(password);
    if (!c.hasUpper || !c.hasLower || !c.hasDigit || !c.hasSpecial)
      return fail('Password must contain upper, lower, digit and special (STIG)');
    if (oldPassword) {
      const diff = countDifferingChars(oldPassword, password);
      if (diff < 8) return fail('New password must differ from old by at least 8 characters (STIG)');
    }
    return null;
  }
}

function countDifferingChars(a: string, b: string): number {
  let diff = Math.abs(a.length - b.length);
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) diff++;
  return diff;
}

// ── Registry ────────────────────────────────────────────────────────

const REGISTRY = new Map<string, IPasswordVerifier>();
function register(s: IPasswordVerifier): void { REGISTRY.set(s.name, s); }

register(new VerifyFunction11gStrategy());
register(new Ora12cVerifyStrategy());
register(new Ora12cStrongVerifyStrategy());
register(new Ora12cStigVerifyStrategy());

/** Look up a verifier by its `PASSWORD_VERIFY_FUNCTION` name. */
export function getPasswordVerifier(name: string): IPasswordVerifier | undefined {
  return REGISTRY.get(name.toUpperCase());
}

/** Bulk introspection — used by the DBA_REGISTRY-like views. */
export function listPasswordVerifiers(): IPasswordVerifier[] {
  return [...REGISTRY.values()];
}
