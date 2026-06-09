/**
 * Authentication strategy interface and shared contracts.
 *
 * Reference: DESIGN-SSH-SFTP.md section 4.
 */

import type { Result } from '../Result';

export type AuthMethodType = 'password' | 'publickey' | 'keyboard-interactive';

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
