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

interface LinuxDevice {
  executeCommand(cmd: string): Promise<string>;
  getHostname(): string;
}

export class LinuxBashShell extends AbstractShell {
  readonly kind = 'bash';

  constructor(opts: AbstractShellOptions) {
    super(opts);
  }

  getPrompt(): string {
    const dev = this.device as unknown as { getHostname(): string };
    const host = dev.getHostname() || 'localhost';
    const home = `/home/${this.user}`;
    const cwdShort = this.context.cwd === home ? '~' : this.context.cwd;
    const ch = this.context.credentials.euid === 0 ? '#' : '$';
    return `${this.user}@${host}:${cwdShort}${ch} `;
  }

  override getActivationBanner(): readonly string[] {
    return []; // The SSH login banner is rendered by the connector, not here.
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
    const raw = await dev.executeCommand(line);
    return { output: this.splitOutput(raw) };
  }

  private splitOutput(s: string): string[] {
    if (!s) return [];
    return s.replace(/\n+$/, '').split('\n');
  }
}
