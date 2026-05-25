/**
 * WindowsCmdShell — concrete shell that runs cmd.exe on a Windows box.
 *
 * Adapter over WindowsPC's command dispatch. Recognises the launchers
 * cmd.exe itself special-cases (`powershell`, `pwsh`) and hands off to
 * the appropriate child shell — so a `powershell` typed at a remote
 * Windows machine over SSH correctly lands the user in PowerShell,
 * just like at a physical console.
 */

import { AbstractShell, type AbstractShellOptions } from '../AbstractShell';
import type { ShellLineResult } from '../IShell';
import { ShellFactory } from '../ShellFactory';

interface WindowsDevice {
  executeCommand(cmd: string): Promise<string>;
  getCwd?(): string;
}

export class WindowsCmdShell extends AbstractShell {
  readonly kind = 'cmd';

  constructor(opts: AbstractShellOptions) {
    super(opts);
  }

  getPrompt(): string {
    // Prefer the per-shell context cwd; the device-wide cwd belongs to
    // the local console operator, not to an SSH-pushed remote user.
    // Default to `C:\Users\<sshUser>` so each user sees their own home.
    const cwd = this.context.cwd && this.context.cwd.length > 0
      ? this.context.cwd
      : `C:\\Users\\${this.user}`;
    return `${cwd}>`;
  }

  override getDeactivationBanner(): readonly string[] {
    return []; // cmd's `exit` is silent.
  }

  protected async dispatch(line: string): Promise<ShellLineResult> {
    const lower = line.trim().toLowerCase();
    // cmd.exe's `powershell` / `pwsh` launchers — hand off to the PS
    // child shell pointed at THIS device (local OR remote).
    if (lower === 'powershell' || lower === 'powershell.exe'
        || lower === 'pwsh' || lower === 'pwsh.exe') {
      const child = ShellFactory.tryCreateChild('powershell', {
        device: this.device,
        user: this.user,
        parent: this,
      });
      if (child) return { output: [], childShell: child };
    }

    const dev = this.device as unknown as WindowsDevice;
    const raw = await dev.executeCommand(line);
    return { output: this.splitOutput(raw) };
  }

  private splitOutput(s: string): string[] {
    if (s === '' || s == null) return [];
    return s.replace(/\n+$/, '').split('\n');
  }
}
