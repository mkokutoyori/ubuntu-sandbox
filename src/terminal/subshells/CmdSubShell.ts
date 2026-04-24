/**
 * CmdSubShell — Nested cmd.exe sub-shell.
 *
 * Used when the user types "cmd" from within PowerShell.
 * Delegates command execution to the device's executeCmdCommand().
 * Supports launching a nested PowerShell from within.
 * Supports executing .bat files (basic: REM/:: comments, @echo off, %n args).
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

    // .bat file invocation: "script.bat [args]", "call script.bat [args]",
    // or just "script [args]" when script.bat exists on disk.
    const batResult = await this.tryRunBatFile(trimmed);
    if (batResult !== null) return batResult;

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

  /**
   * If the command resolves to a .bat file on the device's filesystem,
   * execute it line-by-line and return the combined output.
   * Returns null when the command is not a .bat invocation.
   */
  private async tryRunBatFile(line: string): Promise<SubShellResult | null> {
    const parts = this.splitArgs(line);
    if (parts.length === 0) return null;

    let nameIdx = 0;
    // Support: call script.bat [args]
    if (parts[0].toLowerCase() === 'call') nameIdx = 1;

    const scriptName = parts[nameIdx];
    if (!scriptName) return null;

    const args = parts.slice(nameIdx + 1);

    // Resolve the .bat path relative to cwd
    const batPath = this.resolveBatPath(scriptName);
    if (!batPath) return null;

    const fs = (this.device as any).getFileSystem();
    const result = fs.readFile(batPath);
    if (!result.ok) return null;

    const output = await this.executeBat(result.content as string, args);
    return { output, exit: false, prompt: this.getPrompt() };
  }

  /**
   * Returns the absolute path of the .bat file if it exists, or null.
   * Tries: exact name, name + ".bat".
   */
  private resolveBatPath(name: string): string | null {
    const cwd: string = (this.device as any).getCwd();
    const fs = (this.device as any).getFileSystem();

    const candidates: string[] = [];
    const lname = name.toLowerCase();

    if (lname.endsWith('.bat')) {
      // Absolute or relative path with .bat extension
      candidates.push(name.includes('\\') || name.includes('/') ? name : `${cwd}\\${name}`);
    } else {
      // Try appending .bat
      candidates.push(
        name.includes('\\') || name.includes('/')
          ? `${name}.bat`
          : `${cwd}\\${name}.bat`,
      );
    }

    for (const c of candidates) {
      const r = fs.readFile(c);
      if (r.ok) return c;
    }
    return null;
  }

  /**
   * Execute the content of a .bat file line by line.
   * Handles: blank lines, REM/:: comments, @echo off/on, @-prefix, %n args.
   */
  private async executeBat(content: string, args: string[]): Promise<string[]> {
    const lines = content.split(/\r?\n/);
    const output: string[] = [];
    let echoOn = true;

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line) continue;

      // Strip leading @ (suppresses echo for this line)
      const noAt = line.startsWith('@') ? line.slice(1) : line;
      const lower = noAt.trimStart().toLowerCase();

      // @echo off / @echo on
      if (lower === 'echo off') { echoOn = false; continue; }
      if (lower === 'echo on')  { echoOn = true;  continue; }

      // REM and :: comments
      if (lower.startsWith('rem ') || lower === 'rem') continue;
      if (noAt.trimStart().startsWith('::')) continue;

      // Substitute %1 %2 ... positional arguments
      const expanded = noAt.replace(/%(\d+)/g, (_, n) => args[parseInt(n, 10) - 1] ?? '');

      void echoOn; // echo of command line itself is not shown in our model

      // Execute the line
      try {
        const result = await (this.device as any).executeCmdCommand(expanded.trim());
        if (result !== null && result !== undefined && result !== '') {
          output.push(...result.split('\n'));
        }
      } catch {
        // Ignore per-line errors; continue executing the rest
      }
    }

    return output;
  }

  /** Split a command line respecting double-quoted arguments. */
  private splitArgs(line: string): string[] {
    const parts: string[] = [];
    let cur = '';
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ' ' && !inQ) { if (cur) { parts.push(cur); cur = ''; } }
      else { cur += ch; }
    }
    if (cur) parts.push(cur);
    return parts;
  }

  dispose(): void {
    // No resources to clean up
  }
}
