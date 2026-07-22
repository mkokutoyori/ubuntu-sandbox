import { AbstractShell, type AbstractShellOptions } from '../AbstractShell';
import type { ShellLineResult, ShellKeyEvent, ShellSpecialAction } from '../IShell';
import { Router } from '@/network/devices/Router';
import type { CliShellSession } from '@/network/devices/shells/vty/CliShellSession';
import { isInteractionPlanner } from '../interaction/CommandInteraction';
import { InteractionPlanRunner, type PlanAdvanceResult } from '../interaction/InteractionPlanRunner';

export interface CiscoIOSShellOptions extends AbstractShellOptions {
  readonly vty?: CliShellSession | null;
}

interface CiscoTarget {
  executeCommand(cmd: string): Promise<string>;
  executeCommandInVty?(cmd: string, vty: CliShellSession): Promise<string>;
  getPromptForVty?(vty: CliShellSession): string;
  getPrompt?(): string;
  getHostname(): string;
}

export class CiscoIOSShellAdapter extends AbstractShell {
  readonly kind = 'cisco-ios';

  private readonly vty: CliShellSession | null;

  constructor(opts: CiscoIOSShellOptions) {
    super(opts);
    this.vty = opts.vty ?? null;
    // Only `logout` unconditionally ends an IOS session. `exit` / `quit`
    // are mode-aware (at conf-t they pop one config level; at enable
    // they log out). `processLine` routes mode-pop exits to the device.
    this.exitWords = new Set(['logout']);
  }

  override async processLine(line: string): Promise<ShellLineResult> {
    const lower = line.trim().toLowerCase();
    if ((lower === 'exit' || lower === 'quit') && this.isAtTopMode()) {
      return { output: this.getDeactivationBanner().slice(), exit: true };
    }
    return super.processLine(line);
  }

  private isAtTopMode(): boolean {
    const dev = this.device as unknown as { shell?: { getMode?: () => string } };
    const mode = dev.shell?.getMode?.();
    // 'user' (enable not entered) and 'privileged' (enable) are both
    // "top-of-stack" from IOS's perspective: `exit` at either logs out.
    return mode === 'user' || mode === 'privileged' || mode === undefined;
  }

  getPrompt(): string {
    const dev = this.device as unknown as CiscoTarget;
    if (this.vty && this.device instanceof Router && dev.getPromptForVty) {
      return dev.getPromptForVty(this.vty);
    }
    // Without a dedicated VTY, defer to the device's live prompt so that
    // mode transitions (enable → R1#, conf t → R1(config)#) are tracked
    // immediately instead of freezing on the hostname# decoration.
    if (this.device instanceof Router && typeof dev.getPrompt === 'function') {
      return dev.getPrompt();
    }
    return `${dev.getHostname() || 'Router'}#`;
  }

  /** Active command-owned interactive dialogue (IoC), if any. */
  private planRunner: InteractionPlanRunner | null = null;

  protected async dispatch(line: string): Promise<ShellLineResult> {
    // Command-owned interactive flows (IoC): the SAME plans the UI
    // terminal renders drive the SSH path, through pendingInput/handleInput.
    const started = await this.tryStartInteractionPlan(line);
    if (started) return started;

    const raw = await this.execOnDevice(line);
    return { output: raw ? raw.replace(/\n+$/, '').split('\n') : [] };
  }

  private async execOnDevice(line: string): Promise<string> {
    const dev = this.device as unknown as CiscoTarget;
    return (this.vty && this.device instanceof Router && dev.executeCommandInVty)
      ? await dev.executeCommandInVty(line, this.vty)
      : await dev.executeCommand(line);
  }

  private currentMode(): string {
    if (this.vty) return this.vty.state.mode;
    const dev = this.device as unknown as { shell?: { getMode?: () => string } };
    return dev.shell?.getMode?.() ?? 'user';
  }

  private async tryStartInteractionPlan(line: string): Promise<ShellLineResult | null> {
    const shell = (this.device as unknown as { getShell?: () => unknown }).getShell?.();
    if (!isInteractionPlanner(shell)) return null;
    const plan = shell.interactionPlanFor(line, { mode: this.currentMode(), device: this.device });
    if (!plan) return null;
    const runner = new InteractionPlanRunner(plan, (cmd) => this.execOnDevice(cmd));
    const first = await runner.start();
    if (!first.done) this.planRunner = runner;
    return this.planResult(first);
  }

  private planResult(r: PlanAdvanceResult): ShellLineResult {
    if (r.done) {
      this.planRunner = null;
      return { output: r.lines };
    }
    return { output: r.lines, pendingInput: r.pending };
  }

  /** Continuation of an active interaction plan (host-collected value). */
  async handleInput(value: string): Promise<ShellLineResult> {
    if (!this.planRunner) return { output: [] };
    return this.planResult(await this.planRunner.provide(value));
  }

  protected override extraKeyMappings(e: ShellKeyEvent): ShellSpecialAction {
    if (e.ctrlKey && e.key === 'z') return { kind: 'cancel' };
    return { kind: 'none' };
  }
}
