/**
 * CrossVendorRemoteShell — the shell driver an SSH client pushes onto
 * its local terminal stack after a successful login.
 *
 * It composes a *primary* shell (the remote's login shell — bash on
 * Linux, cmd on Windows, IOS/VRP on routers) and a sub-shell stack on
 * top so children like PowerShell, SQL*Plus, RMAN can be pushed by
 * the primary's dispatch and unwound cleanly with `exit` / `quit`.
 *
 * Why a dedicated class? Without it, RemoteDeviceSubShell would have
 * to mirror the sub-shell stack the local terminal already maintains —
 * which is exactly the source of the reported "PowerShell over SSH
 * doesn't work / cls doesn't clear" bugs. Concentrating the
 * push/pop logic in one place makes the SSH push behave EXACTLY like
 * being seated at the remote's console.
 *
 * Design pattern: **Composite** — child shells stack on the primary;
 * the public `processLine` always routes to the top of the stack.
 */

import type { Equipment } from '@/network';
import type { IShell, ShellConnection, ShellLineResult, ShellKeyEvent, ShellSpecialAction } from './IShell';
import { ShellFactory } from './ShellFactory';
import type { ShellContext } from './ShellContext';

export interface CrossVendorRemoteShellOptions {
  readonly device: Equipment;
  readonly user: string;
  readonly remoteHost: string;
  /** Kind of the remote's primary shell — `bash`, `cmd`, `cisco-ios`, … */
  readonly primaryKind: string;
  /**
   * OpenSSH-style SSH_CONNECTION string: "client_ip client_port server_ip
   * server_port". Propagated to the remote shell's env so `echo
   * $SSH_CONNECTION` mirrors what real ssh exposes.
   */
  readonly sshConnection?: string;
  /** OpenSSH-style SSH_CLIENT: "client_ip client_port server_port". */
  readonly sshClient?: string;
  /** Optional teardown hook (close SSH transport, log entry, …). */
  readonly onClose?: () => void;
  /**
   * Liveness of the underlying transport, consulted before each command.
   * Wired to the very same wire probe that opened the session, so a link
   * pulled mid-session surfaces as a broken pipe instead of the shell
   * quietly going on driving the remote object (docs/PRD-Link-State.md
   * §3.3). Omitted means "never check", preserving prior behaviour.
   */
  readonly probeAlive?: () => boolean;
}

export class CrossVendorRemoteShell implements IShell {
  readonly kind = 'ssh-remote';
  /** SSH push is, by construction, an `ssh`-driven shell. */
  readonly connection: ShellConnection = 'ssh';
  readonly device: Equipment;
  readonly user: string;
  readonly context: ShellContext;
  readonly remoteHost: string;
  /** The kind of the primary shell — useful for callers that need to
   *  decide "is the inner host POSIX or Windows or a router?". */
  readonly primaryKind: string;
  private readonly onClose: () => void;
  private readonly probeAlive?: () => boolean;
  private closeFired = false;

  /** Bottom = primary login shell; top = active child. */
  private readonly stack: IShell[] = [];

  private fireClose(): void {
    if (this.closeFired) return;
    this.closeFired = true;
    this.onClose();
  }

  constructor(opts: CrossVendorRemoteShellOptions) {
    this.device = opts.device;
    this.user = opts.user;
    this.remoteHost = opts.remoteHost;
    this.primaryKind = opts.primaryKind;
    this.onClose = opts.onClose ?? (() => undefined);
    this.probeAlive = opts.probeAlive;

    const primary = ShellFactory.create(opts.primaryKind, {
      device: opts.device,
      user: opts.user,
      connection: 'ssh',
      extras: {
        sshConnection: opts.sshConnection,
        sshClient: opts.sshClient,
      },
    });
    this.context = primary.context;
    primary.activate();
    this.stack.push(primary);
  }

  /** The current top-of-stack shell's kind — what the user is actually
   *  driving right now. After `powershell` from cmd, this is `powershell`. */
  get topKind(): string { return this.stack[this.stack.length - 1]?.kind ?? this.primaryKind; }

  /** The shell at the top of the stack — `processLine` always routes here. */
  private get top(): IShell { return this.stack[this.stack.length - 1]; }

