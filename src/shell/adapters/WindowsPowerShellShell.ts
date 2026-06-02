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
  runSshExec,
  type PendingSshAuth,
} from '../sshLauncher';

function parseSshExecCommandPs(line: string): string | null {
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

export interface WindowsPowerShellOptions extends AbstractShellOptions {
  /** Per-terminal cmd.exe session for cwd / env / drive-cwd isolation. */
  readonly windowsSession?: WindowsShellSession | null;
}

export class WindowsPowerShellShell extends AbstractShell {
  readonly kind = 'powershell';

  private subShell: PowerShellSubShell;
  private banner: readonly string[];
  private readonly windowsSession: WindowsShellSession | null;
  /** True when this shell owns the WindowsShellSession (allocated it
   *  itself, typical of SSH-pushed PS) and must close it on dispose. */
  private readonly ownsSession: boolean;
  private pendingSshAuth: PendingSshAuth | null = null;
  private pendingExecCommand: string | null = null;
  private readonly knownHostsTracker = new Set<string>();

  /** PowerShell exposes BOTH `clear` and `cls` as aliases of Clear-Host. */
  protected override clearWords: ReadonlySet<string> = new Set(['clear', 'cls', 'clear-host']);

  constructor(opts: WindowsPowerShellOptions) {
    super(opts);
    if (opts.windowsSession) {
      this.windowsSession = opts.windowsSession;
      this.ownsSession = false;
    } else if (opts.device instanceof WindowsPC) {
      // No session supplied (typical SSH push): allocate one bound to
      // the SSH user's home so PS commands operate on the right cwd
      // instead of leaking C:\\Users\\User across foreign SSH sessions.
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
    const { subShell, banner } = PowerShellSubShell.create(opts.device, {
      initialCwd: opts.context.cwd,
      // Pass the (possibly freshly-allocated) per-shell session so PS
      // commands operate on the SSH user's tree, not the global cwd.
      session: this.windowsSession,
    });
    this.subShell = subShell;
    this.banner = banner;
  }

  override setInputHost(host: import('@/shell/input').InputHost): void {
    super.setInputHost(host);
    this.subShell.setInputHost?.(host);
  }

  getPrompt(): string {
    return this.subShell.getPrompt();
  }

  override getActivationBanner(): readonly string[] {
    return this.banner;
  }

  protected async dispatch(line: string): Promise<ShellLineResult> {
    const sshAttempt = await tryInterpretSshLaunch(line, {
      defaultUser: this.user,
      knownHostsTracker: this.knownHostsTracker,
      sourceIp: firstConfiguredIpPs(this.device),
      sourceHostname: (this.device as unknown as { getHostname?: () => string }).getHostname?.(),
    });
    if (sshAttempt) {
      if (sshAttempt.kind === 'noop' || sshAttempt.kind === 'error'
          || sshAttempt.kind === 'exec') {
        return sshAttempt.result;
      }
      const brokerResult = await this.runSshAuthViaBroker(
        sshAttempt.pendingAuth,
        parseSshExecCommandPs(line),
      );
      if (brokerResult) return brokerResult;
      this.pendingSshAuth = sshAttempt.pendingAuth;
      this.pendingExecCommand = parseSshExecCommandPs(line);
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
    if (this.windowsSession && this.ownsSession
        && this.device instanceof WindowsPC) {
      this.device.closeShellSession(this.windowsSession);
    }
  }

  private async runSshAuthViaBroker(
    auth: PendingSshAuth,
    execCmd: string | null,
  ): Promise<ShellLineResult | null> {
    if (!this.input.capabilities().interactive) return null;
    const promptText = `${auth.user}@${auth.host}'s password: `;
    for (;;) {
      const pw = await this.input.password(promptText);
      if (pw === null) return { output: [] };
      const finalised = finalisePendingAuth(auth, pw);
      if (finalised) {
        if (execCmd !== null) {
          const lines = await runSshExec(auth, execCmd);
          finalised.shell.dispose();
          return { output: [...finalised.banner, ...lines] };
        }
        return { output: [...finalised.banner], childShell: finalised.shell };
      }
      if (auth.attempts >= SSH_MAX_ATTEMPTS) {
        return { output: [`${auth.user}@${auth.host}: Permission denied (publickey,password).`] };
      }
      this.input.emit('Permission denied, please try again.');
    }
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

/** Sanity guard — surfaces a clear error if someone tries to spawn PS
 *  on a non-Windows device, instead of producing nonsense later. */
export function assertPowerShellTarget(device: unknown): asserts device is WindowsPC {
  if (!(device instanceof WindowsPC)) {
    throw new Error('PowerShell can only run on a WindowsPC device');
  }
}

function firstConfiguredIpPs(dev: unknown): string | undefined {
  const ports = (dev as { ports?: Map<string, { getIPAddress: () => { toString(): string } | null }> }).ports;
  if (!ports) return undefined;
  for (const port of ports.values()) {
    const ip = port.getIPAddress?.();
    if (ip) return ip.toString();
  }
  return undefined;
}
