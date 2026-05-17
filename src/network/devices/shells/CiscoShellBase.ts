/**
 * CiscoShellBase — Abstract base class for Cisco IOS CLI shells.
 *
 * Factorizes the execute loop, FSM transitions, prompt generation,
 * help/tab-complete, and shared command registration that were previously
 * duplicated between CiscoIOSShell (Router) and CiscoSwitchShell (Switch).
 *
 * Template Method pattern: subclasses override hooks to provide
 * device-specific behavior (mode tries, prompt maps, etc.)
 *
 * @typeParam TDevice  The concrete device type (Router or Switch).
 *                     Subclasses use this for typed access to device-specific APIs.
 */

import { CommandTrie } from './CommandTrie';
import type { CiscoDevice } from './CiscoDevice';
import type { PromptMap } from './PromptBuilder';
import { buildPrompt } from './PromptBuilder';
import { CLIStateMachine, type ModeHierarchy } from './CLIStateMachine';
import { CISCO_ERRORS, parsePipeFilter, applyPipeFilter } from './cli-utils';
import {
  registerArpShowCommands, registerArpPrivilegedCommands, registerArpConfigCommands,
} from './cisco/CiscoArpCommands';
import {
  showClock, showUsers, showInventory, showProcessesCpu,
  showMemoryStatistics, showFlash, showPrivilege,
  showCdp, showLldp, showSnmp, showNtpStatus, showNtpAssociations,
  showLine, showIpSsh, showSshSessions, showHosts, showVrf, showBoot,
  showRedundancy, showFileSystems, showCalendar, showTerminal,
  showProcessesMemory, showBuffers, showTcpBrief, showSockets,
  showStacks, showReload, showAaa, showEnvironment, showControllers,
  type ShowStateDevice,
} from './cisco/CiscoCommonShow';
import { CiscoConfigState } from '../inspection/config/CiscoConfigState';
import { AliasRepository, type AliasMode } from '../inspection/config/AliasRepository';

export abstract class CiscoShellBase<TDevice extends CiscoDevice> {
  // ─── State ───────────────────────────────────────────────────────
  protected mode: string = 'user';
  /** Recent commands for `show history` (shared switch + router). */
  protected cmdHistory: string[] = [];
  protected deviceRef: TDevice | null = null;

  /**
   * Config-driven global feature state (cdp/lldp/ip routing…) — a real
   * Repository the CLI mutates and `show` projects (no silent no-ops).
   */
  protected readonly configState = new CiscoConfigState();

  /** Config-driven CLI aliases — real, working, projected by show. */
  protected readonly aliases = new AliasRepository();

  /** Async escape hatch: commands that return a Promise (e.g. ping on routers) */
  protected _pendingAsync: Promise<string> | null = null;

  // ─── FSM ─────────────────────────────────────────────────────────
  protected abstract readonly fsm: CLIStateMachine;

  // ─── Command Tries (common modes) ───────────────────────────────
  protected userTrie = new CommandTrie();
  protected privilegedTrie = new CommandTrie();
  protected configTrie = new CommandTrie();
  protected configIfTrie = new CommandTrie();
  /** Shared `line …` sub-mode trie (switch + router). */
  protected configLineTrie = new CommandTrie();

  // ─── Abstract hooks (Template Method) ───────────────────────────

  /** Return the CommandTrie for the current mode */
  protected abstract getActiveTrie(): CommandTrie;

  /** Clear state fields when FSM exits a mode (e.g. selectedInterface) */
  protected abstract clearFields(fields: string[]): void;

  /** Prompt template map for this device type */
  protected abstract getPromptMap(): PromptMap;

  /** Optional: called on 'write memory' / 'copy running-config startup-config' */
  protected abstract onSave(): string;

  /** Register device-specific commands on the tries (called from constructor) */
  protected abstract registerDeviceCommands(): void;

  // ─── Device accessor ────────────────────────────────────────────

  /** Get typed device reference. Throws if called outside execute(). */
  protected d(): TDevice {
    if (!this.deviceRef) throw new Error('Device reference not set (BUG: called outside execute)');
    return this.deviceRef;
  }

