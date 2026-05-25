import { AbstractShell, type AbstractShellOptions } from '../AbstractShell';
import type { ShellLineResult } from '../IShell';
import { Router } from '@/network/devices/Router';
import type { CliShellSession } from '@/network/devices/shells/vty/CliShellSession';

export interface HuaweiVRPShellOptions extends AbstractShellOptions {
  readonly vty?: CliShellSession | null;
}

interface HuaweiTarget {
  executeCommand(cmd: string): Promise<string>;
  executeCommandInVty?(cmd: string, vty: CliShellSession): Promise<string>;
  getPromptForVty?(vty: CliShellSession): string;
  getHostname(): string;
}

export class HuaweiVRPShellAdapter extends AbstractShell {
  readonly kind = 'huawei-vrp';

  private readonly vty: CliShellSession | null;

  constructor(opts: HuaweiVRPShellOptions) {
    super(opts);
    this.vty = opts.vty ?? null;
    this.exitWords = new Set(['quit', 'logout', 'exit']);
  }

  getPrompt(): string {
    const dev = this.device as unknown as HuaweiTarget;
    if (this.vty && this.device instanceof Router && dev.getPromptForVty) {
      return dev.getPromptForVty(this.vty);
    }
    return `<${dev.getHostname() || 'Huawei'}>`;
  }

  protected async dispatch(line: string): Promise<ShellLineResult> {
    const dev = this.device as unknown as HuaweiTarget;
    const raw = (this.vty && this.device instanceof Router && dev.executeCommandInVty)
      ? await dev.executeCommandInVty(line, this.vty)
      : await dev.executeCommand(line);
    return { output: raw ? raw.replace(/\n+$/, '').split('\n') : [] };
  }
}
