/**
 * ShellSubShellAdapter — bridges the new `IShell` contract to the
 * legacy `ISubShell` contract that TerminalSession's stack still
 * understands.
 *
 * This is the integration seam that lets the new Shell layer ship
 * without touching every TerminalSession at once: SSH push (and any
 * future caller) builds an `IShell`, wraps it in this adapter, and
 * pushes it onto `activeSubShell` exactly as before.
 *
 * Phase 1B will remove this adapter once every TerminalSession
 * consumes IShell directly.
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from '@/terminal/subshells/ISubShell';
import type { IShell } from './IShell';

export class ShellSubShellAdapter implements ISubShell {
  constructor(private readonly shell: IShell) {}

  /** Underlying IShell — exposed for tests and migration callers. */
  get inner(): IShell { return this.shell; }

  getPrompt(): string { return this.shell.getPrompt(); }

  /** A Ctrl+D pops the shell; matches the legacy contract for sub-shells. */
  handleKey(e: KeyEvent): boolean {
    const action = this.shell.classifyKey({
      key: e.key,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
    });
    return action.kind === 'eof';
  }

  async processLine(line: string): Promise<SubShellResult> {
    const r = await this.shell.processLine(line);
    return {
      output: [...r.output],
      exit: !!r.exit,
      prompt: this.shell.getPrompt(),
      clearScreen: r.clearScreen,
    };
  }

  getCompletions(line: string): string[] {
    return [...this.shell.getCompletions(line)];
  }

  dispose(): void { this.shell.dispose(); }
}
