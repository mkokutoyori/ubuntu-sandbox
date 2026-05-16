/**
 * PowerShellSubShell — Interactive PowerShell sub-shell.
 *
 * Wraps the PowerShellExecutor into the ISubShell interface,
 * making PowerShell a proper sub-shell of cmd.exe (just like
 * SQL*Plus is a sub-shell of bash).
 *
 * Supports nesting: from PowerShell you can type "cmd" to get
 * a nested CmdSubShell, and from there "powershell" again, etc.
 */

import type { Equipment } from '@/network';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { PS_BANNER } from '@/network/devices/windows/PSConstants';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';
import { PSRuntimeError } from '@/powershell/interpreter/PSInterpreter';
import { PSParserError } from '@/powershell/parser/PSParserError';
import { createWindowsPSProviders } from '@/powershell/providers/WindowsPSProviders';
import { WindowsPC } from '@/network/devices/WindowsPC';

/**
 * Tokens that bypass the interpreter and go straight to the legacy
 * PowerShellExecutor. After Phase 4 only `ping` / `tracert` remain —
 * their handlers (cmdPing / cmdTracert) are async and the PSRuntime
 * tree-walker is sync, so making them real ICmdlets is gated on an
 * async-runtime conversion.
 *
 * Every other native (ipconfig / netsh / arp / route / getmac /
 * systeminfo / ver / nslookup / net) is a real ICmdlet wired to
 * INetworkProvider.runSyncNativeCommand().
 *
 * PS-cmdlet aliases (ls / dir / cd / pwd / cat / type / cp / mv / rm /
 * del / ren / mkdir / rmdir / hostname / whoami) are also first-class
 * ICmdlets in the interpreter's core registry.
 */
const DEVICE_ONLY_COMMANDS = new Set([
  'ping', 'tracert',
]);

export class PowerShellSubShell implements ISubShell {
  private psExecutor: PowerShellExecutor;
  private interp: PSInterpreter;
  private device: Equipment;
  private commandHistory: string[] = [];

  private constructor(device: Equipment) {
    this.device = device;
    this.psExecutor = new PowerShellExecutor(device as any);
    // The interpreter and the legacy executor look at the same per-device
    // state (Phase 4 relocation): registry / event-log / network maps /
    // VPN connections all live on the WindowsPC itself, not on the
    // executor. createWindowsPSProviders picks them up directly from the
    // device. Non-Windows devices keep the default NULL_PROVIDERS.
    this.interp = device instanceof WindowsPC
      ? new PSInterpreter(createWindowsPSProviders(device, {
          registry: device.registry,
          eventLog: device.eventLog,
          network: {
            extraIPs:             device.extraIPs,
            extraRoutes:          device.extraRoutes,
            adapterOverrides:     device.adapterOverrides,
            dynamicFirewallRules: device.dynamicFirewallRules,
            networkProfiles:      device.networkProfiles,
          },
          vpn: { vpnConnections: device.vpnConnections },
        }))
      : new PSInterpreter();
  }

  /**
   * Factory: create a PowerShell sub-shell for a Windows device.
   *
   * @returns The sub-shell and banner lines.
   */
  static create(device: Equipment): { subShell: PowerShellSubShell; banner: string[] } {
    const subShell = new PowerShellSubShell(device);
    // Sync initial cwd from the device
    subShell.psExecutor.setCwd((device as any).getCwd());
    // Wire env-var resolution so $env:APPDATA etc. return Windows-accurate values
    subShell.interp.envVarHook = (name: string) => subShell.psExecutor.resolveEnvVar(name);
    // Wire Test-Path to filesystem + registry
    subShell.interp.testPathHook = (path: string) => subShell.psExecutor.testPathRaw(path);
    return {
      subShell,
      banner: PS_BANNER.split('\n'),
    };
  }

  getPrompt(): string {
    return this.psExecutor.getPrompt();
  }

  handleKey(e: KeyEvent): boolean {
    // Ctrl+D → ignored in PowerShell (not a Unix shell)
    if (e.key === 'd' && e.ctrlKey) return true;
    // Ctrl+C → cancel current input (handled at session level)
    if (e.key === 'c' && e.ctrlKey) return true;
    // All other keys go to the view's text input
    return false;
  }