  /** True once the primary has exited and the SSH session is over. */
  get isFinished(): boolean { return this.stack.length === 0; }

  /**
   * How many shells are stacked, login shell included. Nesting is a
   * question of depth, not of kind: `cmd` launched from `powershell`
   * launched from `cmd` is two levels deep even though the top and the
   * bottom are the same interpreter.
   */
  get depth(): number { return this.stack.length; }

  getPrompt(): string {
    // After the primary pops, the wrapper has no more shells to drive;
    // surface an empty prompt so the host terminal can render its own.
    return this.stack.length === 0 ? '' : this.top.getPrompt();
  }

  getActivationBanner(): readonly string[] {
    // The SSH push prints its own MOTD; the wrapper does not add to it.
    return this.stack[0].getActivationBanner();
  }

  getDeactivationBanner(): readonly string[] {
    return [`logout`, `Connection to ${this.remoteHost} closed.`];
  }

  /**
   * OpenSSH's behaviour when the transport dies under an open session:
   * the client reports a broken pipe and the session ends, dropping the
   * user back on the local shell.
   */
  private brokenPipe(): ShellLineResult | null {
    if (this.stack.length === 0) return null;
    if (!this.probeAlive || this.probeAlive()) return null;
    while (this.stack.length) {
      const s = this.stack.pop()!;
      s.deactivate();
      s.dispose();
    }
    this.fireClose();
    return { output: ['client_loop: send disconnect: Broken pipe'], exit: true };
  }

  async processLine(line: string): Promise<ShellLineResult> {
    const dead = this.brokenPipe();
    if (dead) return dead;
    const result = await this.top.processLine(line);
    return this.applyChildOrPassThrough(result);
  }

  /**
   * Forward an out-of-band input value (password collected by the host
   * terminal in response to a `pendingInput` directive) to whichever
   * shell is at the top of the stack.
   */
  async handleInput(value: string): Promise<ShellLineResult> {
    const dead = this.brokenPipe();
    if (dead) return dead;
    if (typeof this.top.handleInput !== 'function') return { output: [] };
    const result = await this.top.handleInput(value);
    return this.applyChildOrPassThrough(result);
  }

  /**
   * Common post-processing of a result returned by the top shell. Pushes
   * a child when one is supplied and rewinds the stack when the top
   * exits, so handleInput and processLine share the same stack mechanics.
   */
  private applyChildOrPassThrough(result: ShellLineResult): ShellLineResult {
    if (result.childShell) {
      this.top.pause();
      result.childShell.activate();
      this.stack.push(result.childShell);
      return {
        output: [
          ...result.output,
          ...result.childShell.getActivationBanner(),
        ],
        styledOutput: result.styledOutput,
        clearScreen: result.clearScreen,
        pendingInput: result.pendingInput,
      };
    }

    if (result.exit) {
      const popped = this.stack.pop();
      popped?.deactivate();
      popped?.dispose();
      if (this.stack.length === 0) {
        // The primary shell has exited — the whole SSH session ends.
        // Append the OpenSSH "Connection to <host> closed." footer the
        // user expects regardless of which vendor's shell was on top.
        this.fireClose();
        return {
          output: [...result.output, `Connection to ${this.remoteHost} closed.`],
          styledOutput: result.styledOutput,
          exit: true,
        };
      }
      this.top.resume();
      return {
        output: result.output,
        styledOutput: result.styledOutput,
        clearScreen: result.clearScreen,
      };
    }

    return result;
  }

  classifyKey(e: ShellKeyEvent): ShellSpecialAction {
    return this.top.classifyKey(e);
  }

  getCompletions(line: string): readonly string[] {
    return this.top.getCompletions(line);
  }

  activate(): void {
    // The primary was already activated in the constructor — re-entry
    // (after a popRemoteDevice / pushRemoteDevice cycle) is a no-op.
  }

  pause(): void { this.top.pause(); }
  resume(): void { this.top.resume(); }

  deactivate(): void {
    while (this.stack.length) {
      const s = this.stack.pop()!;
      s.deactivate();
      s.dispose();
    }
    this.fireClose();
  }

  dispose(): void { this.deactivate(); }
}
