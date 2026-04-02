/**
 * PowerShellSubShell — Interactive PowerShell sub-shell.
 *
 * Wraps the PowerShellExecutor into the ISubShell interface,
 * making PowerShell a proper sub-shell of cmd.exe (just like
 * SQL*Plus is a sub-shell of bash).
 *
 * Supports nesting: from PowerShell you can type "cmd" to get
 * a nested CmdSubShell, and from there "powershell" again, etc.
 */

import type { Equipment } from '@/network';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import { PowerShellExecutor, PS_BANNER } from '@/network/devices/windows/PowerShellExecutor';

export class PowerShellSubShell implements ISubShell {
  private psExecutor: PowerShellExecutor;
  private device: Equipment;
  private commandHistory: string[] = [];

  private constructor(device: Equipment) {
    this.device = device;
    this.psExecutor = new PowerShellExecutor(device as any);
  }

  /**
   * Factory: create a PowerShell sub-shell for a Windows device.
   *
   * @returns The sub-shell and banner lines.
   */
  static create(device: Equipment): { subShell: PowerShellSubShell; banner: string[] } {
    const subShell = new PowerShellSubShell(device);
    // Sync initial cwd from the device
    subShell.psExecutor.setCwd((device as any).getCwd());
    return {
      subShell,
      banner: PS_BANNER.split('\n'),
    };
  }

  getPrompt(): string {
    return this.psExecutor.getPrompt();
  }

  handleKey(e: KeyEvent): boolean {
    // Ctrl+D → ignored in PowerShell (not a Unix shell)
    if (e.key === 'd' && e.ctrlKey) return true;
    // Ctrl+C → cancel current input (handled at session level)
    if (e.key === 'c' && e.ctrlKey) return true;
    // All other keys go to the view's text input
    return false;
  }

  async processLine(line: string): Promise<SubShellResult> {
    const trimmed = line.trim();

    // "exit" → leave PowerShell, return to parent cmd
    if (trimmed.toLowerCase() === 'exit') {
      return { output: [], exit: true, prompt: this.getPrompt() };
    }

    // Track history for Get-History
    if (trimmed) {
      this.commandHistory.push(trimmed);
    }
    this.psExecutor.setHistory(this.commandHistory);

    // "cmd" / "cmd.exe" → signal to the session that a nested cmd is needed
    // The session will handle creating a CmdSubShell
    if (trimmed.toLowerCase() === 'cmd' || trimmed.toLowerCase() === 'cmd.exe') {
      return {
        output: [
          'Microsoft Windows [Version 10.0.22631.6649]',
          '(c) Microsoft Corporation. All rights reserved.',
        ],
        exit: false,
        prompt: this.getPrompt(),
        // The session detects this via a special marker
        _enterCmd: true,
      } as SubShellResult & { _enterCmd: boolean };
    }

    // cls / clear-host / clear → clear screen
    const lower = trimmed.toLowerCase();
    if (lower === 'cls' || lower === 'clear-host' || lower === 'clear') {
      return { output: [], exit: false, prompt: this.getPrompt(), clearScreen: true };
    }

    // Sync cwd to PS executor
    this.psExecutor.setCwd((this.device as any).getCwd());

    // Execute the PowerShell command
    const result = await this.psExecutor.execute(trimmed);

    // Sync cwd back from PS executor (Set-Location, cd, etc.)
    const newCwd = this.psExecutor.getCwd();
    const deviceCwd = (this.device as any).getCwd();
    if (newCwd !== deviceCwd) {
      // Update the device's cwd if PS changed it
      // (via executeCmdCommand('cd ...') which already updates the device)
    }

    const output = (result !== null && result !== undefined && result !== '')
      ? result.split('\n')
      : [];

    return {
      output,
      exit: false,
      prompt: this.psExecutor.getPrompt(),
    };
  }

  dispose(): void {
    // No resources to clean up
  }
}