  /** Device as the real-state surface the shared show helpers read. */
  protected cs(): ShowStateDevice {
    return this.d() as unknown as ShowStateDevice;
  }

  // ─── Initialization ─────────────────────────────────────────────

  /**
   * Call from subclass constructor after setting up FSM and additional tries.
   * Registers all shared commands, then device-specific commands.
   */
  protected initializeCommands(): void {
    this.registerCommonUserCommands();
    this.registerCommonPrivilegedCommands();
    this.registerCommonConfigCommands();
    this.registerDeviceCommands();
  }

  // ─── Execute Loop (shared) ──────────────────────────────────────

  /**
   * Core execute logic shared by both router and switch shells.
   * Handles: empty input, pipe filtering, ?, exit/end, do prefix,
   * show shortcut, trie matching, async support, error formatting.
   */
  protected executeOnDevice(device: TDevice, rawInput: string): string | Promise<string> {
    const trimmed = rawInput.trim();
    if (!trimmed) return '';
    if (!trimmed.endsWith('?')) this.cmdHistory.push(trimmed);

    const parsed = parsePipeFilter(trimmed);
    let cmdPart = parsed.cmd;
    const pipeFilter = parsed.filter;

    // Context-sensitive help
    if (cmdPart.endsWith('?')) {
      this.deviceRef = device;
      const helpResult = this.getHelp(cmdPart.slice(0, -1));
      this.deviceRef = null;
      return helpResult;
    }

    // Exec alias expansion (real AliasRepository state): in
    // user/privileged mode, an alias head expands to its command.
    if (!this.isConfigMode()) {
      const sp = cmdPart.indexOf(' ');
      const head = sp === -1 ? cmdPart : cmdPart.slice(0, sp);
      const expansion = this.aliases.resolve('exec', head);
      if (expansion) cmdPart = expansion + (sp === -1 ? '' : cmdPart.slice(sp));
    }

    // Global shortcuts (no device ref needed)
    const lower = cmdPart.toLowerCase();
    if (lower === 'exit') return this.cmdExit();
    if (lower === 'end' || cmdPart === '\x03') return this.cmdEnd();
    if (lower === 'logout' && this.mode === 'user') return 'Connection closed.';
    if (lower === 'disable' && this.mode === 'privileged') {
      this.mode = 'user';
      return '';
    }

    // Bind device reference for command closures
    this.deviceRef = device;

    // 'do' prefix in config modes — delegate to privileged trie
    if (this.isConfigMode() && lower.startsWith('do ')) {
      const subCmd = cmdPart.slice(3).trim();
      const savedMode = this.mode;
      this.mode = 'privileged';
      const output = this.executeOnTrie(subCmd);
      this.mode = savedMode;
      this.deviceRef = null;
      return applyPipeFilter(output, pipeFilter);
    }

    // 'show' shortcut in config modes (same as 'do show')
    if (this.isConfigMode() && lower.startsWith('show ')) {
      const savedMode = this.mode;
      this.mode = 'privileged';
      const output = this.executeOnTrie(cmdPart);
      this.mode = savedMode;
      this.deviceRef = null;
      return applyPipeFilter(output, pipeFilter);
    }

    // Normal command execution
    const output = this.executeOnTrie(cmdPart);

    // Async escape hatch (e.g. ping on routers sets this)
    if (this._pendingAsync) {
      const asyncOp = this._pendingAsync;
      this._pendingAsync = null;
      this.deviceRef = null;
      return asyncOp.then(result => applyPipeFilter(result, pipeFilter));
    }

    this.deviceRef = null;
    return applyPipeFilter(output, pipeFilter);
  }

  // ─── Trie Matching ──────────────────────────────────────────────

