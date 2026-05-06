/**
 * RemoteShellSubShell — interactive remote shell sub-shell.
 *
 * Wraps an authenticated SshSession into the ISubShell interface used by
 * LinuxTerminalSession. Each line typed by the user is dispatched through
 * an SshExecChannel; the output is rendered in the terminal and the prompt
 * reflects the remote user/host.
 *
 * Reference: BRD-SSH-SFTP.md SSH-04.
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import type { ISshSession } from '@/network/protocols/ssh/session/ISshSession';
import { isOk } from '@/network/protocols/ssh/Result';

export class RemoteShellSubShell implements ISubShell {
  private cwd: string;

  constructor(
    private readonly session: ISshSession,
    private readonly remoteUser: string,
    private readonly remoteHost: string,
    initialCwd: string = '~',
  ) {
    this.cwd = initialCwd;
  }

  getPrompt(): string {
    const cwdShort = this.cwd === `/home/${this.remoteUser}` ? '~' : this.cwd;
    return `${this.remoteUser}@${this.remoteHost}:${cwdShort}$ `;
  }

  /** Ctrl+D submits an empty 'exit' line. */
  handleKey(e: KeyEvent): boolean {
    return e.key === 'd' && e.ctrlKey;
  }

  async processLine(line: string): Promise<SubShellResult> {
    const trimmed = line.trim();

    if (trimmed === 'exit' || trimmed === 'logout') {
      this.session.disconnect();
      return {
        output: ['logout', `Connection to ${this.remoteHost} closed.`],
        exit: true,
        prompt: '',
      };
    }

    if (!trimmed) return done([''], this.getPrompt());

    const channelResult = this.session.openExecChannel(trimmed);
    if (!isOk(channelResult)) {
      return done([`ssh: failed to open channel`], this.getPrompt());
    }
    const channel = channelResult.value;
    const result = await channel.execute();
    channel.close();

    const output: string[] = [];
    if (result.stdout) output.push(...result.stdout.replace(/\n$/, '').split('\n'));
    if (result.stderr) output.push(...result.stderr.replace(/\n$/, '').split('\n'));
    return done(output.length ? output : [''], this.getPrompt());
  }

  dispose(): void {
    this.session.disconnect();
  }
}

function done(output: string[], prompt: string): SubShellResult {
  return { output, exit: false, prompt };
}
