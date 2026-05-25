import { AbstractShell, type AbstractShellOptions } from '../AbstractShell';
import type { ShellLineResult, ShellKeyEvent, ShellSpecialAction } from '../IShell';
import { Router } from '@/network/devices/Router';
import type { CliShellSession } from '@/network/devices/shells/vty/CliShellSession';

export interface CiscoIOSShellOptions extends AbstractShellOptions {
  readonly vty?: CliShellSession | null;
}

interface CiscoTarget {
  executeCommand(cmd: string): Promise<string>;
  executeCommandInVty?(cmd: string, vty: CliShellSession): Promise<string>;
  getPromptForVty?(vty: CliShellSession): string;
  getHostname(): string;
}

export class CiscoIOSShellAdapter extends AbstractShell {
  readonly kind = 'cisco-ios';

  private readonly vty: CliShellSession | null;

  constructor(opts: CiscoIOSShellOptions) {
    super(opts);
    this.vty = opts.vty ?? null;
    this.exitWords = new Set(['exit', 'logout', 'quit']);
  }

  getPrompt(): string {
    const dev = this.device as unknown as CiscoTarget;
    if (this.vty && this.device instanceof Router && dev.getPromptForVty) {
      return dev.getPromptForVty(this.vty);
    }
    return `${dev.getHostname() || 'Router'}#`;
  }

  protected async dispatch(line: string): Promise<ShellLineResult> {
    const dev = this.device as unknown as CiscoTarget;
    const raw = (this.vty && this.device instanceof Router && dev.executeCommandInVty)
      ? await dev.executeCommandInVty(line, this.vty)
      : await dev.executeCommand(line);
    return { output: raw ? raw.replace(/\n+$/, '').split('\n') : [] };
  }

  protected override extraKeyMappings(e: ShellKeyEvent): ShellSpecialAction {
    if (e.ctrlKey && e.key === 'z') return { kind: 'cancel' };
    return { kind: 'none' };
  }
}