  protected executeOnTrie(cmdPart: string): string {
    const trie = this.getActiveTrie();
    const result = trie.match(cmdPart);

    switch (result.status) {
      case 'ok':
        return result.node?.action ? result.node.action(result.args, cmdPart) : '';
      case 'ambiguous':
        return result.error || CISCO_ERRORS.AMBIGUOUS(cmdPart);
      case 'incomplete':
        return result.error || CISCO_ERRORS.INCOMPLETE;
      case 'invalid':
        return result.error || CISCO_ERRORS.INVALID_INPUT;
      default:
        return CISCO_ERRORS.UNRECOGNIZED(cmdPart);
    }
  }

  // ─── FSM Transitions ───────────────────────────────────────────

  protected cmdExit(): string {
    if (this.mode === 'user') return 'Connection closed.';
    this.fsm.mode = this.mode;
    const { newMode, fieldsToCllear } = this.fsm.exit();
    this.mode = newMode;
    this.clearFields(fieldsToCllear);
    return '';
  }

  protected cmdEnd(): string {
    this.fsm.mode = this.mode;
    const { newMode, fieldsToCllear } = this.fsm.end();
    this.mode = newMode;
    this.clearFields(fieldsToCllear);
    return '';
  }

  protected isConfigMode(): boolean {
    return this.mode !== 'user' && this.mode !== 'privileged';
  }

  // ─── Help / Tab-Complete ────────────────────────────────────────

  getHelp(input: string): string {
    const trie = this.getActiveTrie();
    const completions = trie.getCompletions(input);
    if (completions.length === 0) return CISCO_ERRORS.UNRECOGNIZED_HELP;
    const maxKw = Math.max(...completions.map(c => c.keyword.length));
    return completions
      .map(c => `  ${c.keyword.padEnd(maxKw + 2)}${c.description}`)
      .join('\n');
  }

  tabComplete(input: string): string | null {
    const trie = this.getActiveTrie();
    return trie.tabComplete(input);
  }

  // ─── Prompt ─────────────────────────────────────────────────────

  getMode(): string { return this.mode; }

  protected buildDevicePrompt(device: TDevice): string {
    return buildPrompt(this.mode, device._getHostnameInternal(), this.getPromptMap());
  }

  // ─── Shared Command Registration ───────────────────────────────

  /** IOS show/util commands common to every Cisco device + mode (DRY). */
  private registerCommonShowCommands(trie: CommandTrie): void {
    trie.register('show clock', 'Display the system clock', () => showClock());
    trie.register('show users', 'Display active lines', () => showUsers());
    trie.register('show inventory', 'Display hardware inventory', () =>
      showInventory(this.d().getHostname()));
    trie.register('show processes cpu', 'Display CPU utilisation', () =>
      showProcessesCpu());
    trie.registerGreedy('show memory', 'Display memory statistics', () =>
      showMemoryStatistics());
    trie.registerGreedy('show flash', 'Display flash filesystem', () => showFlash());
    trie.register('show privilege', 'Display current privilege level', () =>
      showPrivilege(this.mode === 'user' ? 1 : 15));
    trie.register('show history', 'Display command history', () =>
      this.cmdHistory.slice(-20).join('\n'));
    trie.registerGreedy('terminal', 'Set terminal parameters', () => '');

    // Generic device-info show family — missing on BOTH the Cisco
    // router and switch, so it lives here in the shared base (DRY).
    trie.register('show ntp status', 'Display NTP status', () => showNtpStatus());
    trie.registerGreedy('show ntp', 'Display NTP associations', () =>
      showNtpAssociations());
    trie.registerGreedy('show cdp', 'Display CDP information', (a) =>
      showCdp(this.cs(), a.join(' '), this.configState.isEnabled('cdp')));
    trie.registerGreedy('show lldp', 'Display LLDP information', (a) =>
      showLldp(this.cs(), a.join(' '), this.configState.isEnabled('lldp')));
    trie.registerGreedy('show snmp', 'Display SNMP status', () => showSnmp());
    trie.registerGreedy('show controllers', 'Display controller status', (a) =>
      showControllers(this.cs(), a.join(' ')));
    trie.registerGreedy('show environment', 'Display environment', () =>
      showEnvironment());
    trie.registerGreedy('show line', 'Display TTY lines', () =>
      showLine(this.cs()));
    trie.register('show ip ssh', 'Display SSH server status', () => showIpSsh());
    trie.registerGreedy('show ssh', 'Display SSH sessions', () =>
      showSshSessions());
    trie.registerGreedy('show hosts', 'Display host cache', () => showHosts());
    trie.register('show ip vrf', 'Display VRFs', () => showVrf());
    trie.registerGreedy('show vrf', 'Display VRFs', () => showVrf());
    trie.registerGreedy('show boot', 'Display boot variables', () => showBoot());
    trie.registerGreedy('show redundancy', 'Display redundancy state', () =>
      showRedundancy());
    trie.registerGreedy('show file', 'Display file systems', () =>
      showFileSystems());
    trie.register('show calendar', 'Display hardware calendar', () =>
      showCalendar());
    trie.registerGreedy('show terminal', 'Display terminal parameters', () =>
      showTerminal());
    trie.register('show processes memory', 'Display per-process memory', () =>
      showProcessesMemory());
    trie.registerGreedy('show buffers', 'Display buffer pools', () =>
      showBuffers());
    trie.registerGreedy('show tcp', 'Display TCP connections', () =>
      showTcpBrief());
    trie.registerGreedy('show sockets', 'Display open sockets', () =>
      showSockets());
    trie.registerGreedy('show stacks', 'Display process stacks', () =>
      showStacks());
    trie.registerGreedy('show reload', 'Display reload schedule', () =>
      showReload());
    trie.registerGreedy('show aaa', 'Display AAA state', (a) =>
      showAaa(a.join(' ')));
    trie.register('show aliases', 'Display command aliases', () =>
      this.aliases.render());
  }

