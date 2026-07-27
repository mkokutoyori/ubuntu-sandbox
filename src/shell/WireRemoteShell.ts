/**
 * WireRemoteShell — the shell an SSH client pushes onto its terminal
 * stack once the login succeeded, driving the remote over the channel
 * that login opened.
 *
 * Its predecessor, {@link file://./CrossVendorRemoteShell.ts}, built a
 * *local* shell for the remote device and drove that object in memory:
 * the login was settled here, nothing crossed the wire, the server had
 * no session to show, and a pulled cable went unnoticed. Everything the
 * remote does — its prompt, its completion, its sub-shell stacking, its
 * editors, its own challenges — is already answered by the server over
 * the channel (docs/PRD-SSH-Unification.md §4bis A1/B1/B2/B3), so this
 * class only has to be the `IShell` face of that channel.
 *
 * Design pattern: **Adapter** — {@link SshInteractiveSubShell} already
 * speaks the channel; the `ISubShell` and `IShell` results differ in
 * shape, not in meaning.
 */

import type { Equipment } from '@/network';
import type {
  IShell, ShellConnection, ShellLineResult, ShellKeyEvent, ShellSpecialAction,
} from './IShell';
import { ShellContext } from './ShellContext';
import type { SshInteractiveSubShell } from '@/terminal/subshells/SshInteractiveSubShell';

export interface WireRemoteShellOptions {
  readonly device: Equipment;
  readonly user: string;
  readonly remoteHost: string;
  /** Kind of the remote's login shell — `bash`, `cmd`, `cisco-ios`, … */
  readonly primaryKind: string;
  /** The channel driver this shell is the `IShell` face of. */
  readonly wire: SshInteractiveSubShell;
  /** OpenSSH-style `SSH_CONNECTION`, exposed in the remote's env. */
  readonly sshConnection?: string;
  /** OpenSSH-style `SSH_CLIENT`. */
  readonly sshClient?: string;
  /** Teardown hook — closes the transport, closes the session record. */
  readonly onClose?: () => void;
}

export class WireRemoteShell implements IShell {
  readonly kind = 'ssh-remote';
  readonly connection: ShellConnection = 'ssh';
  readonly device: Equipment;
  readonly user: string;
  readonly context: ShellContext;
  readonly remoteHost: string;
  readonly primaryKind: string;

  private readonly wire: SshInteractiveSubShell;
  private readonly onClose: () => void;
  private closeFired = false;
  private finished = false;

  constructor(opts: WireRemoteShellOptions) {
    this.device = opts.device;
    this.user = opts.user;
    this.remoteHost = opts.remoteHost;
    this.primaryKind = opts.primaryKind;
    this.wire = opts.wire;
    this.onClose = opts.onClose ?? (() => undefined);
    this.context = new ShellContext(
      opts.remoteHost,
      {
        user: opts.user, uid: 1000, gid: 1000, groups: [1000],
        euid: 1000, egid: 1000, loginUser: opts.user,
      },
      `/home/${opts.user}`,
      {
        ...(opts.sshConnection ? { SSH_CONNECTION: opts.sshConnection } : {}),
        ...(opts.sshClient ? { SSH_CLIENT: opts.sshClient } : {}),
        USER: opts.user,
        HOME: `/home/${opts.user}`,
      },
    );
  }

  /** What the user is driving right now — the remote decides, not us. */
  get topKind(): string { return this.primaryKind; }

  /** True once the remote's login shell exited and the session is over. */
  get isFinished(): boolean { return this.finished; }

  getPrompt(): string {
    return this.finished ? '' : this.wire.getPrompt();
  }

  getActivationBanner(): readonly string[] {
    // The login banner is printed by whoever ran the login, from the
    // remote's own MOTD; the shell adds nothing on top.
    return [];
  }

  getDeactivationBanner(): readonly string[] {
    return ['logout', `Connection to ${this.remoteHost} closed.`];
  }

  async processLine(line: string): Promise<ShellLineResult> {
    // The session ends exactly once. Reporting `exit` again on a later
    // call would unwind a second frame — the one that launched `ssh`.
    if (this.finished) return { output: [] };
    return this.adapt(await this.wire.processLine(line));
  }

  async handleInput(value: string): Promise<ShellLineResult> {
    if (this.finished) return { output: [] };
    return this.adapt(await this.wire.handleInput(value));
  }

  /**
   * `ISubShell` reports the next prompt inline and `IShell` asks for it,
   * so that field is dropped; everything else carries over. A result
   * that ends the session fires the teardown once.
   */
  private adapt(result: Awaited<ReturnType<SshInteractiveSubShell['processLine']>>): ShellLineResult {
    if (result.exit) {
      this.finished = true;
      this.fireClose();
    }
    return {
      output: result.output,
      styledOutput: result.styledOutput,
      exit: result.exit,
      clearScreen: result.clearScreen,
      pendingInput: result.pendingInput,
      childShell: result.childShell,
    };
  }

  private fireClose(): void {
    if (this.closeFired) return;
    this.closeFired = true;
    this.onClose();
  }

  classifyKey(e: ShellKeyEvent): ShellSpecialAction {
    if (e.ctrlKey && e.key === 'c') return { kind: 'cancel' };
    if (e.ctrlKey && e.key === 'l') return { kind: 'clear-screen' };
    if (e.ctrlKey && e.key === 'd') return { kind: 'eof' };
    if (e.key === 'ArrowUp') return { kind: 'history-prev' };
    if (e.key === 'ArrowDown') return { kind: 'history-next' };
    return { kind: 'none' };
  }

  /**
   * Candidates come from the remote, which answers asynchronously; the
   * synchronous `IShell` shape cannot carry them. Hosts that complete
   * over the wire call {@link getCompletionsAsync}.
   */
  getCompletions(_line: string): readonly string[] {
    return [];
  }

  getCompletionsAsync(line: string): Promise<string[]> {
    return this.wire.getCompletionsAsync(line);
  }

  /**
   * An editor typed here runs where the file is — on the remote — and
   * only keystrokes and a screen cross the wire. The host reaches it
   * through these, so they have to survive the `IShell` adaptation
   * (docs/PRD-SSH-Unification.md §4bis B3).
   */
  openRemoteEditor(line: string): ReturnType<SshInteractiveSubShell['openRemoteEditor']> {
    return this.wire.openRemoteEditor(line);
  }

  editorTransport(): ReturnType<SshInteractiveSubShell['editorTransport']> {
    return this.wire.editorTransport();
  }

  /** `?` is a help key on a vendor CLI, a plain character elsewhere. */
  supportsInlineHelp(): boolean {
    return this.wire.supportsInlineHelp();
  }

  inlineHelpAsync(line: string): Promise<string[]> {
    return this.wire.inlineHelpAsync(line);
  }

  /** A foreground job runs on the remote, so Ctrl+C is delivered there. */
  interruptForeground(): boolean {
    return this.wire.interruptForeground();
  }

  activate(): void { /* the channel is already open */ }
  pause(): void { /* the remote keeps its own state */ }
  resume(): void { /* nothing local to restore */ }
  deactivate(): void { this.fireClose(); }

  dispose(): void {
    this.finished = true;
    this.fireClose();
    this.wire.dispose();
  }
}
