/**
 * Authentication strategy interface and shared contracts.
 *
 * Reference: DESIGN-SSH-SFTP.md section 4.
 */

import type { Result } from '../Result';

export type AuthMethodType = 'password' | 'publickey' | 'keyboard-interactive';

/** Result of the PAM-equivalent account-phase check run after credentials verify. */
export type AccountLifecycleVerdict =
  | { ok: true; kind?: undefined }
  | { ok: false; kind: 'account-expired' | 'password-expired' };

/**
 * ISshAuthContext — server-side capabilities exposed to client auth methods.
 *
 * The client never sees the user database directly; it asks the context to
 * check the credentials it has assembled.
 */
export interface ISshAuthContext {
  checkPassword(user: string, password: string): boolean;
  checkPasswordAsync?(user: string, password: string): Promise<boolean>;
  checkPublicKey(user: string, publicKey: string): boolean;
  checkPublicKeyAsync?(user: string, publicKey: string): Promise<boolean>;
  getAttemptsRemaining(): number;
  getAvailableMethods(): readonly AuthMethodType[];
  /**
   * PAM account phase, consulted after credentials verify successfully
   * (any auth method) but before the session is granted. Optional so
   * non-Linux contexts (router/switch AAA) are unaffected.
   */
  checkAccountLifecycle?(user: string): AccountLifecycleVerdict;
}

/**
 * ISshAuthMethod — Strategy interface. Each concrete implementation
 * encapsulates one authentication algorithm.
 */
export interface ISshAuthMethod {
  readonly type: AuthMethodType;
  attempt(user: string, ctx: ISshAuthContext): Promise<Result<void>>;
  toDisplayString(): string;
}
