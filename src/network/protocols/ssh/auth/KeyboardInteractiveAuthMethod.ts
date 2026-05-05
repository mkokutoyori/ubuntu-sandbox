/**
 * KeyboardInteractiveAuthMethod — Strategy : challenge/response prompts.
 *
 * Reference: DESIGN-SSH-SFTP.md section 4.
 */

import { type Result, ok, err } from '../Result';
import type {
  AuthMethodType,
  ISshAuthContext,
  ISshAuthMethod,
} from './ISshAuthMethod';

export type PromptHandler = (prompts: readonly string[]) => Promise<string[]>;

export class KeyboardInteractiveAuthMethod implements ISshAuthMethod {
  readonly type: AuthMethodType = 'keyboard-interactive';

  constructor(
    private readonly prompts: readonly string[],
    private readonly promptHandler: PromptHandler,
  ) {}

  async attempt(user: string, ctx: ISshAuthContext): Promise<Result<void>> {
    const responses = await this.promptHandler(this.prompts);
    // Convention: the last response is treated as the password.
    const password = responses[responses.length - 1] ?? '';
    if (ctx.checkPassword(user, password)) return ok(undefined);
    return err({ kind: 'AUTH_FAILED', user, attemptsLeft: 0 });
  }

  toDisplayString(): string {
    return 'keyboard-interactive';
  }
}
