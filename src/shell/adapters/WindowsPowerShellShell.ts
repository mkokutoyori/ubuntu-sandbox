/**
 * WindowsPowerShellShell — Concrete shell that runs PowerShell on a
 * Windows machine.
 *
 * The simulator already has a fully-featured PowerShellSubShell, but
 * it is welded to the LOCAL terminal stack. This adapter exposes the
 * same engine through the new IShell contract so SSH can push a real
 * PowerShell against a remote Windows device — no banner-and-close
 * placeholder.
 *
 * For now we reuse PowerShellSubShell as the backing engine and wrap
 * its `processLine` output; once Phase 1B migrates all sessions to the
 * new layer, the legacy sub-shell will be deleted and this class will
 * embed the PowerShellExecutor / PSInterpreter directly.
 */

import { AbstractShell, type AbstractShellOptions } from '../AbstractShell';
import type { ShellLineResult } from '../IShell';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { WindowsPC } from '@/network/devices/WindowsPC';
import type { WindowsShellSession } from '@/network/devices/windows/shell/WindowsShellSession';
import { ShellFactory } from '../ShellFactory';
import {
  tryInterpretSshLaunch,
  finalisePendingAuth,
  type PendingSshAuth,
} from '../sshLauncher';

const SSH_MAX_ATTEMPTS = 3;

export interface WindowsPowerShellOptions extends AbstractShellOptions {
  /** Per-terminal cmd.exe session for cwd / env / drive-cwd isolation. */
  readonly windowsSession?: WindowsShellSession | null;
}

export class WindowsPowerShellShell extends AbstractShell {
  readonly kind = 'powershell';

  private subShell: PowerShellSubShell;
  private banner: readonly string[];
  private readonly windowsSession: WindowsShellSession | null;
  private pendingSshAuth: PendingSshAuth | null = null;

  constructor(opts: WindowsPowerShellOptions) {
    super(opts);
    this.windowsSession = opts.windowsSession ?? null;
    const { subShell, banner } = PowerShellSubShell.create(opts.device, {
      initialCwd: opts.context.cwd,
      // The per-terminal Windows shell session is what makes `cd D:\foo`
      // in one window NOT leak into a sibling window (terminal_gap.md
      // §7.5). When the caller supplies one (local console) we pass it
      // through; SSH-pushed PS sessions get `null` and fall back to the
      // device-wide cwd.
      session: opts.windowsSession ?? null,
    });
    this.subShell = subShell;
    this.banner = banner;
  }

  getPrompt(): string {
    return this.subShell.getPrompt();
  }

  override getActivationBanner(): readonly string[] {
    return this.banner;
  }

  protected async dispatch(line: string): Promise<ShellLineResult> {
    const sshAttempt = tryInterpretSshLaunch(line, { defaultUser: this.user });
    if (sshAttempt) {
      if (sshAttempt.kind === 'error') return sshAttempt.result;
      this.pendingSshAuth = sshAttempt.pendingAuth;
      return sshAttempt.result;
    }

    const lower = line.trim().toLowerCase();
    if (lower === 'cmd' || lower === 'cmd.exe') {
      const child = ShellFactory.tryCreateChild('cmd', {
        device: this.device,
        user: this.user,
        parent: this,
        cwd: this.windowsSession?.cwd ?? this.context.cwd,
        extras: { windowsSession: this.windowsSession ?? null },
      });
      if (child) return { output: [], childShell: child };
    }
    const r = await this.subShell.processLine(line);
    return {
      output: r.output ?? [],
      exit: r.exit,
      clearScreen: r.clearScreen,
    };
  }

  override getCompletions(line: string): readonly string[] {
    return this.subShell.getCompletions?.(line) ?? [];
  }

  protected override onDispose(): void {
    this.subShell.dispose();
  }

  async handleInput(value: string): Promise<ShellLineResult> {
    const auth = this.pendingSshAuth;
    if (!auth) return { output: [] };
    const child = finalisePendingAuth(auth, value);
    if (child) {
      this.pendingSshAuth = null;
      return { output: [], childShell: child };
    }
    if (auth.attempts >= SSH_MAX_ATTEMPTS) {
      this.pendingSshAuth = null;
      return { output: [`${auth.user}@${auth.host}: Permission denied (publickey,password).`] };
    }
    return {
      output: ['Permission denied, please try again.'],
      pendingInput: { kind: 'password', promptText: `${auth.user}@${auth.host}'s password: ` },
    };
  }
}

/** Sanity guard — surfaces a clear error if someone tries to spawn PS
 *  on a non-Windows device, instead of producing nonsense later. */
export function assertPowerShellTarget(device: unknown): asserts device is WindowsPC {
  if (!(device instanceof WindowsPC)) {
    throw new Error('PowerShell can only run on a WindowsPC device');
  }
}