  async processLine(line: string): Promise<SubShellResult> {
    const trimmed = line.trim();

    // "exit" → leave PowerShell, return to parent cmd
    if (trimmed.toLowerCase() === 'exit') {
      return { output: [], exit: true, prompt: this.getPrompt() };
    }

    // Track history for Get-History
    if (trimmed) {
      this.commandHistory.push(trimmed);
    }
    this.psExecutor.setHistory(this.commandHistory);

    // "cmd" / "cmd.exe" → signal to the session that a nested cmd is needed
    // The session will handle creating a CmdSubShell
    if (trimmed.toLowerCase() === 'cmd' || trimmed.toLowerCase() === 'cmd.exe') {
      return {
        output: [
          'Microsoft Windows [Version 10.0.22631.6649]',
          '(c) Microsoft Corporation. All rights reserved.',
        ],
        exit: false,
        prompt: this.getPrompt(),
        // The session detects this via a special marker
        _enterCmd: true,
      } as SubShellResult & { _enterCmd: boolean };
    }

    // cls / clear-host / clear → clear screen
    const lower = trimmed.toLowerCase();
    if (lower === 'cls' || lower === 'clear-host' || lower === 'clear') {
      return { output: [], exit: false, prompt: this.getPrompt(), clearScreen: true };
    }

    // Sync cwd to PS executor BEFORE the command runs (so relative paths
    // resolve from the right place).
    this.psExecutor.setCwd((this.device as any).getCwd());

    // Execute the PowerShell command via the interpreter first, then fall back
    // to the legacy executor for device-bound cmdlets or syntax the interpreter
    // doesn't understand.
    const result = await this.dispatchCommand(trimmed);

    const output = (result !== null && result !== undefined && result !== '')
      ? result.split('\n')
      : [];

    // Re-sync AFTER the command: Set-Location / cd / Push-Location change
    // the device cwd, and the prompt must reflect the *new* directory
    // immediately — not lag a command behind.
    this.psExecutor.setCwd((this.device as any).getCwd());

    return {
      output,
      exit: false,
      prompt: this.psExecutor.getPrompt(),
    };
  }

  /**
   * Route a single command through the interpreter (the primary engine after
   * Phase 4). Async native CLI tools (ping / tracert / net) still go to
   * PowerShellExecutor because the tree-walker is sync. Other interpreter
   * errors that look like "not recognized" also fall through to the executor
   * as a safety net during the migration tail — once every test path runs
   * cleanly through the interpreter this branch can be removed.
   */
  private async dispatchCommand(line: string): Promise<string | null> {
    if (this.shouldBypassInterpreter(line)) {
      PowerShellSubShell.fallbackHits++;
      return this.psExecutor.execute(line);
    }
    try {
      return this.interp.executeInteractive(line);
    } catch (e) {
      if (this.isFallbackError(e)) {
        PowerShellSubShell.fallbackHits++;
        return this.psExecutor.execute(line);
      }
      return this.formatInterpreterError(e);
    }
  }

  // Debug counter — useful when assessing how much production code still
  // reaches PowerShellExecutor. Exposed as a static so tests can read it.
  static fallbackHits = 0;

  /**
   * Heuristic: skip the interpreter entirely for commands that are clearly
   * device-bound (ipconfig, ping, cd, ls, ...).  Avoids noisy parse errors
   * and keeps fallback output identical to the pre-interpreter behavior.
   */
  private shouldBypassInterpreter(line: string): boolean {
    const firstToken = line.split(/\s+/)[0]?.toLowerCase() ?? '';
    return DEVICE_ONLY_COMMANDS.has(firstToken);
  }

  private isFallbackError(e: unknown): boolean {
    if (e instanceof PSParserError) return true;
    if (e instanceof PSRuntimeError) return /not recognized/i.test(e.message);
    // Cmdlets throw plain Error with "not recognized" to signal provider fallback
    if (e instanceof Error) return /not recognized/i.test(e.message);
    return false;
  }

  private formatInterpreterError(e: unknown): string {
    if (e instanceof Error) return e.message;
    return String(e);
  }

  /**
   * PowerShell-style Tab completion.
   *  - First token (command position): every cmdlet name + alias from
   *    the live registry, prefix-matched case-insensitively.
   *  - Later tokens (argument position): filesystem path completion off
   *    the device's current directory — directories get a trailing `\`
   *    so the user can keep tabbing deeper, exactly like real PS.
   *
   * Returns FULL candidate tokens (not just the suffix) so the session's
   * completeInput helper can diff against the last whitespace word.
   */
  getCompletions(line: string): string[] {
    const trimmed = line.trimStart();
    const parts = trimmed.split(/\s+/);
    const onFirstToken = parts.length <= 1 && !/\s$/.test(line);

    if (onFirstToken) {
      const prefix = (parts[0] ?? '').toLowerCase();
      return this.interp.listCommandNames()
        .filter(n => n.toLowerCase().startsWith(prefix));
    }

    // Argument position → path completion. Complete the last token.
    const lastArg = /\s$/.test(line) ? '' : (parts[parts.length - 1] ?? '');
    if (!(this.device instanceof WindowsPC)) return [];
    const fs  = this.device.getFileSystem();
    const cwd = this.device.getCwd();

    // Strip optional surrounding quote (PS quotes paths with spaces).
    const quote = lastArg.startsWith('"') || lastArg.startsWith("'")
      ? lastArg[0] : '';
    const bare = quote ? lastArg.slice(1) : lastArg;

    const sep = Math.max(bare.lastIndexOf('\\'), bare.lastIndexOf('/'));
    const dirPart = sep >= 0 ? bare.slice(0, sep) : '';
    const namePart = sep >= 0 ? bare.slice(sep + 1) : bare;
    const absDir = fs.normalizePath(dirPart || '.', cwd);

    const names = fs.getCompletions(absDir, namePart);
    return names.map(n => {
      const isDir = fs.isDirectory(
        fs.normalizePath((dirPart ? dirPart + '\\' : '') + n, cwd),
      );
      const full = (dirPart ? dirPart + '\\' : '') + n + (isDir ? '\\' : '');
      return quote ? quote + full : full;
    });
  }

  dispose(): void {
    // No resources to clean up
  }
}