  /** Map a CLI alias mode keyword to the repository's AliasMode. */
  private aliasMode(token: string): AliasMode {
    switch (token) {
      case 'configure': return 'configure';
      case 'interface': return 'interface';
      case 'router': return 'router';
      default: return 'exec';
    }
  }

  private registerCommonUserCommands(): void {
    this.userTrie.register('enable', 'Enter privileged EXEC mode', () => {
      this.mode = 'privileged';
      return '';
    });

    this.registerCommonShowCommands(this.userTrie);
    // ARP show commands (shared between router and switch)
    registerArpShowCommands(this.userTrie, () => this.d());
  }

  private registerCommonPrivilegedCommands(): void {
    this.privilegedTrie.register('enable', 'Enter privileged EXEC mode (already in)', () => '');

    this.privilegedTrie.register('configure terminal', 'Enter configuration mode', () => {
      this.mode = 'config';
      return 'Enter configuration commands, one per line.  End with CNTL/Z.';
    });

    this.privilegedTrie.register('disable', 'Return to user EXEC mode', () => {
      this.mode = 'user';
      return '';
    });

    this.privilegedTrie.register('copy running-config startup-config', 'Save configuration', () => {
      return this.onSave();
    });

    this.privilegedTrie.register('write memory', 'Save configuration', () => {
      return this.onSave();
    });

    this.registerCommonShowCommands(this.privilegedTrie);
    // ARP commands (shared between router and switch)
    registerArpShowCommands(this.privilegedTrie, () => this.d());
    registerArpPrivilegedCommands(this.privilegedTrie, () => this.d());
  }

  private registerCommonConfigCommands(): void {
    // `configure terminal` while already in config is an idempotent
    // no-op (re-issuing it must not error mid-sequence).
    this.configTrie.register('configure terminal', 'Already in global config', () => '');

    this.configTrie.registerGreedy('hostname', 'Set system hostname', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      this.d()._setHostnameInternal(args[0]);
      return '';
    });

    this.configTrie.register('no hostname', 'Reset hostname', () => '');

