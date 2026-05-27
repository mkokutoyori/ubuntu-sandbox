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
import {
  tryInterpretSshLaunch,
  finalisePendingAuth,
  runSshExec,
  type PendingSshAuth,
} from '../sshLauncher';

function parseSshExecCommandCmd(line: string): string | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0]?.toLowerCase() !== 'ssh') return null;
  let i = 1;
  const valueFlags = new Set(['-p', '-i', '-l', '-o', '-b', '-c', '-D', '-E', '-F', '-I', '-J', '-L', '-R', '-S', '-W']);
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '-V') return null;
    if (valueFlags.has(t)) { i += 2; continue; }
    if (t.startsWith('-')) { i++; continue; }
    break;
  }
  if (i + 1 >= tokens.length) return null;
  return tokens.slice(i + 1).join(' ');
}

const SSH_MAX_ATTEMPTS = 3;
import type { WindowsShellSession } from '@/network/devices/windows/shell/WindowsShellSession';
import { WindowsPC } from '@/network/devices/WindowsPC';

export interface WindowsCmdShellOptions extends AbstractShellOptions {
  /** Per-terminal cmd.exe session for cwd / env / drive-cwd isolation. */
  readonly windowsSession?: WindowsShellSession | null;
}

interface WindowsDevice {
  executeCommand(cmd: string): Promise<string>;
  executeCommandInSession?(cmd: string, s: WindowsShellSession): Promise<string>;
}

/** Canonical cmd.exe activation banner — matches the real CLI banner. */
const CMD_BANNER: readonly string[] = [
  'Microsoft Windows [Version 10.0.22631.6649]',
  '(c) Microsoft Corporation. All rights reserved.',
];

export class WindowsCmdShell extends AbstractShell {
  readonly kind = 'cmd';

  private readonly windowsSession: WindowsShellSession | null;
  private pendingSshAuth: PendingSshAuth | null = null;
  private pendingExecCommand: string | null = null;
  private readonly knownHostsTracker = new Set<string>();

  /** Real cmd.exe only knows `cls`; typing `clear` produces a "not
   *  recognized as an internal or external command" error. */
  protected override clearWords: ReadonlySet<string> = new Set(['cls']);

  /**
   * cmd.exe does NOT recognise Ctrl+D as logout — only `exit` works.
   * Override so a Linux user habituated to Ctrl+D does not accidentally
   * drop out of a remote cmd session.
   */
  override classifyKey(e: import('../IShell').ShellKeyEvent): import('../IShell').ShellSpecialAction {
    if (e.ctrlKey && e.key === 'd') return { kind: 'none' };
    return super.classifyKey(e);
  }

  /** When true, the shell allocated its own WindowsShellSession and
   *  must close it on dispose; when false, the session was supplied by
   *  the caller (local cmd terminal) which owns its lifecycle. */
  private readonly ownsSession: boolean;

  constructor(opts: WindowsCmdShellOptions) {
    super(opts);
    if (opts.windowsSession) {
      this.windowsSession = opts.windowsSession;
      this.ownsSession = false;
    } else if (opts.device instanceof WindowsPC) {
      // No session passed (typical of an SSH-pushed cmd) — allocate one
      // pointing at the SSH user's home so `cd` / `dir` / `mkdir`
      // operate on the user's actual directory tree, not the device
      // global cwd that would silently leak \C:\\Users\\User\\… into
      // every SSH session.
      this.windowsSession = opts.device.openShellSession({
        user: opts.user,
        cwd: opts.context.cwd && opts.context.cwd.length > 0
          ? opts.context.cwd
          : `C:\\Users\\${opts.user}`,
      });
      this.ownsSession = true;
    } else {
      this.windowsSession = null;
      this.ownsSession = false;
    }
  }

  protected override onDispose(): void {
    if (this.windowsSession && this.ownsSession
        && this.device instanceof WindowsPC) {
      this.device.closeShellSession(this.windowsSession);
    }
  }

