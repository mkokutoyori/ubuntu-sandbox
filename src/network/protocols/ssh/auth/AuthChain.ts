/**
 * AuthChain — orchestrates a list of ISshAuthMethod strategies.
 *
 * Iterates through the methods until one succeeds or all are exhausted.
 *
 * Reference: DESIGN-SSH-SFTP.md section 4.
 */

import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { type Result, err } from '../Result';
import type { SshConnectOptions } from '../SshConnectOptions';
import { SshKeyPair } from '../SshKeyPair';
import type { ISshAuthContext, ISshAuthMethod } from './ISshAuthMethod';
import { PasswordAuthMethod, type PasswordProvider } from './PasswordAuthMethod';
import { PublicKeyAuthMethod } from './PublicKeyAuthMethod';

export class AuthChain {
  private constructor(private readonly methods: readonly ISshAuthMethod[]) {}

  static create(methods: readonly ISshAuthMethod[]): AuthChain {
    return new AuthChain(methods);
  }

  async tryAll(
    user: string,
    ctx: ISshAuthContext,
  ): Promise<Result<void>> {
    for (const method of this.methods) {
      const result = await method.attempt(user, ctx);
      if (result.ok) return result;
    }
    return err({ kind: 'AUTH_FAILED', user, attemptsLeft: 0 });
  }

  toDisplayString(): string {
    const real = this.methods.map((m) => m.toDisplayString());
    const seen = new Set(real);
    const ordered: string[] = [];
    if (!seen.has('publickey')) ordered.push('publickey');
    for (const m of real) ordered.push(m);
    if (!seen.has('password')) ordered.push('password');
    return ordered.join(',');
  }
}

/**
 * Pure factory — assembles the default auth chain from the user's VFS and
 * connection options. Public keys are tried first because they cannot be
 * brute-forced.
 */
export function createAuthMethods(
  vfs: VirtualFileSystem,
  opts: SshConnectOptions,
  passwordProvider: PasswordProvider,
): ISshAuthMethod[] {
  const methods: ISshAuthMethod[] = [];
  for (const keyPath of opts.identityFiles) {
    const pair = SshKeyPair.fromVfs(vfs, keyPath);
    if (pair.ok) methods.push(new PublicKeyAuthMethod(pair.value));
  }
  methods.push(new PasswordAuthMethod(passwordProvider));
  return methods;
}
