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
  getPrompt?(): string;
  getHostname(): string;
}

export class HuaweiVRPShellAdapter extends AbstractShell {
  readonly kind = 'huawei-vrp';

  private readonly vty: CliShellSession | null;

  constructor(opts: HuaweiVRPShellOptions) {
    super(opts);
    this.vty = opts.vty ?? null;
    // Only `logout` and `return` unconditionally end the VRP session.
    // `quit` is mode-aware: at user-view it logs out, at any deeper
    // mode it just pops one mode (system-view → user-view, …). The
    // dispatch override below routes mode-pop quits to the device so
    // its internal mode tracking stays accurate.
    this.exitWords = new Set(['logout', 'return']);
  }

  /**
   * Forwards everything to the device — including `quit`. The shell
   * only exits if `quit`/`exit` is typed while the router is already at
   * user-view (the simulator's getMode() returns 'user' or 'user-view').
   */
  override async processLine(line: string): Promise<ShellLineResult> {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    if ((lower === 'quit' || lower === 'exit') && this.isAtUserView()) {
      return { output: this.getDeactivationBanner().slice(), exit: true };
    }
    return super.processLine(line);
  }

  private isAtUserView(): boolean {
    const dev = this.device as unknown as { shell?: { getMode?: () => string } };
    const mode = dev.shell?.getMode?.();
    return mode === 'user' || mode === 'user-view' || mode === undefined;
  }

  getPrompt(): string {
    const dev = this.device as unknown as HuaweiTarget;
    if (this.vty && this.device instanceof Router && dev.getPromptForVty) {
      return dev.getPromptForVty(this.vty);
    }
    // Without a dedicated VTY, defer to the device's live prompt so that
    // mode changes (system-view → [HW], interface gi0/0/0 → [HW-Gi0/0/0])
    // are reflected immediately. Falling back to the host-name decoration
    // would freeze the prompt on the user-mode `<HW>` form.
    if (this.device instanceof Router && typeof dev.getPrompt === 'function') {
      return dev.getPrompt();
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
