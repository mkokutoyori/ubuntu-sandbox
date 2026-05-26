/**
 * RemoteShellSubShell — interactive remote shell sub-shell.
 *
 * Wraps an authenticated SshSession into the ISubShell interface used by
 * LinuxTerminalSession. Each line typed by the user is dispatched through
 * an SshExecChannel.
 *
 * CWD is tracked client-side: after every `cd` the sub-shell runs `pwd` on
 * the remote to get the canonical path, and every subsequent command is
 * prefixed with `cd <cwd> &&` to restore context (exec channels are stateless).
 *
 * Reference: BRD-SSH-SFTP.md SSH-04.
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import type { ISshSession } from '@/network/protocols/ssh/session/ISshSession';
import { isOk } from '@/network/protocols/ssh/Result';

export class RemoteShellSubShell implements ISubShell {
  readonly kind = 'remote-shell';
  readonly connection = 'ssh' as const;
  private cwd: string;

  constructor(
    private readonly session: ISshSession,
    private readonly remoteUser: string,
    private readonly remoteHost: string,
    initialCwd: string = '~',
  ) {
    this.cwd = initialCwd === '~' ? `/home/${remoteUser}` : initialCwd;
  }

  getPrompt(): string {
    const homeDir = `/home/${this.remoteUser}`;
    const cwdShort = this.cwd === homeDir ? '~' : this.cwd;
    return `${this.remoteUser}@${this.remoteHost}:${cwdShort}$ `;
  }

  /** Ctrl+D exits the sub-shell. */
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

    // clear: signal the host terminal to wipe the screen (Ctrl+L also works)
    if (trimmed === 'clear') {
      return { output: [''], exit: false, prompt: this.getPrompt(), clearScreen: true };
    }

    // cd: execute with a trailing `&& pwd` so we can capture the new CWD
    if (/^cd(\s|$)/.test(trimmed)) {
      return this.handleCd(trimmed);
    }

    // All other commands are prefixed with the stored CWD so that stateless
    // exec channels always run in the correct directory.
    const exec = this.prefixCwd(trimmed);
    const channelResult = this.session.openExecChannel(exec);
    if (!isOk(channelResult)) {
      return done(['ssh: failed to open channel'], this.getPrompt());
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

  // ─── private ────────────────────────────────────────────────────

  /**
   * Run `<cdCmd> && pwd` remotely. On success the last stdout line is the
   * new canonical CWD; on failure the stderr is shown and CWD is unchanged.
   */
  private async handleCd(cdCmd: string): Promise<SubShellResult> {
    const channelResult = this.session.openExecChannel(`${cdCmd} && pwd`);
    if (!isOk(channelResult)) {
      return done(['ssh: failed to open channel'], this.getPrompt());
    }
    const channel = channelResult.value;
    const result = await channel.execute();
    channel.close();

    const succeeded = result.exitCode === 0 || (!result.stderr && result.stdout.trim().startsWith('/'));
    if (succeeded) {
      const lines = result.stdout.trim().split('\n');
      const newCwd = lines[lines.length - 1];
      if (newCwd && newCwd.startsWith('/')) this.cwd = newCwd;
      return done([''], this.getPrompt());
    }

    const errLines = result.stderr
      ? result.stderr.replace(/\n$/, '').split('\n')
      : ['cd: no such file or directory'];
    return done(errLines, this.getPrompt());
  }

  /**
   * Prefix a command with `cd <cwd> 2>/dev/null && ` so it runs in the
   * correct directory across stateless exec channels.
   * Home directory needs no prefix (it's the shell default).
   */
  private prefixCwd(cmd: string): string {
    const homeDir = `/home/${this.remoteUser}`;
    if (this.cwd === homeDir) return cmd;
    return `cd ${JSON.stringify(this.cwd)} 2>/dev/null && ${cmd}`;
  }
}

function done(output: string[], prompt: string): SubShellResult {
  return { output, exit: false, prompt };
}
