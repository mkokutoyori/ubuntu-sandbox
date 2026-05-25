/**
 * LinuxBashShell — concrete shell that runs bash on a Linux machine.
 *
 * Adapter over the legacy LinuxCommandExecutor: every line is forwarded
 * to the device's `executeCommand`, the result is split into output
 * lines, and known sub-shell launchers (`sqlplus`, `rman`, `python3`,
 * …) are intercepted so the right child shell can be pushed onto the
 * Shell stack rather than just printing their banner.
 *
 * Design pattern: **Adapter** — preserves the existing dispatch path
 * without ripping it out; the Shell layer is a thin facade.
 */

import type { Equipment } from '@/network';
import { AbstractShell, type AbstractShellOptions } from '../AbstractShell';
import type { IShell, ShellLineResult } from '../IShell';
import { ShellFactory } from '../ShellFactory';
import { LinuxMachine } from '@/network/devices/LinuxMachine';
import type { LinuxShellSession } from '@/network/devices/linux/shell/LinuxShellSession';

interface LinuxDevice {
  executeCommand(cmd: string): Promise<string>;
  executeCommandInSession?(cmd: string, s: LinuxShellSession): Promise<string>;
  getHostname(): string;
}

export class LinuxBashShell extends AbstractShell {
  readonly kind = 'bash';

  private session: LinuxShellSession | null = null;

  constructor(opts: AbstractShellOptions) {
    super(opts);
    if (opts.device instanceof LinuxMachine) {
      this.session = opts.device.openShellSession({
        user: opts.user,
        cwd: opts.context.cwd,
      });
      const um = (opts.device as unknown as { executor: { userMgr: { getUser: (n: string) => { uid?: number; gid?: number } | undefined } } })
        .executor.userMgr;
      const u = um.getUser(opts.user);
      if (u) {
        this.context.credentials = {
          ...this.context.credentials,
          uid: u.uid ?? this.context.credentials.uid,
          gid: u.gid ?? this.context.credentials.gid,
          euid: u.uid ?? this.context.credentials.euid,
          egid: u.gid ?? this.context.credentials.egid,
        };
      }
    }
  }

  override getActivationBanner(): readonly string[] {
    return [];
  }

  override getDeactivationBanner(): readonly string[] {
    return ['logout'];
  }

  /**
   * Sub-shell launchers a real bash recognises by exec'ing the binary.
   * Each entry maps the bare command line (after trimming flags) to the
   * child-shell kind we should push.
   */
  private static readonly SUBSHELL_TRIGGERS: ReadonlyMap<RegExp, string> = new Map([
    [/^sqlplus\b/i,  'sqlplus'],
    [/^rman\b/i,     'rman'],
    [/^lsnrctl\b/i,  'lsnrctl'],
  ]);

  protected async dispatch(line: string): Promise<ShellLineResult> {
    // Sub-shell launch intercept: a real Linux box would exec the
    // binary and hand the tty to it. Here we push the registered Shell
    // adapter for that interpreter pointed at the same device, so the
    // user lands in the child's real prompt instead of a single-shot
    // command transcript.
    for (const [pattern, kind] of LinuxBashShell.SUBSHELL_TRIGGERS) {
      if (pattern.test(line)) {
        const child = ShellFactory.tryCreateChild(kind, {
          device: this.device,
          user: this.user,
          parent: this,
          launchLine: line,
        });
        if (child) return { output: [], childShell: child };
        // Fall through if no adapter is registered — print the legacy
        // device output (banner / error) like the simulator did before.
      }
    }

    const dev = this.device as unknown as LinuxDevice;
    const raw = (this.session && this.device instanceof LinuxMachine
      && dev.executeCommandInSession)
      ? await dev.executeCommandInSession(line, this.session)
      : await dev.executeCommand(line);
    if (this.session) {
      this.context.cwd = this.session.cwd;
    }
    return { output: this.splitOutput(raw) };
  }

  getPrompt(): string {
    const dev = this.device as unknown as { getHostname(): string };
    const host = dev.getHostname() || 'localhost';
    const home = `/home/${this.user}`;
    const cwd = this.session?.cwd ?? this.context.cwd;
    const cwdShort = cwd === home ? '~' : cwd;
    const ch = this.context.credentials.euid === 0 ? '#' : '$';
    return `${this.user}@${host}:${cwdShort}${ch} `;
  }

  protected override onDispose(): void {
    if (this.session && this.device instanceof LinuxMachine) {
      this.device.closeShellSession(this.session);
    }
  }

  private splitOutput(s: string): string[] {
    if (!s) return [];
    return s.replace(/\n+$/, '').split('\n');
  }
}
