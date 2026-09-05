/**
 * PowerShellSubShell — Interactive PowerShell sub-shell.
 *
 * Wraps the PowerShell interpreter into the ISubShell interface,
 * making PowerShell a proper sub-shell of cmd.exe (just like
 * SQL*Plus is a sub-shell of bash).
 *
 * Supports nesting: from PowerShell you can type "cmd" to get
 * a nested CmdSubShell, and from there "powershell" again, etc.
 */

import type { Equipment } from '@/network';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import { PromiseInputBroker as PromiseInputBrokerPS } from '@/shell/input';
import { isRegistryPath } from '@/network/devices/windows/PSRegistryProvider';
import { NativeCommandNeedsAsync, translateNativeAnswer, nativeLineFor } from '@/powershell/nativeAsync';
import { PS_BANNER } from '@/network/devices/windows/PSConstants';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';
import { createWindowsPSProviders } from '@/powershell/providers/WindowsPSProviders';
import { WindowsPC } from '@/network/devices/WindowsPC';
import type { WindowsShellSession } from '@/network/devices/windows/shell/WindowsShellSession';
import { findHostByAddress } from '@/network/devices/linux/network/HostLookup';
import { parseCredentialArg } from '@/powershell/cmdlets/core/RemotingCmdlets';
import { makePSCredential, formatPSCredentialTable } from '@/powershell/credential/PSCredential';

