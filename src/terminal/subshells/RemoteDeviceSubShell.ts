/**
 * RemoteDeviceSubShell — vendor-agnostic interactive sub-shell.
 *
 * Wraps ANY {@link Equipment} that exposes `executeCommand(line)` and
 * `getHostname()` — Linux, Windows, Cisco IOS, Huawei VRP. The sub-shell:
 *
 *   - renders the device's native prompt (delegated to the strategy)
 *   - forwards each input line to `device.executeCommand`
 *   - returns the output to the host terminal
 *   - exits on `exit` / `logout` / `quit` (vendor-specific) or Ctrl+D
 *
 * Use this whenever {@link RemoteShellSubShell} (which is Linux-only —
 * it prefixes each command with `cd <cwd> &&`) is too narrow.
 *
 * The PromptStrategy is the single point of variation between vendors,
 * so adding a new platform (Junos, Mikrotik …) is one strategy + an
 * `exitWords` list — never a new file in this directory.
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { Equipment } from '@/network';
import type { ISubShell, SubShellResult } from './ISubShell';

export interface RemotePromptStrategy {
  prompt(device: Equipment, user: string): string;
  exitWords: ReadonlyArray<string>;
}

const DEFAULT_STRATEGY: RemotePromptStrategy = {
  prompt: (d, u) => `${u}@${d.getHostname() || 'remote'}$ `,
  exitWords: ['exit', 'logout'],
};

export class RemoteDeviceSubShell implements ISubShell {
  readonly kind = 'remote-device';
  readonly connection = 'ssh' as const;
  constructor(
    private readonly device: Equipment,
    private readonly remoteUser: string,
    private readonly remoteHost: string,
    private readonly strategy: RemotePromptStrategy = DEFAULT_STRATEGY,
    private readonly onExit?: () => void,
  ) {}

  getPrompt(): string {
    return this.strategy.prompt(this.device, this.remoteUser);
  }

  handleKey(e: KeyEvent): boolean {
    return e.key === 'd' && e.ctrlKey;
  }

  async processLine(line: string): Promise<SubShellResult> {
    const trimmed = line.trim();
    if (!trimmed) return done([''], this.getPrompt());

    if (this.strategy.exitWords.includes(trimmed.toLowerCase())) {
      this.onExit?.();
      return {
        output: [`Connection to ${this.remoteHost} closed.`],
        exit: true,
        prompt: '',
      };
    }

    if (trimmed === 'clear' || trimmed === 'cls') {
      return { output: [''], exit: false, prompt: this.getPrompt(), clearScreen: true };
    }

    let out: string;
    try {
      out = await (this.device as unknown as { executeCommand: (c: string) => Promise<string> })
        .executeCommand(trimmed);
    } catch (err) {
      out = `error: ${err instanceof Error ? err.message : String(err)}`;
    }

    const lines = out ? out.replace(/\n$/, '').split('\n') : [];
    return { output: lines, exit: false, prompt: this.getPrompt() };
  }

  dispose(): void { /* nothing to clean up — caller manages onExit() */ }
}

function done(output: string[], prompt: string): SubShellResult {
  return { output, exit: false, prompt };
}

// ─── Built-in vendor strategies ───────────────────────────────────────

export const LinuxPromptStrategy: RemotePromptStrategy = {
  prompt: (d, u) => {
    const host = d.getHostname() || 'remote';
    const ch = u === 'root' ? '#' : '$';
    return `${u}@${host}:~${ch} `;
  },
  exitWords: ['exit', 'logout'],
};

export const CiscoPromptStrategy: RemotePromptStrategy = {
  prompt: (d) => `${d.getHostname() || 'Router'}#`,
  exitWords: ['exit', 'logout', 'quit'],
};

export const HuaweiPromptStrategy: RemotePromptStrategy = {
  prompt: (d) => `<${d.getHostname() || 'Huawei'}>`,
  exitWords: ['quit', 'exit', 'logout'],
};

export const WindowsPromptStrategy: RemotePromptStrategy = {
  prompt: (d, u) => `C:\\Users\\${u}>`,
  exitWords: ['exit', 'logout'],
};