    // `alias <mode> <name> <command…>` — real, working aliases.
    this.configTrie.registerGreedy('alias', 'Create a command alias', (args) => {
      if (args.length < 3) return '% Incomplete command.';
      const [modeTok, name, ...rest] = args;
      this.aliases.set(this.aliasMode(modeTok), name, rest.join(' '));
      return '';
    });
    this.configTrie.registerGreedy('no alias', 'Remove a command alias', (args) => {
      if (args.length < 2) return '% Incomplete command.';
      this.aliases.remove(this.aliasMode(args[0]), args[1]);
      return '';
    });

    // Global feature toggles — mutate the real CiscoConfigState
    // Repository (shared switch + router, DRY). `show cdp`/`show lldp`
    // and `show running-config` project this real state.
    const flag = (feature: string, enableCmd: string, desc: string) => {
      this.configTrie.registerGreedy(enableCmd, desc, () => {
        this.configState.set(feature, true);
        return '';
      });
      this.configTrie.registerGreedy(`no ${enableCmd}`, `Disable ${desc}`, () => {
        this.configState.set(feature, false);
        return '';
      });
    };
    flag('cdp', 'cdp run', 'CDP');
    flag('lldp', 'lldp run', 'LLDP');
    flag('ip cef', 'ip cef', 'CEF');
    flag('ip http server', 'ip http server', 'HTTP server');
    flag('ip http secure-server', 'ip http secure-server', 'HTTPS server');
    flag('ip source-route', 'ip source-route', 'IP source-route');
    flag('ip domain-lookup', 'ip domain-lookup', 'DNS lookup');
    // `ip routing` / `ipv6 unicast-routing` enable forms are owned by
    // the router (CiscoOspfCommands, device-specific); only record the
    // negation here so it's recognised on both vendors without
    // shadowing that specific handler.
    this.configTrie.registerGreedy('no ip routing', 'Disable IP routing', () => {
      this.configState.set('ip routing', false);
      return '';
    });
    this.configTrie.registerGreedy('no ipv6 unicast-routing', 'Disable IPv6 routing', () => {
      this.configState.set('ipv6 unicast-routing', false);
      return '';
    });

    this.configTrie.registerGreedy('ip domain-name', 'Set domain name', () => '');
    this.configTrie.registerGreedy('ip domain', 'IP domain configuration', () => '');
    this.configTrie.registerGreedy('banner', 'Set a banner', () => '');
    this.configTrie.registerGreedy('logging', 'Logging configuration', () => '');
    this.configTrie.registerGreedy('ntp', 'NTP configuration', () => '');
    this.configTrie.registerGreedy('snmp-server', 'SNMP configuration', () => '');

    // Management commands missing on BOTH switch & router → shared here
    // (DRY). Recognised; the sim has no AAA/crypto datapath.
    this.configTrie.registerGreedy('aaa', 'AAA configuration', () => '');
    this.configTrie.registerGreedy('enable secret', 'Set enable secret', () => '');
    this.configTrie.registerGreedy('enable password', 'Set enable password', () => '');
    this.configTrie.registerGreedy('username', 'Configure a local user', () => '');
    this.configTrie.registerGreedy('crypto', 'Crypto configuration', () => '');
    this.configTrie.registerGreedy('service', 'Service configuration', () => '');
    this.configTrie.registerGreedy('no service', 'Disable a service', () => '');
    this.configTrie.registerGreedy('login', 'Login configuration', () => '');
    this.configTrie.registerGreedy('ip ssh', 'SSH server configuration', () => '');

    // `line {console|vty|aux} …` → shared config-line sub-mode.
    this.configTrie.registerGreedy('line', 'Enter line configuration', () => {
      this.mode = 'config-line';
      return '';
    });
    for (const kw of ['transport', 'login', 'password', 'exec-timeout',
      'logging', 'access-class', 'privilege', 'no', 'speed', 'stopbits',
      'session-timeout', 'history', 'length', 'width', 'authorization',
      'accounting', 'rotary', 'autocommand', 'motd-banner', 'exec']) {
      this.configLineTrie.registerGreedy(kw, `line ${kw}`, () => '');
    }

    // ARP config commands (shared between router and switch)
    registerArpConfigCommands(this.configTrie, () => this.d());
  }
}
