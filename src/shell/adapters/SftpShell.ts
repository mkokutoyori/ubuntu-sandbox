import { AbstractShell, type AbstractShellOptions } from '../AbstractShell';
import type { ShellLineResult } from '../IShell';
import { SftpSubShell } from '@/terminal/subshells/SftpSubShell';
import type { SftpSession } from '@/network/protocols/ssh/sftp/SftpSession';

export interface SftpShellOptions extends AbstractShellOptions {
  readonly sftpSession: SftpSession;
}

export class SftpShell extends AbstractShell {
  readonly kind = 'sftp';

  private readonly subShell: SftpSubShell;

  constructor(opts: SftpShellOptions) {
    super(opts);
    this.subShell = new SftpSubShell(opts.sftpSession);
    this.exitWords = new Set(['exit', 'quit', 'bye', 'logout']);
  }

  getPrompt(): string { return this.subShell.getPrompt(); }

  protected async dispatch(line: string): Promise<ShellLineResult> {
    const r = await this.subShell.processLine(line);
    return {
      output: r.output ?? [],
      exit: r.exit,
      clearScreen: r.clearScreen,
    };
  }

  protected override onDispose(): void { this.subShell.dispose(); }
}
