/**
 * PublicKeyAuthMethod — Strategy : authentication via SSH key pair.
 *
 * Reference: DESIGN-SSH-SFTP.md section 4.
 */

import { type Result, ok, err } from '../Result';
import type { SshKeyPair } from '../SshKeyPair';
import type {
  AuthMethodType,
  ISshAuthContext,
  ISshAuthMethod,
} from './ISshAuthMethod';

export class PublicKeyAuthMethod implements ISshAuthMethod {
  readonly type: AuthMethodType = 'publickey';

  constructor(private readonly keyPair: SshKeyPair) {}

  async attempt(user: string, ctx: ISshAuthContext): Promise<Result<void>> {
    if (ctx.checkPublicKey(user, this.keyPair.publicKeyContent)) {
      return ok(undefined);
    }
    return err({ kind: 'AUTH_FAILED', user, attemptsLeft: 0 });
  }

  toDisplayString(): string {
    return 'publickey';
  }
}