  getPrompt(): string {
    // Prefer the per-terminal Windows session's cwd when one is bound —
    // that's what makes `cd D:\foo` in this terminal NOT leak into a
    // sibling terminal. Falls back to the IShell context cwd (set at
    // factory time from the SSH user's home), and finally to the
    // `C:\Users\<user>` default.
    const cwd = this.windowsSession?.cwd
      ?? (this.context.cwd && this.context.cwd.length > 0 ? this.context.cwd : null)
      ?? `C:\\Users\\${this.user}`;
    return `${cwd}>`;
  }

  override getActivationBanner(): readonly string[] {
    return CMD_BANNER;
  }

  override getDeactivationBanner(): readonly string[] {
    return []; // cmd's `exit` is silent.
  }

  protected async dispatch(line: string): Promise<ShellLineResult> {
    // ssh launch intercept — lets the user chain SSH from a remote cmd.
    const sshAttempt = await tryInterpretSshLaunch(line, {
      defaultUser: this.user,
      knownHostsTracker: this.knownHostsTracker,
      sourceIp: firstConfiguredIpCmd(this.device),
      sourceHostname: (this.device as unknown as { getHostname?: () => string }).getHostname?.(),
    });
    if (sshAttempt) {
      if (sshAttempt.kind === 'noop' || sshAttempt.kind === 'error'
          || sshAttempt.kind === 'exec') {
        return sshAttempt.result;
      }
      this.pendingSshAuth = sshAttempt.pendingAuth;
      this.pendingExecCommand = parseSshExecCommandCmd(line);
      return sshAttempt.result;
    }

    const lower = line.trim().toLowerCase();
    // cmd.exe's `powershell` / `pwsh` launchers — hand off to the PS
    // child shell pointed at THIS device (local OR remote). The current
    // `windowsSession` travels with the child so cwd stays in sync.
    if (lower === 'powershell' || lower === 'powershell.exe'
        || lower === 'pwsh' || lower === 'pwsh.exe') {
      const child = ShellFactory.tryCreateChild('powershell', {
        device: this.device,
        user: this.user,
        parent: this,
        cwd: this.windowsSession?.cwd,
        extras: { windowsSession: this.windowsSession },
      });
      if (child) return { output: [], childShell: child };
    }

    const dev = this.device as unknown as WindowsDevice;
    // Use the per-session dispatch when a session is bound so `cd` /
    // `set` mutate THIS terminal's state, not the device-wide globals.
    const raw = (this.windowsSession && this.device instanceof WindowsPC
      && dev.executeCommandInSession)
      ? await dev.executeCommandInSession(line, this.windowsSession)
      : await dev.executeCommand(line);
    return { output: this.splitOutput(raw) };
  }

  private splitOutput(s: string): string[] {
    if (s === '' || s == null) return [];
    return s.replace(/\n+$/, '').split('\n');
  }

  async handleInput(value: string): Promise<ShellLineResult> {
    const auth = this.pendingSshAuth;
    if (!auth) return { output: [] };
    const finalised = finalisePendingAuth(auth, value);
    if (finalised) {
      const execCmd = this.pendingExecCommand;
      this.pendingSshAuth = null;
      this.pendingExecCommand = null;
      if (execCmd !== null) {
        const lines = await runSshExec(auth, execCmd);
        finalised.shell.dispose();
        return { output: [...finalised.banner, ...lines] };
      }
      return { output: [...finalised.banner], childShell: finalised.shell };
    }
    if (auth.attempts >= SSH_MAX_ATTEMPTS) {
      this.pendingSshAuth = null;
      this.pendingExecCommand = null;
      return { output: [`${auth.user}@${auth.host}: Permission denied (publickey,password).`] };
    }
    return {
      output: ['Permission denied, please try again.'],
      pendingInput: { kind: 'password', promptText: `${auth.user}@${auth.host}'s password: ` },
    };
  }
}

function firstConfiguredIpCmd(dev: unknown): string | undefined {
  const ports = (dev as { ports?: Map<string, { getIPAddress: () => { toString(): string } | null }> }).ports;
  if (!ports) return undefined;
  for (const port of ports.values()) {
    const ip = port.getIPAddress?.();
    if (ip) return ip.toString();
  }
  return undefined;
}
