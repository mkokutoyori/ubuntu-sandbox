import type { IShell, ShellLineResult } from './IShell';
import type { InputBroker } from './input';
import {
  tryInterpretSshLaunch, finalisePendingAuth, abandonPendingAuth, SSH_PASSWORD_PROMPTS,
  type PendingSshAuth, type SshLaunchOptions,
} from './sshLauncher';

export interface NestedSshLaunch {
  readonly output: readonly string[];
  readonly pendingInput?: ShellLineResult['pendingInput'];
  readonly childShell?: IShell;
}

export class NestedSshLogin {
  private pending: PendingSshAuth | null = null;

  get awaitsPassword(): boolean {
    return this.pending !== null;
  }

  async launch(
    line: string, opts: SshLaunchOptions, broker?: InputBroker,
  ): Promise<NestedSshLaunch | null> {
    this.abandon();
    const attempt = await tryInterpretSshLaunch(line, opts);
    if (attempt === null) return null;
    if (attempt.kind !== 'pending') return attempt.result;
    if (attempt.result.pendingInput === undefined) {
      const settled = await this.settle(attempt.pendingAuth, '');
      return settled.kind === 'done' ? settled.result : { output: [] };
    }
    if (broker?.capabilities().interactive === true) {
      return this.askUntilSettled(attempt.pendingAuth, broker);
    }
    this.pending = attempt.pendingAuth;
    return attempt.result;
  }

  async answer(value: string): Promise<NestedSshLaunch> {
    const auth = this.pending;
    if (auth === null) return { output: [] };
    const settled = await this.settle(auth, value);
    if (settled.kind === 'retry') {
      return {
        output: ['Permission denied, please try again.'],
        pendingInput: { kind: 'password', promptText: `${auth.user}@${auth.host}'s password: ` },
      };
    }
    this.pending = null;
    return settled.result;
  }

  abandon(): void {
    if (this.pending === null) return;
    abandonPendingAuth(this.pending);
    this.pending = null;
  }

  private async askUntilSettled(auth: PendingSshAuth, broker: InputBroker): Promise<NestedSshLaunch> {
    const promptText = `${auth.user}@${auth.host}'s password: `;
    for (;;) {
      const password = await broker.password(promptText);
      if (password === null) {
        abandonPendingAuth(auth);
        return { output: [] };
      }
      const settled = await this.settle(auth, password);
      if (settled.kind === 'done') return settled.result;
      broker.emit('Permission denied, please try again.');
    }
  }

  private async settle(
    auth: PendingSshAuth, password: string,
  ): Promise<{ kind: 'done'; result: NestedSshLaunch } | { kind: 'retry' }> {
    const finalised = await finalisePendingAuth(auth, password);
    switch (finalised.kind) {
      case 'refused':
        return { kind: 'done', result: { output: finalised.message.split('\n') } };
      case 'exec':
        return { kind: 'done', result: { output: [...finalised.banner, ...finalised.lines] } };
      case 'success':
        return { kind: 'done', result: { output: [...finalised.banner], childShell: finalised.shell } };
      case 'bad-password':
        if (auth.attempts >= SSH_PASSWORD_PROMPTS) {
          return {
            kind: 'done',
            result: { output: [`${auth.user}@${auth.host}: Permission denied (publickey,password).`] },
          };
        }
        return { kind: 'retry' };
    }
  }
}
