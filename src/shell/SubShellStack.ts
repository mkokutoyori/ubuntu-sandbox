/**
 * SubShellStack — the sub-shell composite an SSH *server* keeps for one
 * shell channel.
 *
 * The client side of the wire only exchanges lines and a prompt, so a
 * `sqlplus` typed over SSH has to push its REPL on the server, exactly
 * as the console terminal does locally. This holds that stack next to
 * the channel's login shell: the login shell keeps answering while the
 * stack is empty, and every line goes to the top of the stack once a
 * child has been pushed (docs/PRD-SSH-Unification.md §4bis B2).
 *
 * Design pattern: **Composite** — same shape as
 * {@link CrossVendorRemoteShell}, minus the primary shell, which on the
 * server side is the channel's own session-backed executor.
 */

import type { Equipment } from '@/network';
import type { IShell } from './IShell';
import { ShellFactory } from './ShellFactory';

export interface SubShellStackOptions {
  readonly device: Equipment;
  readonly user: string;
  /**
   * Kind of the channel's login shell — the parent a bare launcher line
   * is judged against. `bash` for a POSIX host, `cmd` for Windows, a
   * vendor CLI kind for a router.
   */
  readonly primaryKind?: string;
}

export class SubShellStack {
  private readonly stack: IShell[] = [];

  constructor(private readonly opts: SubShellStackOptions) {}

  /** Kind of whatever currently owns the channel's input. */
  private get currentKind(): string {
    return this.active ? this.top.kind : this.opts.primaryKind ?? 'bash';
  }

  /** True while a child shell owns the channel's input. */
  get active(): boolean {
    return this.stack.length > 0;
  }

  private get top(): IShell {
    return this.stack[this.stack.length - 1];
  }

  /** The top shell's prompt, or null while the login shell is in charge. */
  getPrompt(): string | null {
    return this.active ? this.top.getPrompt() : null;
  }

  getCompletions(line: string): readonly string[] | null {
    return this.active ? this.top.getCompletions(line) : null;
  }

  /**
   * Push the child `line` launches. Returns its activation banner, or
   * null when the line launches nothing, when no adapter is registered
   * for it, or when the adapter refuses the device (no Oracle here) —
   * all three cases fall back to the channel's login shell, which still
   * prints whatever the device would have printed.
   */
  launch(line: string): string[] | null {
    const kind = ShellFactory.launcherKindFor(line, this.currentKind);
    if (!kind) return null;
    const child = ShellFactory.tryCreateChild(kind, {
      device: this.opts.device,
      user: this.opts.user,
      parent: this.active ? this.top : null,
      connection: 'ssh',
      launchLine: line,
    });
    if (!child) return null;
    if ((child as unknown as { isReady?: boolean }).isReady === false) {
      child.dispose();
      return null;
    }
    if (this.active) this.top.pause();
    child.activate();
    this.stack.push(child);
    return [...child.getActivationBanner()];
  }

  /** Route one line to the top of the stack. Only valid while `active`. */
  async process(line: string): Promise<{ output: string[]; exitCode: number }> {
    const result = await this.top.processLine(line);
    const output = [...result.output];

    if (result.childShell) {
      this.top.pause();
      result.childShell.activate();
      this.stack.push(result.childShell);
      return {
        output: [...output, ...result.childShell.getActivationBanner()],
        exitCode: 0,
      };
    }

    if (result.exit) {
      const popped = this.stack.pop();
      popped?.deactivate();
      popped?.dispose();
      if (this.active) this.top.resume();
      return { output, exitCode: 0 };
    }

    return { output, exitCode: 0 };
  }

  dispose(): void {
    while (this.stack.length) {
      const shell = this.stack.pop()!;
      shell.deactivate();
      shell.dispose();
    }
  }
}
