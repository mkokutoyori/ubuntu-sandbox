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
import type { WindowsShellSession } from '@/network/devices/windows/shell/WindowsShellSession';

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
  readonly kind = 'powershell';
  readonly connection = 'subshell' as const;
  private psExecutor: PowerShellExecutor;
  private interp: PSInterpreter;
  private device: Equipment;
  private commandHistory: string[] = [];
  /**
   * Owning terminal's cmd.exe shell session. When set, every command
   * dispatched through this sub-shell runs inside a session swap-window so
   * the interpreter, the legacy executor, and any cmd-command delegation
   * observe THIS terminal's cwd / env / driveCwd — not the device-wide
   * shared fields (terminal_gap.md §7.x).
   */
  private session: WindowsShellSession | null = null;

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
   * @param device  The Windows device hosting the sub-shell.
   * @param opts.initialCwd  Optional starting cwd — pass the parent
   *  WindowsShellSession's cwd so PowerShell launched from terminal A
   *  doesn't inherit terminal B's cwd via the device-wide shared field
   *  (terminal_gap.md §7.5). When omitted, falls back to the device cwd
   *  for backwards-compat with callers that do not yet thread a session.
   * @returns The sub-shell and banner lines.
   */
  static create(
    device: Equipment,
    opts?: { initialCwd?: string; session?: WindowsShellSession | null },
  ): { subShell: PowerShellSubShell; banner: string[] } {
    const subShell = new PowerShellSubShell(device);
    subShell.session = opts?.session ?? null;
    // Prefer the caller-provided cwd (per-terminal session); fall back to
    // the device's shared cwd so legacy call sites still work.
    const startCwd = opts?.initialCwd ?? opts?.session?.cwd ?? (device as any).getCwd();
    subShell.psExecutor.setCwd(startCwd);
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

    // "cmd" / "cmd.exe" → signal to the session that a nested cmd is needed.
    // The banner is intentionally NOT included in `output` here: the
    // session's enterNestedCmd() owns banner rendering via
    // CmdSubShell.create(). Returning it both places duplicated the
    // "Microsoft Windows [Version …]" header (terminal_gap.md §9.3).
    if (trimmed.toLowerCase() === 'cmd' || trimmed.toLowerCase() === 'cmd.exe') {
      return {
        output: [],
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

    // Dispatch inside the owning terminal's session window when one is
    // attached. Inside the window, `device.getCwd()` and any
    // `device.executeCmdCommand(...)` delegation from PowerShellExecutor
    // observe THIS terminal's cwd / env (terminal_gap.md §7.x).
    const dispatch = async (): Promise<string | null> => {
      this.psExecutor.setCwd((this.device as any).getCwd());
      const out = await this.dispatchCommand(trimmed);
      this.psExecutor.setCwd((this.device as any).getCwd());
      return out;
    };

    const result = (this.session && this.device instanceof WindowsPC)
      ? await this.device.runInSession(this.session, dispatch)
      : await dispatch();

    const output = (result !== null && result !== undefined && result !== '')
      ? result.split('\n')
      : [];

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
   * PowerShell-grade Tab completion. Returns FULL candidate tokens so the
   * session can replace the trailing word and cycle through them.
   *
   * Context is resolved like the real shell:
   *   $var<Tab>      → variable names in scope (+ automatic variables)
   *   cmd -Pa<Tab>   → that cmdlet's parameters + the common parameters
   *   <verb-noun>    → cmdlet names + aliases (command position, also the
   *                    token right after `|`, `;`, `&`, `(`, `{`)
   *   anything else  → device filesystem path completion (dirs get `\`,
   *                    paths with spaces are quoted)
   */
  getCompletions(line: string): string[] {
    const endsWithSpace = /\s$/.test(line);
    // Current token = trailing run of non-whitespace (empty after a space).
    const tokMatch = /(\S*)$/.exec(line);
    const token = endsWithSpace ? '' : (tokMatch ? tokMatch[1] : '');

    // Segment = everything after the last unquoted pipeline/scope break,
    // so `Get-Process | gp<Tab>` still treats `gp` as a command.
    const seg = this.currentSegment(line);
    const segTokens = seg.trim().length ? seg.trim().split(/\s+/) : [];
    const commandWord = segTokens[0] ?? '';
    const onCommandPosition =
      segTokens.length === 0 ||
      (segTokens.length === 1 && !endsWithSpace);

    // 1) Variable completion ($name / $env:name).
    if (token.startsWith('$')) {
      return this.completeVariable(token);
    }

    // 2) Parameter completion (-Name), only in argument position.
    if (token.startsWith('-') && !onCommandPosition) {
      return this.completeParameter(commandWord, token);
    }

    // 3) Command-name completion.
    if (onCommandPosition) {
      const prefix = token.toLowerCase();
      return this.interp.listCommandNames()
        .filter(n => n.toLowerCase().startsWith(prefix))
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    }

    // 4) Filesystem path completion.
    return this.completePath(token);
  }

  /** Substring after the last unquoted `| ; & ( { ` separator. */
  private currentSegment(line: string): string {
    let depth = 0, q = '', start = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '(' || c === '{') { depth++; start = i + 1; continue; }
      if (c === ')' || c === '}') { depth = Math.max(0, depth - 1); continue; }
      if (c === '|' || c === ';' || c === '&') start = i + 1;
    }
    return line.slice(start);
  }

  private completeVariable(token: string): string[] {
    // Keep an optional scope prefix ($env:, $script:, $global:).
    const m = /^\$((?:env|script|global|local|using|private):)?(.*)$/i.exec(token);
    if (!m) return [];
    const scope = m[1] ?? '';
    const stem = (m[2] ?? '').toLowerCase();
    const AUTO = [
      '$_', '$args', '$error', '$false', '$true', '$null', '$input',
      '$home', '$host', '$pid', '$pwd', '$profile', '$psitem',
      '$pscommandpath', '$psscriptroot', '$psversiontable', '$lastexitcode',
      '$matches', '$foreach', '$switch', '$this', '$ofs',
    ];
    if (scope) {
      const names = scope.toLowerCase() === 'env:'
        ? this.envNames()
        : this.interp.listVariableNames();
      return names
        .filter(n => n.toLowerCase().startsWith(stem))
        .map(n => `$${scope}${n}`)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    }
    const live = this.interp.listVariableNames().map(n => `$${n}`);
    const pool = [...new Set([...AUTO, ...live])];
    return pool
      .filter(v => v.toLowerCase().startsWith(`$${stem}`))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }

  private envNames(): string[] {
    if (!(this.device instanceof WindowsPC)) return [];
    try {
      return [...this.device.getEnvVars().keys()];
    } catch { return []; }
  }

  private completeParameter(commandWord: string, token: string): string[] {
    const stem = token.slice(1).toLowerCase(); // drop leading '-'
    const COMMON = [
      'Verbose', 'Debug', 'ErrorAction', 'WarningAction', 'InformationAction',
      'ErrorVariable', 'WarningVariable', 'InformationVariable', 'OutVariable',
      'OutBuffer', 'PipelineVariable', 'WhatIf', 'Confirm',
    ];
    const declared = commandWord
      ? this.interp.getCommandParameters(commandWord)
      : [];
    const pool = [...new Set([...declared, ...COMMON])];
    return pool
      .filter(p => p.toLowerCase().startsWith(stem))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(p => `-${p}`);
  }

  private completePath(token: string): string[] {
    if (!(this.device instanceof WindowsPC)) return [];
    const fs  = this.device.getFileSystem();
    // Prefer the per-terminal session cwd over the device-wide shared one
    // so Tab-completion in PowerShell resolves paths in the terminal's own
    // location (terminal_gap.md §7.x).
    const cwd = this.session?.cwd ?? this.device.getCwd();

    const quote = token.startsWith('"') || token.startsWith("'")
      ? token[0] : '';
    const bare = quote ? token.slice(1).replace(/["']$/, '') : token;

    const sep = Math.max(bare.lastIndexOf('\\'), bare.lastIndexOf('/'));
    const dirPart  = sep >= 0 ? bare.slice(0, sep) : '';
    const namePart = sep >= 0 ? bare.slice(sep + 1) : bare;
    const absDir   = fs.normalizePath(dirPart || '.', cwd);

    const names = fs.getCompletions(absDir, namePart);
    return names
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(n => {
        const isDir = fs.isDirectory(
          fs.normalizePath((dirPart ? dirPart + '\\' : '') + n, cwd),
        );
        const full = (dirPart ? dirPart + '\\' : '') + n + (isDir ? '\\' : '');
        // PowerShell wraps paths containing spaces in single quotes.
        if (quote) return quote + full + (isDir ? '' : quote);
        return /\s/.test(full) ? `'${full}'` : full;
      });
  }

  dispose(): void {
    // No resources to clean up
  }
}
