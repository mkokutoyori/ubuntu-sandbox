/**
 * PasswordAuthMethod — Strategy : authentication via password.
 *
 * Reference: DESIGN-SSH-SFTP.md section 4.
 */

import { type Result, ok, err } from '../Result';
import type {
  AuthMethodType,
  ISshAuthContext,
  ISshAuthMethod,
} from './ISshAuthMethod';

export type PasswordProvider = (
  user: string,
  attemptsLeft: number,
) => Promise<string>;

export class PasswordAuthMethod implements ISshAuthMethod {
  readonly type: AuthMethodType = 'password';

  constructor(
    private readonly passwordProvider: PasswordProvider,
    private readonly maxAttempts: number = 3,
  ) {}

  async attempt(user: string, ctx: ISshAuthContext): Promise<Result<void>> {
    let attemptsLeft = Math.min(this.maxAttempts, ctx.getAttemptsRemaining());
    while (attemptsLeft > 0) {
      const password = await this.passwordProvider(user, attemptsLeft);
      const accepted = ctx.checkPasswordAsync
        ? await ctx.checkPasswordAsync(user, password)
        : ctx.checkPassword(user, password);
      if (accepted) return ok(undefined);
      attemptsLeft -= 1;
    }
    return err({ kind: 'AUTH_FAILED', user, attemptsLeft: 0 });
  }

  toDisplayString(): string {
    return 'password';
  }
}
