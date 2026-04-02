/**
 * CmdSubShell — Nested cmd.exe sub-shell.
 *
 * Used when the user types "cmd" from within PowerShell.
 * Delegates command execution to the device's executeCmdCommand().
 * Supports launching a nested PowerShell from within.
 */

import type { Equipment } from '@/network';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';

export class CmdSubShell implements ISubShell {
  private device: Equipment;

  private constructor(device: Equipment) {
    this.device = device;
  }

  /**
   * Factory: create a nested CMD sub-shell.
   *
   * @returns The sub-shell and banner lines.
   */
  static create(device: Equipment): { subShell: CmdSubShell; banner: string[] } {
    return {
      subShell: new CmdSubShell(device),
      banner: [
        'Microsoft Windows [Version 10.0.22631.6649]',
        '(c) Microsoft Corporation. All rights reserved.',
      ],
    };
  }

  getPrompt(): string {
    return `${(this.device as any).getCwd()}>`;
  }

  handleKey(e: KeyEvent): boolean {
    if (e.key === 'c' && e.ctrlKey) return true;
    return false;
  }

  async processLine(line: string): Promise<SubShellResult> {
    const trimmed = line.trim();

    // "exit" → leave nested cmd, return to parent shell (PowerShell)
    if (trimmed.toLowerCase() === 'exit') {
      return { output: [], exit: true, prompt: this.getPrompt() };
    }

    // "powershell" → signal to session that a nested PS is needed
    const lower = trimmed.toLowerCase();
    if (lower === 'powershell' || lower === 'powershell.exe' || lower === 'pwsh' || lower === 'pwsh.exe') {
      return {
        output: [],
        exit: false,
        prompt: this.getPrompt(),
        _enterPowerShell: true,
      } as SubShellResult & { _enterPowerShell: boolean };
    }

    // cls → clear screen
    if (lower === 'cls') {
      return { output: [], exit: false, prompt: this.getPrompt(), clearScreen: true };
    }

    // Execute via device's CMD interpreter
    try {
      const result = await (this.device as any).executeCmdCommand(trimmed);
      const output = (result !== null && result !== undefined && result !== '')
        ? result.split('\n')
        : [];

      return {
        output,
        exit: false,
        prompt: this.getPrompt(),
      };
    } catch (err) {
      return {
        output: [`Error: ${err}`],
        exit: false,
        prompt: this.getPrompt(),
      };
    }
  }

  dispose(): void {
    // No resources to clean up
  }
}