/**
 * Tokens that bypass the interpreter and are handed straight to the
 * device's cmd engine. Only `ping` / `tracert` remain — their handlers
 * (cmdPing / cmdTracert) are async and the PSRuntime tree-walker is
 * sync, so making them real ICmdlets is gated on an async-runtime
 * conversion. `$variables` in their arguments are expanded by the
 * interpreter first, so the bypass is not a second variable scope.
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
  /** Set for a sub-shell pushed by `Enter-PSSession` — prefixes every prompt with `[computername]: `. */
  private promptPrefix = '';

  private constructor(device: Equipment) {
    this.device = device;
    // The interpreter and the legacy executor look at the same per-device
    // state (Phase 4 relocation): registry / event-log / network maps /
    // VPN connections all live on the WindowsPC itself, not on the
    // executor. createWindowsPSProviders picks them up directly from the
    // device. Non-Windows devices keep the default NULL_PROVIDERS.
    this.interp = device instanceof WindowsPC
      ? new PSInterpreter(
          createWindowsPSProviders(device), { edition: device.getWindowsEdition() },
        )
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
    opts?: { initialCwd?: string; session?: WindowsShellSession | null; promptPrefix?: string },
  ): { subShell: PowerShellSubShell; banner: string[] } {
    const subShell = new PowerShellSubShell(device);
    subShell.session = opts?.session ?? null;
    subShell.promptPrefix = opts?.promptPrefix ?? '';
    // Prefer the caller-provided cwd (per-terminal session); fall back to
    // the device's shared cwd so legacy call sites still work.
    if (opts?.initialCwd && !subShell.session) (device as unknown as { setCwd(p: string): void }).setCwd(opts.initialCwd);
    // Wire env-var resolution so $env:APPDATA etc. return Windows-accurate values
    subShell.interp.envVarHook = (name: string) => subShell.deviceEnvVar(name);
    // Wire Test-Path to filesystem + registry
    subShell.interp.testPathHook = (path: string) => subShell.devicePathExists(path);
    subShell.interp.historyHook = () => subShell.commandHistory;
    return {
      subShell,
      banner: PS_BANNER.split('\n'),
    };
  }

  getPrompt(): string {
    const cwd = this.session?.cwd ?? (this.device as unknown as { getCwd(): string }).getCwd();
    return `${this.promptPrefix}PS ${cwd}> `;
  }

  private deviceEnvVar(name: string): string | null {
    const device = this.device as unknown as { getEnvVars?(): Map<string, string> };
    return device.getEnvVars?.().get(name.toUpperCase()) ?? null;
  }

  private devicePathExists(path: string): boolean {
    const device = this.device as unknown as {
      registry?: { testPath(p: string): boolean };
      getFileSystem?(): { normalizePath(p: string, cwd: string): string; exists(p: string): boolean };
      getCwd(): string;
    };
    if (isRegistryPath(path)) return device.registry?.testPath(path) ?? false;
    const fs = device.getFileSystem?.();
    if (!fs) return false;
    return fs.exists(fs.normalizePath(path, device.getCwd()));
  }

  handleKey(e: KeyEvent): boolean {
    // Ctrl+D → ignored in PowerShell (not a Unix shell)
    if (e.key === 'd' && e.ctrlKey) return true;
    // Ctrl+C → cancel current input (handled at session level)
    if (e.key === 'c' && e.ctrlKey) return true;
    // All other keys go to the view's text input
    return false;
  }

  setInputHost(host: import('@/shell/input').InputHost): void {
    this._broker = new PromiseInputBrokerPS(host);
  }
  private _broker: import('@/shell/input').InputBroker | null = null;

  async processLine(line: string): Promise<SubShellResult> {
    const trimmed = line.trim();

    if (trimmed.toLowerCase() === 'exit') {
      return { output: [], exit: true, prompt: this.getPrompt() };
    }

    const readHostHit = await this.tryReadHostIntercept(trimmed);
    if (readHostHit) return readHostHit;

    const getCredentialHit = await this.tryGetCredentialIntercept(trimmed);
    if (getCredentialHit) return getCredentialHit;

    // Track history for Get-History
    if (trimmed) {
      this.commandHistory.push(trimmed);
    }
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

    // "Enter-PSSession" / "etsn" — real network reachability + auth over
    // TCP/5985 (PRD-Windows-Server.md §5 P4), then the session pushes a
    // nested PowerShellSubShell bound to the remote device (its prompt
    // prefixed "[computername]: ", matching real WinRM).
    const enterPsMatch = /^(?:enter-pssession|etsn)\b(.*)$/i.exec(trimmed);
    if (enterPsMatch) {
      return this.tryEnterPSSession(enterPsMatch[1]);
    }

    // cls / clear-host / clear → clear screen
    const lower = trimmed.toLowerCase();
    if (lower === 'cls' || lower === 'clear-host' || lower === 'clear') {
      return { output: [], exit: false, prompt: this.getPrompt(), clearScreen: true };
    }

    // Dispatch inside the owning terminal's session window when one is
    // attached. Inside the window, `device.getCwd()` and any
    // `device.executeCmdCommand(...)` delegation observe THIS terminal's
    // cwd / env (terminal_gap.md §7.x).
    const dispatch = async (): Promise<string | null> => this.dispatchCommand(trimmed);

    const result = (this.session && this.device instanceof WindowsPC)
      ? await this.device.runInSession(this.session, dispatch)
      : await dispatch();

    const output = (result !== null && result !== undefined && result !== '')
      ? result.split('\n')
      : [];

    // Le seul endroit par lequel passe une commande PowerShell exécutée
    // sur cette machine — donc le seul où la journaliser une fois, ni
    // plus ni moins. Les deux stratégies décident ; celle-ci ne fait
    // qu'annoncer.
    if (this.device instanceof WindowsPC) {
      this.device.recordPowerShellExecution(trimmed, output.join('\n'));
    }

    return {
      output,
      exit: false,
      prompt: this.getPrompt(),
    };
  }

  /**
   * `Enter-PSSession -ComputerName X [-Credential user[:password]]` — real
   * TCP/5985 dial + auth (PRD-Windows-Server.md §5 P4). On success returns
   * a marker the host terminal session uses to push a nested
   * PowerShellSubShell bound to the remote device.
   */
  private tryEnterPSSession(argsStr: string): SubShellResult {
    const compMatch = /-ComputerName\s+(\S+)/i.exec(argsStr);
    const bareMatch = !compMatch ? /^\s*(\S+)/.exec(argsStr) : null;
    const computerName = (compMatch?.[1] ?? bareMatch?.[1] ?? '').replace(/^["']|["']$/g, '');
    const credMatch = /-Credential\s+(\S+)/i.exec(argsStr);

    if (!computerName) {
      return { output: ['Enter-PSSession : Cannot bind argument to parameter \'ComputerName\' because it is an empty string.'], exit: false, prompt: this.getPrompt() };
    }
    if (!(this.device instanceof WindowsPC)) {
      return { output: [`Enter-PSSession : Connecting to remote server ${computerName} failed.`], exit: false, prompt: this.getPrompt() };
    }

    const fail = () => ({
      output: [
        `Enter-PSSession : Connecting to remote server ${computerName} failed with the following error message: ` +
        `WinRM cannot complete the operation. Verify that the specified computer name is valid, that the computer ` +
        `is accessible over the network, and that a firewall exception for the WinRM service is enabled and allows ` +
        `access from this computer.`,
      ],
      exit: false,
      prompt: this.getPrompt(),
    });

    const targetIp = this.device.resolveHostnameSync(computerName);
    if (!targetIp) return fail();
    const found = findHostByAddress(targetIp.toString());
    if (!found || found.poweredOff || found.interfaceDown) return fail();

    const credential = credMatch ? parseCredentialArg(credMatch[1]) : { username: this.device.getUserManager().currentUser, password: '' };
    const dial = this.device.dialWinRm(targetIp.toString(), credential.username, credential.password);
    if (!dial.ok) return fail();

    const hostname = (found.device as unknown as { getHostname?: () => string }).getHostname?.() ?? computerName;
    return {
      output: [],
      exit: false,
      prompt: '',
      _enterRemotePS: { device: found.device, promptPrefix: `[${hostname}]: ` },
    } as SubShellResult & { _enterRemotePS: { device: Equipment; promptPrefix: string } };
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
      const device = this.device as unknown as { executeCmdCommand(c: string): Promise<string> };
      return device.executeCmdCommand(this.interp.expandInterpolation(line));
    }
    try {
      return this.interp.executeInteractive(line);
    } catch (e) {
      if (e instanceof NativeCommandNeedsAsync) {
        const device = this.device as unknown as { executeCmdCommand(c: string): Promise<string> };
        return translateNativeAnswer(e.command, await device.executeCmdCommand(nativeLineFor(e, line)));
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

  private async tryReadHostIntercept(line: string): Promise<SubShellResult | null> {
    if (!this._broker) return null;
    if (!this._broker.capabilities().interactive) return null;
    const parsed = parseReadHost(line);
    if (!parsed) return null;
    const prompt = parsed.prompt ?? '';
    const value = parsed.secure
      ? await this._broker.password(prompt)
      : await this._broker.ask(prompt);
    if (parsed.bindTo) {
      this.interp.setVariable(parsed.bindTo, value ?? '');
      return { output: [], exit: false, prompt: this.getPrompt() };
    }
    return {
      output: value === null ? [] : [value],
      exit: false,
      prompt: this.getPrompt(),
    };
  }

  /**
   * `Get-Credential` (PRD-Nslookup-Dig-Rndc-Runas.md §2.1.7/P13) — same
   * subshell-level string interception as `Read-Host` above (the tree-walking
   * interpreter has no async/interactive-broker access, so neither cmdlet
   * has a normal `ICmdlet` — both are handled here, before the interpreter
   * ever sees the line). Prompts for a user name (unless `-UserName`/a bare
   * positional was given) then a masked password, and binds a real
   * `PSCredentialValue` — not a plain string — to the target variable.
   */
  private async tryGetCredentialIntercept(line: string): Promise<SubShellResult | null> {
    if (!this._broker) return null;
    if (!this._broker.capabilities().interactive) return null;
    const parsed = parseGetCredential(line);
    if (!parsed) return null;

    let userName = parsed.userName;
    if (!userName) {
      const namePrompt = parsed.message ? `${parsed.message}\nUser name:` : 'User name:';
      const entered = await this._broker.ask(namePrompt);
      if (entered === null) return { output: [], exit: false, prompt: this.getPrompt() };
      userName = entered;
    }

    const password = await this._broker.password(`Password for user ${userName}:`);
    if (password === null) return { output: [], exit: false, prompt: this.getPrompt() };

    const cred = makePSCredential(userName, password);
    if (parsed.bindTo) {
      this.interp.setVariable(parsed.bindTo, cred);
      return { output: [], exit: false, prompt: this.getPrompt() };
    }
    return { output: formatPSCredentialTable(cred), exit: false, prompt: this.getPrompt() };
  }
}

interface ParsedReadHost {
  bindTo: string | null;
  prompt: string | null;
  secure: boolean;
}

function parseReadHost(line: string): ParsedReadHost | null {
  const m = line.match(/^\s*(?:\$([A-Za-z_][A-Za-z_0-9]*)\s*=\s*)?Read-Host\b(.*)$/i);
  if (!m) return null;
  const tail = m[2].trim();
  let secure = false;
  let prompt: string | null = null;
  const tokens = tokenizePS(tail);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^-AsSecureString$/i.test(t)) { secure = true; continue; }
    if (/^-MaskInput$/i.test(t))      { secure = true; continue; }
    if (/^-Prompt$/i.test(t) && i + 1 < tokens.length) { prompt = tokens[++i]; continue; }
    if (i === 0 && !t.startsWith('-')) { prompt = t; continue; }
  }
  return { bindTo: m[1] ?? null, prompt, secure };
}

interface ParsedGetCredential {
  bindTo: string | null;
  userName: string | null;
  message: string | null;
}

function parseGetCredential(line: string): ParsedGetCredential | null {
  const m = line.match(/^\s*(?:\$([A-Za-z_][A-Za-z_0-9]*)\s*=\s*)?Get-Credential\b(.*)$/i);
  if (!m) return null;
  const tail = m[2].trim();
  let userName: string | null = null;
  let message: string | null = null;
  const tokens = tokenizePS(tail);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^-UserName$/i.test(t) && i + 1 < tokens.length) { userName = tokens[++i]; continue; }
    if (/^-Message$/i.test(t) && i + 1 < tokens.length) { message = tokens[++i]; continue; }
    if (i === 0 && !t.startsWith('-')) { userName = t; continue; }
  }
  return { bindTo: m[1] ?? null, userName, message };
}

function tokenizePS(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      buf += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ' ' || c === '\t') { if (buf) { out.push(buf); buf = ''; } continue; }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}
