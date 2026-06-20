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
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import { runSshClient } from '../linux/network/LinuxSshClient';
import { findHostByAddress } from '../linux/network/HostLookup';
import type { Router } from '../Router';
import { getSecurityConfig } from './cisco/CiscoSecurityCommands';
import type { CiscoDevice } from './CiscoDevice';
import type { PromptMap } from './PromptBuilder';
import { buildPrompt } from './PromptBuilder';
import { CLIStateMachine, type ModeHierarchy } from './CLIStateMachine';
import { CISCO_ERRORS, parsePipeFilter, applyPipeFilter } from './cli-utils';
import { isValidIPv4 } from '../../core/ip';
import {
  registerArpShowCommands, registerArpPrivilegedCommands, registerArpConfigCommands,
} from './cisco/CiscoArpCommands';
import {
  showClock, showUsers, showInventory, showProcessesCpu,
  showMemoryStatistics, showFlash, showPrivilege,
  showCdp, showLldp, showSnmp, showSnmpCommunity, showSnmpHost,
  showSnmpGroup, showSnmpUser, showSnmpView, showSnmpEngineId,
  showNtpStatus, showNtpAssociations,
  showLine, showIpSsh, showSshSessions, showHosts, showVrf, showBoot,
  showRedundancy, showFileSystems, showCalendar, showTerminal,
  showProcessesMemory, showBuffers, showTcpBrief, showSockets,
  showStacks, showReload, showAaa, showEnvironment, showControllers,
  type ShowStateDevice,
} from './cisco/CiscoCommonShow';
import { CiscoConfigState } from '../inspection/config/CiscoConfigState';
import { AliasRepository, type AliasMode } from '../inspection/config/AliasRepository';
import { LoggingConfig } from '../inspection/config/LoggingConfig';
import { isPathReachable } from '../linux/network/HostLookup';
import { OutgoingSessionRegistry, renderSessions } from './OutgoingSessionRegistry';

const PRIVILEGED_ONLY_SHOW: ReadonlySet<string> = new Set([
  'running-config', 'startup-config', 'tech-support', 'archive',
]);

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

  /** Config-driven syslog/logging state, projected by `show logging`. */
  protected readonly logging = new LoggingConfig();
  protected readonly outgoingSessions = new OutgoingSessionRegistry();
  private reloadTimer: TimerHandle | null = null;
  private scheduledReloadAtMs: number | null = null;

  private schedulerFor(device: TDevice): IScheduler {
    const dev = device as unknown as { getScheduler?: () => IScheduler };
    return dev.getScheduler?.() ?? getDefaultScheduler();
  }

  private armReloadTimer(ms: number): void {
    const device = this.d();
    const scheduler = this.schedulerFor(device);
    if (this.reloadTimer !== null) scheduler.clear(this.reloadTimer);
    this.scheduledReloadAtMs = Date.now() + ms;
    this.reloadTimer = scheduler.setTimeout(() => {
      this.reloadTimer = null;
      this.scheduledReloadAtMs = null;
      this.performScheduledReload(device);
    }, ms);
  }

  protected getScheduledReloadMs(): number | null {
    return this.scheduledReloadAtMs;
  }

  protected performImmediateReload(): string {
    this.d().powerOff();
    this.d().powerOn();
    this.mode = 'user';
    this.terminalMonitor = false;
    this.debugConsole.length = 0;
    (this.d() as unknown as { getDebugService?: () => { disableAll?: () => void } }).getDebugService?.().disableAll?.();
    return 'Proceed with reload? [confirm]\nReload requested.\nSystem restarting...';
  }

  protected performScheduledReload(device: TDevice): void {
    device.powerOff();
    device.powerOn();
    this.mode = 'user';
    this.terminalMonitor = false;
    this.debugConsole.length = 0;
    (device as unknown as { getDebugService?: () => { disableAll?: () => void } }).getDebugService?.().disableAll?.();
  }

  protected attachLoggingToDevice(device: TDevice): void {
    (device as unknown as { _loggingConfig?: LoggingConfig })._loggingConfig = this.logging;
  }

  attachLoggingToBus(bus: import('@/events/EventBus').IEventBus, deviceId: string): void {
    this.logging.attachToBus(bus, deviceId);
  }

  /** Async escape hatch: commands that return a Promise (e.g. ping on routers) */
  protected _pendingAsync: Promise<string> | null = null;

  /**
   * Per-vty pager / display preferences. Real Cisco IOS stores these on
   * the line, not on the device: each vty (and the console) has its own
   * `terminal length` (24 default) and `terminal width` (80 default).
   * `terminal length 0` disables the pager for the current session.
   *
   * These fields exist on the shared shell so `terminal length N` has a
   * real handler, but they rotate per-session via snapshotVtyState /
   * applyVtyState. See terminal_gap.md §5.3/§5.4.
   */
  protected terminalLength: number = 24;
  protected terminalWidth: number = 80;
  protected terminalHistorySize: number = 20;
  protected terminalMonitor = false;
  protected readonly debugConsole: string[] = [];
  private debugSourceAttached = false;

  protected attachDebugSource(src?: { subscribe(listener: (line: string) => void): () => void } | null): void {
    if (this.debugSourceAttached || !src) return;
    this.debugSourceAttached = true;
    src.subscribe((line) => {
      if (!this.terminalMonitor) return;
      this.debugConsole.push(line);
      if (this.debugConsole.length > 500) this.debugConsole.shift();
    });
  }

  protected drainDebugConsole(): string {
    if (this.debugConsole.length === 0) return '';
    const out = this.debugConsole.join('\n');
    this.debugConsole.length = 0;
    return out;
  }

  // ─── FSM ─────────────────────────────────────────────────────────
  protected abstract readonly fsm: CLIStateMachine;

  // ─── Command Tries (common modes) ───────────────────────────────
  protected userTrie = new CommandTrie();
  protected privilegedTrie = new CommandTrie();
  protected configTrie = new CommandTrie();
  protected configIfTrie = new CommandTrie();
  /** Shared `line …` sub-mode trie (switch + router). */
  protected configLineTrie = new CommandTrie();
  /** Currently-selected VTY range under `line vty <first> [last]`. */
  protected selectedVtyRange: { first: number; last: number } | null = null;

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

  protected getChassisProfile(): import('./cisco/CiscoCommonShow').CiscoChassisProfile {
    return 'switch-c2960';
  }

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

  /** Hand the device's CDP agent (if any) to `fn`. No-op on non-Cisco. */
  protected applyToCdpAgent(fn: (a: import('@/network/cdp/CdpAgent').CdpAgent) => void): void {
    const agent = (this.d() as unknown as { getCdpAgent?: () => import('@/network/cdp/CdpAgent').CdpAgent }).getCdpAgent?.();
    if (agent) fn(agent);
  }

  protected syncSyslogAgent(): void {
    const agent = (this.d() as unknown as {
      getSyslogAgent?: () => import('@/network/syslog/SyslogAgent').SyslogAgent;
    }).getSyslogAgent?.();
    if (!agent) return;
    const c = this.logging;
    agent.setEnabled(c.enabled);
    type Sev = 'emergency' | 'alert' | 'critical' | 'error' | 'warning' | 'notification' | 'informational' | 'debugging';
    const mapSev = (s: string): Sev => {
      const m: Record<string, Sev> = {
        emergencies: 'emergency', alerts: 'alert', critical: 'critical', errors: 'error',
        warnings: 'warning', notifications: 'notification',
        informational: 'informational', debugging: 'debugging',
      };
      return m[s] ?? 'informational';
    };
    const fac = c.facility as 'local0' | 'local1' | 'local2' | 'local3' | 'local4' | 'local5' | 'local6' | 'local7'
      | 'kern' | 'user' | 'mail' | 'daemon' | 'auth' | 'syslog' | 'lpr' | 'news' | 'uucp' | 'cron' | 'authpriv' | 'ftp';
    agent.setDefaultFacility(fac);
    agent.setDefaultSeverityThreshold(mapSev(c.trapSeverity));
    agent.setSourceInterface(c.sourceInterface);
    const desired = new Set(c.hosts);
    for (const s of agent.listServers()) {
      if (!desired.has(s.ip)) agent.removeServer(s.ip);
    }
    for (const h of c.hosts) {
      agent.addServer(h, { facility: fac, severityThreshold: mapSev(c.trapSeverity) });
    }
  }

  protected syncSnmpAgent(): void {
    const dev = this.d() as unknown as {
      getSnmpAgent?: () => import('@/network/snmp/SnmpAgent').SnmpAgent;
      getSnmpService?: () => import('./router/management/SnmpService').SnmpService;
    };
    const agent = dev.getSnmpAgent?.();
    const svc = dev.getSnmpService?.();
    if (!agent || !svc) return;
    agent.setContact(svc.getContact());
    agent.setLocation(svc.getLocation());
    const cfg = agent.getConfig();
    const desiredCommunities = svc.getCommunities();
    const desiredNames = new Set(desiredCommunities.map((c) => c.name));
    for (const c of cfg.communities) {
      if (!desiredNames.has(c.community)) agent.removeCommunity(c.community);
    }
    for (const c of desiredCommunities) agent.addCommunity(c.name, c.access);
    const desiredHosts = svc.getHosts();
    const desiredIps = new Set(desiredHosts.map((h) => h.host));
    for (const h of cfg.trapHosts) {
      if (!desiredIps.has(h.ip)) agent.removeTrapHost(h.ip);
    }
    for (const h of desiredHosts) agent.addTrapHost(h.host, h.community, h.udpPort);
  }

  protected applyToLldpAgent(fn: (a: import('@/network/lldp/LldpAgent').LldpAgent) => void): void {
    const agent = (this.d() as unknown as { getLldpAgent?: () => import('@/network/lldp/LldpAgent').LldpAgent }).getLldpAgent?.();
    if (agent) fn(agent);
  }

  /**
   * Resolve the per-interface scope selected in `config-if`. The base
   * implementation returns the single `selectedInterface`; switch shells
   * override to spread a range / a multi-port `interface range`.
   */
  protected selectedPortsForConfigIf(): string[] {
    const dev = this as unknown as { getSelectedInterface?: () => string | null; getSelectedInterfaceRange?: () => string[] };
    const range = dev.getSelectedInterfaceRange?.();
    if (range && range.length > 0) return range;
    const single = dev.getSelectedInterface?.();
    return single ? [single] : [];
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
    this.privilegedTrie.importMissingFrom(this.userTrie);
    this.privilegedTrie.copySubtreeChildrenInto('show', this.userTrie, PRIVILEGED_ONLY_SHOW);
    this.applyCanonicalDescriptions();
  }

  /**
   * Top-level keywords that only ever exist as a prefix of longer commands
   * (e.g. `show ...`, `configure terminal`) keep the placeholder description
   * equal to their keyword. These canonical descriptions give the ? help a
   * proper line for them, shared by every Cisco device.
   */
  protected applyCanonicalDescriptions(): void {
    const exec: Array<[string, string]> = [
      ['configure', 'Enter configuration mode'],
      ['show', 'Show running system information'],
      ['no', 'Negate a command or set its defaults'],
      ['clear', 'Reset functions'],
      ['erase', 'Erase persistent storage'],
      ['sntp', 'Configure SNTP'],
      ['copy', 'Copy from one file to another'],
      ['debug', 'Enable debugging functions'],
      ['undebug', 'Disable debugging functions'],
      ['write', 'Write running configuration to memory'],
      ['event', 'Embedded Event Manager'],
    ];
    for (const trie of [this.userTrie, this.privilegedTrie]) {
      for (const [k, d] of exec) trie.setCanonicalDescription(k, d);
    }
    const config: Array<[string, string]> = [
      ['configure', 'Enter configuration mode'],
      ['no', 'Negate a command or set its defaults'],
      ['show', 'Show running system information'],
      ['sntp', 'Configure SNTP'],
      ['cdp', 'CDP global configuration'],
      ['lldp', 'LLDP global configuration'],
      ['ip', 'Global IP configuration subcommands'],
      ['ipv6', 'Global IPv6 configuration subcommands'],
      ['mac', 'MAC address table configuration'],
      ['errdisable', 'Error-disable recovery configuration'],
      ['vtp', 'VTP configuration'],
      ['enable', 'Modify enable password parameters'],
      ['router', 'Enable a routing protocol'],
      ['key', 'Key management'],
      ['security', 'Security configuration'],
      ['event', 'Embedded Event Manager'],
      ['flow', 'Flow monitoring configuration'],
      ['parameter-map', 'Parameter map configuration'],
      ['zone', 'Security zone'],
      ['zone-pair', 'Security zone-pair'],
    ];
    for (const [k, d] of config) this.configTrie.setCanonicalDescription(k, d);
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
    const firstWord = cmdPart.split(/\s+/)[0];
    if (/[A-Z]/.test(firstWord) && (firstWord.toLowerCase() === 'debug' || firstWord.toLowerCase() === 'undebug')) {
      return CISCO_ERRORS.INVALID_INPUT;
    }
    if (lower === 'exit' || lower === 'exi' || lower === 'ex') return this.cmdExit();
    if (lower === 'end' || cmdPart === '\x03') return this.cmdEnd();
    if (lower === 'logout' && (this.mode === 'user' || this.mode === 'privileged')) return 'Connection closed.';
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

    if (this.isConfigMode() && lower.startsWith('show ')) {
      const savedMode = this.mode;
      this.mode = 'privileged';
      const output = this.executeOnTrie(cmdPart);
      this.mode = savedMode;
      this.deviceRef = null;
      return applyPipeFilter(output, pipeFilter);
    }

    if (this.isAclSubMode() && /^\d/.test(cmdPart)) {
      const output = this.executeOnTrie('sequence ' + cmdPart);
      this.deviceRef = null;
      return applyPipeFilter(output, pipeFilter);
    }

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
    if (this.mode === 'user') { this.terminalMonitor = false; return 'Connection closed.'; }
    if (this.mode === 'privileged') this.terminalMonitor = false;
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

  protected isAclSubMode(): boolean {
    return this.mode === 'config-std-nacl'
      || this.mode === 'config-ext-nacl'
      || this.mode === 'config-ipv6-nacl';
  }

  private static readonly IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;

  private static readonly MONTH_MAP: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };

  protected parseClockSetArgs(args: string[]): number | null {
    if (args.length < 5) return null;
    const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(args[0]);
    if (!hm) return null;
    const day = parseInt(args[1], 10);
    const month = CiscoShellBase.MONTH_MAP[args[2]?.toLowerCase()];
    const year = parseInt(args[3], 10);
    if (isNaN(day) || !month || isNaN(year)) return null;
    const date = new Date(Date.UTC(year, month - 1, day,
      parseInt(hm[1], 10), parseInt(hm[2], 10), hm[3] ? parseInt(hm[3], 10) : 0));
    return date.getTime();
  }

  protected resolveNtpTarget(target: string): string | null {
    if (CiscoShellBase.IPV4_RE.test(target)) return target;
    const dev = this.d() as unknown as { _getHostsTable?: () => { resolve?: (n: string) => string | null } };
    const fromHosts = dev._getHostsTable?.().resolve?.(target);
    if (fromHosts && CiscoShellBase.IPV4_RE.test(fromHosts)) return fromHosts;
    return null;
  }

  protected parseNtpKeyId(args: string[]): number | undefined {
    const idx = args.indexOf('key');
    if (idx < 0 || !args[idx + 1] || !/^\d+$/.test(args[idx + 1])) return undefined;
    return parseInt(args[idx + 1], 10);
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
    trie.register('show clock', 'Display the system clock', () => showClock(this.cs()));
    trie.register('show users', 'Display active lines', () => showUsers());
    trie.register('show sessions', 'Display open outgoing connections', () => renderSessions(this.outgoingSessions));
    trie.register('where', 'List open outgoing connections', () => renderSessions(this.outgoingSessions));
    trie.registerGreedy('disconnect', 'Close an outgoing connection', (args) => {
      if (!args[0]) {
        const last = this.outgoingSessions.list().slice(-1)[0];
        if (!last) return '% No connections open';
        this.outgoingSessions.close(last.conn);
        return '';
      }
      const n = parseInt(args[0], 10);
      if (Number.isNaN(n) || !this.outgoingSessions.get(n)) return '% No information for this connection';
      const target = this.outgoingSessions.get(n)!;
      this.outgoingSessions.close(n);
      return `Closing connection to ${target.host} [confirm]`;
    });
    trie.registerGreedy('resume', 'Resume an outgoing connection', (args) => {
      const list = this.outgoingSessions.list();
      const n = args[0] ? parseInt(args[0], 10) : (list.slice(-1)[0]?.conn ?? NaN);
      const s = this.outgoingSessions.get(n);
      if (!s) return '% No connection open';
      this.outgoingSessions.touch(n);
      return `[Resuming connection ${n} to ${s.host} ... ]`;
    });
    trie.register('show inventory', 'Display hardware inventory', () =>
      showInventory(this.d().getHostname(), this.getChassisProfile()));
    trie.register('show processes', 'Display active processes', () =>
      showProcessesCpu());
    trie.register('show processes cpu', 'Display CPU utilisation', () =>
      showProcessesCpu());
    trie.registerGreedy('show processes cpu sorted', 'Display CPU utilisation sorted', () =>
      showProcessesCpu());
    trie.registerGreedy('show processes cpu history', 'Display CPU history', () =>
      showProcessesCpu());
    trie.register('show clock detail', 'Display clock with source', () => {
      const dev = this.cs() as unknown as { getNtpAgent?: () => { isSynced: () => boolean; getConfig: () => { sourceInterface: string; refIdentifier: string } } };
      const ntp = dev.getNtpAgent?.();
      const synced = ntp?.isSynced() ?? false;
      const source = synced ? `NTP (${ntp?.getConfig().refIdentifier})` : 'No time source';
      return [
        showClock(this.cs()),
        `Time source is ${source}`,
      ].join('\n');
    });
    trie.registerGreedy('show memory', 'Display memory statistics', () =>
      showMemoryStatistics(this.getChassisProfile()));
    trie.registerGreedy('show flash:', 'Display flash filesystem', () => showFlash(this.getChassisProfile()));
    trie.register('show platform', 'Display platform information', () => {
      const profile = this.getChassisProfile();
      return profile === 'router-isr2911'
        ? 'Cisco ISR 2911\n  PID: CISCO2911/K9\n  S/N: FTX1234567A'
        : 'Cisco Catalyst 2960\n  PID: WS-C2960-24TT-L\n  S/N: FOC1234X56Y';
    });
    trie.register('show license', 'Display licenses', () => 'Index Feature                  Period left    Period Used    License Type    License State    License Count    License Priority\n1     ipbasek9                 Lifetime       0              Permanent       Active, In Use   N/A              Medium');
    trie.register('show license udi', 'Display Unique Device Identifier', () => {
      const hostname = this.d().getHostname();
      const profile = this.getChassisProfile();
      const sn = profile === 'router-isr2911' ? 'FTX1234567A' : 'FOC1234X56Y';
      const pid = profile === 'router-isr2911' ? 'CISCO2911/K9' : 'WS-C2960-24TT-L';
      return `Device# PID                   SN                              UDI\n*0    ${pid}      ${sn}                  ${pid}:${sn}\n  (hostname: ${hostname})`;
    });
    trie.register('show diag', 'Display chassis diagnostics', () => 'Slot 0:  Built-in PID (real)\n  Power: OK\n  Temperature: nominal');
    trie.register('show idprom backplane', 'Display IDPROM backplane', () => 'IDPROM for backplane: serial number, PID match show inventory');
    trie.register('show mac address-table', 'Display MAC address table', () => {
      const dev = this.d() as unknown as { getMacTable?: () => Map<string, { mac: string; ifName: string; vlan?: number; type?: string }> };
      const table = dev.getMacTable?.();
      if (!table || table.size === 0) return 'Mac Address Table\n--------------------------------\nNo entries';
      const lines = ['Mac Address Table', '--------------------------------', 'Vlan    Mac Address       Type        Ports'];
      for (const e of table.values()) lines.push(`${String(e.vlan ?? 1).padEnd(8)}${e.mac.padEnd(18)}${(e.type ?? 'DYNAMIC').padEnd(12)}${e.ifName}`);
      return lines.join('\n');
    });
    trie.registerGreedy('show running-config all', 'Show running-config with defaults', () => {
      const dev = this.d() as unknown as { _getRunningConfigText?: () => string };
      const cfg = dev._getRunningConfigText?.() ?? '';
      return cfg.length > 0 ? `Building configuration...\n${cfg}\nend` : 'Building configuration...';
    });
    trie.register('show privilege', 'Display current privilege level', () =>
      showPrivilege(this.mode === 'user' ? 1 : 15));
    trie.register('show history', 'Display command history', () =>
      this.cmdHistory.slice(-20).join('\n'));
    trie.registerGreedy('terminal', 'Set terminal parameters', (args) =>
      this.handleTerminalCommand(args));

    // NOTE: `copy` is a privileged-EXEC command — it is registered once, with
    // full file-system semantics, in registerPrivilegedExtras (the rich
    // handler). Registering a simple stub here too (this method runs for both
    // the user and privileged tries) used to shadow it AND leak `copy` into
    // user EXEC; that has been removed.

    // Generic device-info show family — missing on BOTH the Cisco
    // router and switch, so it lives here in the shared base (DRY).
    trie.register('show ntp status', 'Display NTP status', () => showNtpStatus(this.cs()));
    trie.registerGreedy('show ntp', 'Display NTP associations', () =>
      showNtpAssociations(this.cs()));
    trie.registerGreedy('show cdp', 'Display CDP information', (a) =>
      showCdp(this.cs(), a.join(' '), this.configState.isEnabled('cdp')));
    trie.registerGreedy('show lldp', 'Display LLDP information', (a) =>
      showLldp(this.cs(), a.join(' '), this.configState.isEnabled('lldp')));
    trie.register('show snmp community', 'Display SNMP communities', () => showSnmpCommunity(this.cs()));
    trie.register('show snmp host', 'Display SNMP hosts', () => showSnmpHost(this.cs()));
    trie.register('show snmp group', 'Display SNMP groups', () => showSnmpGroup(this.cs()));
    trie.register('show snmp user', 'Display SNMP users', () => showSnmpUser(this.cs()));
    trie.register('show snmp view', 'Display SNMP views', () => showSnmpView(this.cs()));
    trie.register('show snmp engineID', 'Display SNMP engine ID', () => showSnmpEngineId(this.cs()));
    trie.registerGreedy('show snmp', 'Display SNMP status', () => showSnmp(this.cs()));
    trie.registerGreedy('show controllers', 'Display controller status', (a) =>
      showControllers(this.cs(), a.join(' ')));
    trie.registerGreedy('show environment', 'Display environment', () =>
      showEnvironment());
    trie.registerGreedy('show line', 'Display TTY lines', () =>
      showLine(this.cs()));
    trie.register('show ip ssh', 'Display SSH server status', () => showIpSsh());
    trie.register('show ip ssh known-hosts', 'Display learned SSH host keys', () => {
      const dev = this.d() as unknown as { _getSshKnownHosts?: () => { renderCisco: () => string } };
      return dev._getSshKnownHosts?.().renderCisco() ?? '';
    });
    trie.registerGreedy('show ssh', 'Display SSH sessions', () =>
      showSshSessions());
    trie.registerGreedy('show hosts', 'Display host cache', () => showHosts(this.d() as unknown as Parameters<typeof showHosts>[0]));
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
      `${showTerminal(this.terminalLength, this.terminalWidth, this.terminalHistorySize)}\n`
      + `Monitor parameter: ${this.terminalMonitor ? 'enabled' : 'disabled'}`);
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
      showReload(this.getScheduledReloadMs()));
    trie.registerGreedy('show aaa', 'Display AAA state', (a) => {
      const dev = this.d() as unknown as Router;
      return showAaa(getSecurityConfig(dev), a.join(' '));
    });
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

  /**
   * Handle `terminal length <n>` / `terminal width <n>` / `terminal no length`
   * (Cisco IOS exec preference, per-session).
   *
   * Recognised forms:
   *   terminal length <0-512>   — set pager rows (0 = pager off)
   *   terminal no length        — restore default (24)
   *   terminal width <0-512>    — set column hint
   *   terminal no width         — restore default (80)
   *   terminal history size <n> — display-history ring length (no-op stored)
   *   terminal monitor          — accept silently (logging redirect to vty)
   *   terminal no monitor       — accept silently
   *
   * Returns CISCO_ERRORS.INVALID_INPUT on unknown sub-commands so an
   * operator typo doesn't look like a silent success.
   */
  protected handleTerminalCommand(args: string[]): string {
    if (args.length === 0) {
      return CISCO_ERRORS.INCOMPLETE;
    }
    const head = args[0].toLowerCase();
    const rest = args.slice(1);

    if (head === 'length') {
      if (rest.length === 0) return CISCO_ERRORS.INCOMPLETE;
      const n = parseInt(rest[0], 10);
      if (!Number.isFinite(n) || n < 0 || n > 512) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      this.terminalLength = n;
      return '';
    }
    if (head === 'width') {
      if (rest.length === 0) return CISCO_ERRORS.INCOMPLETE;
      const n = parseInt(rest[0], 10);
      if (!Number.isFinite(n) || n < 0 || n > 512) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      this.terminalWidth = n;
      return '';
    }
    if (head === 'no') {
      const sub = (rest[0] ?? '').toLowerCase();
      if (sub === 'length') { this.terminalLength = 24; return ''; }
      if (sub === 'width')  { this.terminalWidth  = 80; return ''; }
      if (sub === 'monitor' || (sub.length >= 3 && 'monitor'.startsWith(sub))) { this.terminalMonitor = false; return ''; }
      return CISCO_ERRORS.INVALID_INPUT;
    }
    if (head === 'monitor' || (head.length >= 3 && 'monitor'.startsWith(head))) { this.terminalMonitor = true; return ''; }
    if (head === 'exec') return '';
    if (head === 'history') {
      if ((rest[0] ?? '').toLowerCase() === 'size') {
        const n = parseInt(rest[1] ?? '', 10);
        if (!Number.isFinite(n) || n < 0 || n > 256) return CISCO_ERRORS.INVALID_INPUT;
        this.terminalHistorySize = n;
        return '';
      }
      if (rest.length === 0) { this.terminalHistorySize = 20; return ''; }
      return '';
    }
    if (head === 'monitor') {
      // `terminal monitor` — redirect logging to this vty. Acknowledged
      // silently; the simulator does not gate logs by line.
      return '';
    }
    return CISCO_ERRORS.INVALID_INPUT;
  }

  /** Public read accessor — used by CLITerminalSession to size the pager. */
  getTerminalLength(): number { return this.terminalLength; }
  /** Public read accessor — symmetric with getTerminalLength. */
  getTerminalWidth(): number { return this.terminalWidth; }

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

    const saveRunningToStartup = () =>
      `Destination filename [startup-config]?\n${this.onSave()}`;

    this.privilegedTrie.register('write memory', 'Save configuration', () => this.onSave());

    const eraseNvram = () => {
      (this.d() as unknown as { _eraseStartupConfig?: () => void })._eraseStartupConfig?.();
      return 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]\n[OK]\nErase of nvram: complete';
    };
    this.privilegedTrie.register('write erase', 'Erase saved configuration', eraseNvram);
    this.privilegedTrie.register('erase startup-config', 'Erase saved configuration', eraseNvram);
    this.privilegedTrie.register('erase nvram:', 'Erase NVRAM', eraseNvram);

    // Single greedy `copy` handler so any source/destination pair is consumed
    // as arguments (an exact `copy running-config startup-config` registration
    // would create an intermediate node that hides other destinations from the
    // greedy match). IOS keyword abbreviations (`copy run start`) are expanded.
    const norm = (a: string): string => {
      const t = a.toLowerCase();
      if (t && 'running-config'.startsWith(t)) return 'running-config';
      if (t && 'startup-config'.startsWith(t)) return 'startup-config';
      return t;
    };
    this.privilegedTrie.registerGreedy('copy', 'Copy a file', (args) => {
      if (!args[0] || !args[1]) return '% Incomplete command.';
      const src = norm(args[0]);
      const dst = norm(args[1]);
      const dev = this.d() as unknown as {
        _restoreStartupConfig?: () => boolean;
        _readFlashFile?: (name: string) => string | null;
        _writeFlashFile?: (name: string, content: string) => void;
        _applyConfigText?: (text: string) => void;
        getRunningConfig?: () => string;
      };

      if (src === 'running-config' && dst === 'startup-config') return saveRunningToStartup();

      if (dst === 'running-config' && (src === 'startup-config' || src === 'nvram:')) {
        // Devices that model NVRAM (the switch) report an empty NVRAM; the
        // router keeps its shell-level snapshot, so preserve the OK path.
        if (typeof dev._restoreStartupConfig === 'function' && !dev._restoreStartupConfig()) {
          return '%% Non-volatile configuration memory is not present';
        }
        return 'Destination filename [running-config]?\n[OK]';
      }

      const fileSrc = src.startsWith('flash:') || src.startsWith('tftp:') || src.startsWith('ftp:');
      const fileDst = dst.startsWith('flash:') || dst.startsWith('tftp:') || dst.startsWith('ftp:') || dst.startsWith('nvram:');

      if (dst === 'running-config' && fileSrc) {
        if (typeof dev._readFlashFile === 'function') {
          const content = dev._readFlashFile(args[0]);
          if (content == null) return `%Error opening ${args[0]} (No such file or directory)`;
          dev._applyConfigText?.(content);
        }
        return 'Destination filename [running-config]?\n[OK]';
      }

      if (src === 'running-config' && fileDst) {
        dev._writeFlashFile?.(args[1], dev.getRunningConfig?.() ?? '');
        return `Destination filename [${args[1]}]?\nWriting ${args[1]} ... [OK]`;
      }

      return `[OK]`;
    });
    this.privilegedTrie.registerGreedy('reload', 'Reload the device', (args) => {
      if (args[0]?.toLowerCase() === 'cancel') {
        if (this.reloadTimer !== null) { this.schedulerFor(this.d()).clear(this.reloadTimer); this.reloadTimer = null; }
        this.scheduledReloadAtMs = null;
        return 'Reload cancelled.';
      }
      if (args[0]?.toLowerCase() === 'in') {
        if (!args[1]) return '% Incomplete command.';
        if (!/^\d+$/.test(args[1])) return "% Invalid input detected at '^' marker.";
        const min = parseInt(args[1], 10);
        this.armReloadTimer(min * 60_000);
        return `Reload scheduled in ${min} minute${min === 1 ? '' : 's'}`;
      }
      if (args[0]?.toLowerCase() === 'at') {
        if (!args[1]) return '% Incomplete command.';
        return `Reload scheduled for ${args[1]}`;
      }
      return this.performImmediateReload();
    });
    this.privilegedTrie.register('debug arp', 'Enable ARP debug', () => {
      const svc = (this.d() as unknown as { getDebugService?: () => { enable: (c: string) => string } }).getDebugService?.();
      return svc ? svc.enable('ip.arp') : 'ARP packet debugging is on';
    });
    this.privilegedTrie.register('no debug arp', 'Disable ARP debug', () => {
      const svc = (this.d() as unknown as { getDebugService?: () => { disable: (c: string) => string } }).getDebugService?.();
      return svc ? svc.disable('ip.arp') : 'ARP packet debugging is off';
    });
    this.privilegedTrie.registerGreedy('debug ip', 'Enable IP debug', (args) => {
      const sub = args.join(' ').toLowerCase();
      const dev = this.d() as unknown as { getDebugService?: () => { enable: (c: 'ip.icmp' | 'ip.packet' | 'ip.tcp' | 'ip.udp' | 'ip.nat' | 'ip.arp' | 'ip.routing' | 'ip.dhcp.server' | 'ip.ssh' | 'ip.rip' | 'ip.eigrp' | 'ip.bgp' | 'ip.nhrp') => string } };
      const svc = dev.getDebugService?.();
      if (!svc) return 'IP debugging is on';
      if (sub === 'packet') return svc.enable('ip.packet');
      if (sub === 'icmp') return svc.enable('ip.icmp');
      if (sub === 'tcp') return svc.enable('ip.tcp');
      if (sub === 'udp') return svc.enable('ip.udp');
      if (sub === 'nat') return svc.enable('ip.nat');
      if (sub === 'arp') return svc.enable('ip.arp');
      if (sub === 'routing') return svc.enable('ip.routing');
      if (sub === 'dhcp server' || sub === 'dhcp server events') return svc.enable('ip.dhcp.server');
      if (sub === 'ssh') return svc.enable('ip.ssh');
      if (sub === 'rip') return svc.enable('ip.rip');
      if (sub === 'eigrp') return svc.enable('ip.eigrp');
      if (sub === 'bgp') return svc.enable('ip.bgp');
      if (sub === 'nhrp') return svc.enable('ip.nhrp');
      return svc.enable('ip.packet', sub);
    });
    this.privilegedTrie.registerGreedy('no debug ip', 'Disable IP debug', (args) => {
      const sub = args.join(' ').toLowerCase();
      const dev = this.d() as unknown as { getDebugService?: () => { disable: (c: 'ip.icmp' | 'ip.packet' | 'ip.tcp' | 'ip.udp' | 'ip.nat' | 'ip.arp' | 'ip.routing' | 'ip.dhcp.server' | 'ip.ssh' | 'ip.rip' | 'ip.eigrp' | 'ip.bgp' | 'ip.nhrp') => string } };
      const svc = dev.getDebugService?.();
      if (!svc) return 'IP debugging is off';
      if (sub === 'packet') return svc.disable('ip.packet');
      if (sub === 'icmp') return svc.disable('ip.icmp');
      if (sub === 'tcp') return svc.disable('ip.tcp');
      if (sub === 'udp') return svc.disable('ip.udp');
      if (sub === 'nat') return svc.disable('ip.nat');
      if (sub === 'arp') return svc.disable('ip.arp');
      if (sub === 'routing') return svc.disable('ip.routing');
      if (sub === 'dhcp server' || sub === 'dhcp server events') return svc.disable('ip.dhcp.server');
      if (sub === 'ssh') return svc.disable('ip.ssh');
      if (sub === 'rip') return svc.disable('ip.rip');
      if (sub === 'eigrp') return svc.disable('ip.eigrp');
      if (sub === 'bgp') return svc.disable('ip.bgp');
      if (sub === 'nhrp') return svc.disable('ip.nhrp');
      return svc.disable('ip.packet');
    });
    const debugSvc = () => {
      const dev = this.d() as unknown as { getDebugService?: () => { enable: (c: 'standby' | 'ip.eigrp' | 'ip.bgp') => string; disable: (c: 'standby' | 'ip.eigrp' | 'ip.bgp') => string } };
      return dev.getDebugService?.();
    };
    this.privilegedTrie.registerGreedy('debug standby', 'Debug HSRP', (_args) =>
      debugSvc()?.enable('standby') ?? '');
    this.privilegedTrie.registerGreedy('debug eigrp', 'Debug EIGRP', (_args) =>
      debugSvc()?.enable('ip.eigrp') ?? '');
    this.privilegedTrie.registerGreedy('no debug standby', 'Disable HSRP debug', (_args) =>
      debugSvc()?.disable('standby') ?? '');
    this.privilegedTrie.registerGreedy('no debug eigrp', 'Disable EIGRP debug', (_args) =>
      debugSvc()?.disable('ip.eigrp') ?? '');
    const genericDebug = () => (this.d() as unknown as { getDebugService?: () => { enable(c: string): string; disable(c: string): string } }).getDebugService?.();
    this.privilegedTrie.registerGreedy('debug lldp', 'Debug LLDP', () => genericDebug()?.enable('lldp.packets') ?? 'LLDP packets debugging is on');
    this.privilegedTrie.registerGreedy('debug cdp', 'Debug CDP', () => genericDebug()?.enable('cdp.packets') ?? 'CDP packets debugging is on');
    this.privilegedTrie.registerGreedy('no debug lldp', 'Disable LLDP debug', () => genericDebug()?.disable('lldp.packets') ?? '');
    this.privilegedTrie.registerGreedy('no debug cdp', 'Disable CDP debug', () => genericDebug()?.disable('cdp.packets') ?? '');
    this.privilegedTrie.registerGreedy('clear ip bgp', 'Clear BGP sessions', (_args) => '');
    this.privilegedTrie.registerGreedy('clear logging', 'Clear the syslog buffer', () => {
      this.attachLoggingToDevice(this.d());
      (this.logging as unknown as { clearBuffer?: () => void }).clearBuffer?.();
      return '';
    });
    this.privilegedTrie.registerGreedy('clear counters', 'Clear interface counters', (args) => {
      const ports = this.d()._getPortsInternal();
      const target = args[0] && !/^\s*$/.test(args[0]) ? args.join(' ') : null;
      let count = 0;
      for (const [name, port] of ports) {
        if (target && name.toLowerCase() !== target.toLowerCase()) continue;
        (port as unknown as { resetCounters?: () => void }).resetCounters?.();
        count++;
      }
      return count === 0 ? '% No matching interface' : '';
    });
    this.privilegedTrie.registerGreedy('clear ip arp', 'Clear ARP cache', (args) => {
      const dev = this.d() as unknown as { _clearArpEntry?: (ip?: string) => number; arpTable?: Map<string, unknown> };
      if (args[0]) {
        const n = dev._clearArpEntry?.(args[0]) ?? 0;
        return n === 0 ? '% No matching ARP entry' : '';
      }
      dev.arpTable?.clear();
      return '';
    });
    this.privilegedTrie.registerGreedy('clear ip route', 'Clear routes (dynamic)', () => {
      const dev = this.d() as unknown as { _clearDynamicRoutes?: () => void };
      dev._clearDynamicRoutes?.();
      return '';
    });
    this.privilegedTrie.registerGreedy('sntp server', 'SNTP server (alias for ntp server)', (args) => {
      if (!args[0]) return '% Incomplete command.';
      const target = this.resolveNtpTarget(args[0]);
      if (!target) return `Translating "${args[0]}"...domain server (255.255.255.255)\n% Bad IP address or host name`;
      const agent = (this.d() as unknown as { getNtpAgent?: () => import('@/network/ntp/NtpAgent').NtpAgent }).getNtpAgent?.();
      agent?.addServer(target, args[1]?.toLowerCase() === 'prefer');
      return '';
    });
    this.configTrie.registerGreedy('sntp server', 'SNTP server (alias for ntp server)', (args) => {
      if (!args[0]) return '% Incomplete command.';
      const target = this.resolveNtpTarget(args[0]);
      if (!target) return `Translating "${args[0]}"...domain server (255.255.255.255)\n% Bad IP address or host name`;
      const agent = (this.d() as unknown as { getNtpAgent?: () => import('@/network/ntp/NtpAgent').NtpAgent }).getNtpAgent?.();
      agent?.addServer(target, args[1]?.toLowerCase() === 'prefer');
      return '';
    });

    this.registerCommonShowCommands(this.privilegedTrie);
    // ARP commands (shared between router and switch)
    registerArpShowCommands(this.privilegedTrie, () => this.d());
    registerArpPrivilegedCommands(this.privilegedTrie, () => this.d());
    this.privilegedTrie.registerGreedy('ssh', 'Open an SSH connection to a remote host', (args) => {
      return this.runOutboundSshClient(args);
    });
    this.userTrie.registerGreedy('ssh', 'Open an SSH connection to a remote host', (args) => {
      return this.runOutboundSshClient(args);
    });
    this.userTrie.registerGreedy('telnet', 'Open a Telnet session', (args) => this.runOutboundTelnet(args));
    this.privilegedTrie.registerGreedy('telnet', 'Open a Telnet session', (args) => this.runOutboundTelnet(args));
  }

  /**
   * Outbound Telnet driven by the real topology: resolve the target,
   * pick a source interface, and verify L2/L3 reachability. A session is
   * recorded only when a Telnet listener (network CLI device with telnet
   * transport) actually accepts the connection.
   */
  private runOutboundTelnet(args: string[]): string {
    const positional = args.filter((a) => !a.startsWith('-'));
    if (positional.length === 0) return '% Incomplete command.';
    const display = positional[0];
    const port = positional[1] ? parseInt(positional[1], 10) : 23;
    const router = this.d() as unknown as {
      _getPortsInternal: () => Map<string, { getIPAddress: () => { toString: () => string } | null; getIsUp: () => boolean }>;
      _getHostsTable?: () => { resolve: (n: string) => string | null };
    };
    let host = display;
    const resolved = router._getHostsTable?.().resolve(host);
    if (resolved) host = resolved;

    let sourceIp: string | null = null;
    for (const [, p] of router._getPortsInternal()) {
      const ip = p.getIPAddress();
      if (ip && p.getIsUp()) { sourceIp = ip.toString(); break; }
    }
    if (!sourceIp) return `Trying ${display} ...\n% Destination unreachable; no source interface for outbound Telnet`;

    const remote = findHostByAddress(host);
    if (!remote || remote.poweredOff || remote.interfaceDown) {
      return `Trying ${display} ...\n% Connection timed out; remote host not responding`;
    }
    if (!isPathReachable(sourceIp, remote.ip)) {
      return `Trying ${display} ...\n% Destination unreachable; gateway or route not found`;
    }
    if (!this.remoteAcceptsTelnet(remote.device, port)) {
      return `Trying ${display} ...\n% Connection refused by remote host`;
    }
    this.outgoingSessions.open({ host: display, address: remote.ip, protocol: 'telnet', user: '' });
    return `Trying ${display} ... Open\n`;
  }

  private remoteAcceptsTelnet(device: unknown, port: number): boolean {
    if (port !== 23) return false;
    const d = device as { getDeviceType?: () => string; constructor: { name: string } };
    const cls = d.constructor?.name ?? '';
    const type = (d.getDeviceType?.() ?? '').toLowerCase();
    const isNetworkCli =
      /Router|Switch/.test(cls) || /router|switch/.test(type);
    if (!isNetworkCli) return false;
    const transport = (device as { _getVtyTransportInput?: () => string })._getVtyTransportInput?.();
    if (transport === undefined) return true;
    return transport === 'telnet' || transport === 'all';
  }

  /**
   * Parse `ssh [-l user] [-p port] <host> [command ...]` (the IOS form)
   * and dispatch through the shared runSshClient. Source IP is the
   * router's first configured interface — runSshClient probes for it
   * automatically when sourceIp resolves to a known device.
   */
  private runOutboundSshClient(args: string[]): string {
    let user = 'admin';
    let port: string | null = null;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-l' && args[i + 1]) { user = args[++i]; continue; }
      if (a === '-p' && args[i + 1]) { port = args[++i]; continue; }
      if (a === '-v') continue;
      if (a.startsWith('-')) continue;
      rest.push(a);
    }
    if (rest.length === 0) return '% Incomplete command.';
    let host = rest[0];
    const cmd = rest.slice(1).join(' ');
    const router = this.d() as unknown as {
      _getPortsInternal: () => Map<string, { getIPAddress: () => { toString: () => string } | null; getIsUp: () => boolean }>;
      _getHostnameInternal: () => string;
      _getHostsTable?: () => { resolve: (n: string) => string | null };
    };
    // Resolve through the static `ip host` table before any DNS fallback.
    const resolved = router._getHostsTable?.().resolve(host);
    if (resolved) host = resolved;
    let sourceIp: string | null = null;
    for (const [, p] of router._getPortsInternal()) {
      const ip = p.getIPAddress();
      if (ip && p.getIsUp()) { sourceIp = ip.toString(); break; }
    }
    if (!sourceIp) return '% No usable interface IP for outbound SSH';
    const clientArgs: string[] = [];
    if (port) clientArgs.push('-p', port);
    clientArgs.push('-o', 'StrictHostKeyChecking=accept-new');
    // Cisco IOS' built-in ssh client always allocates a line-mode PTY on
    // the VTY — opposite of OpenSSH's exec-mode default.
    clientArgs.push('-t');
    clientArgs.push(`${user}@${host}`);
    if (cmd) clientArgs.push(cmd);
    const result = runSshClient({
      args: clientArgs,
      sourceHostname: router._getHostnameInternal(),
      sourceIp,
      sourceUser: user,
      localVfs: {
        readFile: () => null,
        writeFile: () => undefined,
      },
    });
    // TOFU: record the remote host key in this router's local
    // known-hosts table so `show ip ssh known-hosts` reflects it.
    if (result.exitCode === 0) {
      const dev = this.d() as unknown as {
        _getSshKnownHosts?: () => { add: (e: { host: string; keyType: string; publicKey: string }) => void };
      };
      const remoteHk = this.lookupRemoteSshHostKey(host);
      if (remoteHk) {
        dev._getSshKnownHosts?.().add({ host, ...remoteHk });
      }
      if (!cmd) {
        this.outgoingSessions.open({ host: rest[0], address: host, protocol: 'ssh', user });
      }
    }
    return result.output;
  }

  /** Read the remote machine's host key via the topology registry. */
  private lookupRemoteSshHostKey(host: string): { keyType: string; publicKey: string } | null {
    const found = findHostByAddress(host) as { device?: { getSshHostKey?: () => { type: string; publicKey: string } } } | null;
    const hk = found?.device?.getSshHostKey?.();
    return hk ? { keyType: hk.type, publicKey: hk.publicKey } : null;
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

    this.configTrie.register('no hostname', 'Reset hostname', () => {
      this.d()._setHostnameInternal('Router');
      return '';
    });

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
    // cdp/lldp follow the `flag` pattern, but the cdp toggle must also
    // start / stop the per-device protocol agent so `show cdp neighbors`
    // reflects real learnt state (and stops learning when disabled).
    this.configTrie.registerGreedy('cdp run', 'Enable CDP globally', () => {
      this.configState.set('cdp', true);
      this.applyToCdpAgent(a => a.setEnabled(true));
      return '';
    });
    this.configTrie.registerGreedy('no cdp run', 'Disable CDP globally', () => {
      this.configState.set('cdp', false);
      this.applyToCdpAgent(a => a.setEnabled(false));
      return '';
    });
    this.configTrie.registerGreedy('cdp timer', 'Advertisement period (sec)', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 5 || n > 254) return '% Invalid timer value (5-254)';
      this.applyToCdpAgent(a => a.setTimerSec(n));
      return '';
    });
    this.configTrie.registerGreedy('cdp holdtime', 'Hold-time advertised to peers (sec)', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 10 || n > 255) return '% Invalid holdtime value (10-255)';
      this.applyToCdpAgent(a => a.setHoldtimeSec(n));
      return '';
    });
    this.configTrie.register('cdp advertise-v2', 'Advertise CDPv2 PDUs', () => {
      this.applyToCdpAgent(a => (a as unknown as { setAdvertiseV2?: (v: boolean) => void }).setAdvertiseV2?.(true));
      return '';
    });
    this.configTrie.register('no cdp advertise-v2', 'Use CDPv1 PDUs', () => {
      this.applyToCdpAgent(a => (a as unknown as { setAdvertiseV2?: (v: boolean) => void }).setAdvertiseV2?.(false));
      return '';
    });
    this.configTrie.registerGreedy('lldp run', 'Enable LLDP globally', () => {
      this.configState.set('lldp', true);
      this.applyToLldpAgent(a => a.setEnabled(true));
      return '';
    });
    this.configTrie.registerGreedy('no lldp run', 'Disable LLDP globally', () => {
      this.configState.set('lldp', false);
      this.applyToLldpAgent(a => a.setEnabled(false));
      return '';
    });
    this.configTrie.registerGreedy('lldp timer', 'Advertisement period (sec)', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 5 || n > 32768) return '% Invalid timer value (5-32768)';
      this.applyToLldpAgent(a => a.setTimerSec(n));
      return '';
    });
    this.configTrie.registerGreedy('lldp holdtime-multiplier', 'TTL = timer x multiplier', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 2 || n > 10) return '% Invalid multiplier (2-10)';
      this.applyToLldpAgent(a => a.setHoldtimeMultiplier(n));
      return '';
    });
    this.configTrie.registerGreedy('lldp holdtime', 'Holdtime in seconds', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 10 || n > 3600) return '% Invalid holdtime value (10-3600)';
      this.applyToLldpAgent(a => {
        const cfg = a.getConfig();
        const mult = Math.max(2, Math.min(10, Math.round(n / cfg.timerSec)));
        a.setHoldtimeMultiplier(mult);
      });
      return '';
    });
    this.configTrie.registerGreedy('lldp reinit', 'Re-init delay (sec)', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 1 || n > 10) return '% Invalid reinit delay (1-10)';
      this.applyToLldpAgent(a => a.setReinitDelaySec(n));
      return '';
    });

    // [no] cdp enable — per-interface — needs `selectedInterface` /
    // `selectedInterfaceRange` from the device-specific shell, but the
    // applyToSelectedInterfaces helper is implemented per subclass.
    this.configIfTrie.register('cdp enable', 'Enable CDP on this interface', () => {
      const ports = this.selectedPortsForConfigIf();
      for (const p of ports) this.applyToCdpAgent(a => a.setPortEnabled(p, true));
      return '';
    });
    this.configIfTrie.register('no cdp enable', 'Disable CDP on this interface', () => {
      const ports = this.selectedPortsForConfigIf();
      for (const p of ports) this.applyToCdpAgent(a => a.setPortEnabled(p, false));
      return '';
    });
    this.configIfTrie.register('lldp transmit', 'Enable LLDP transmit on this interface', () => {
      const ports = this.selectedPortsForConfigIf();
      for (const p of ports) this.applyToLldpAgent(a => a.setPortTransmit(p, true));
      return '';
    });
    this.configIfTrie.register('no lldp transmit', 'Disable LLDP transmit on this interface', () => {
      const ports = this.selectedPortsForConfigIf();
      for (const p of ports) this.applyToLldpAgent(a => a.setPortTransmit(p, false));
      return '';
    });
    this.configIfTrie.register('lldp receive', 'Enable LLDP receive on this interface', () => {
      const ports = this.selectedPortsForConfigIf();
      for (const p of ports) this.applyToLldpAgent(a => a.setPortReceive(p, true));
      return '';
    });
    this.configIfTrie.register('no lldp receive', 'Disable LLDP receive on this interface', () => {
      const ports = this.selectedPortsForConfigIf();
      for (const p of ports) this.applyToLldpAgent(a => a.setPortReceive(p, false));
      return '';
    });
    flag('ip cef', 'ip cef', 'CEF');
    flag('ip http server', 'ip http server', 'HTTP server');
    flag('ip http secure-server', 'ip http secure-server', 'HTTPS server');
    flag('ip source-route', 'ip source-route', 'IP source-route');
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
    this.configTrie.registerGreedy('ip name-server', 'Configure DNS name servers', (args) => {
      if (args.length === 0) return CISCO_ERRORS.INCOMPLETE;
      for (const s of args) if (!isValidIPv4(s)) return CISCO_ERRORS.INVALID_INPUT;
      const dev = this.d() as unknown as { getManagementService?: () => import('./router/management/RouterManagementService').RouterManagementService };
      const mgmt = dev.getManagementService?.();
      if (mgmt) for (const s of args) if (!mgmt.nameServers.includes(s)) mgmt.nameServers.push(s);
      return '';
    });
    this.configTrie.registerGreedy('no ip name-server', 'Clear DNS name servers', (args) => {
      const dev = this.d() as unknown as { getManagementService?: () => import('./router/management/RouterManagementService').RouterManagementService };
      const mgmt = dev.getManagementService?.();
      if (mgmt) {
        if (args.length === 0) mgmt.nameServers.length = 0;
        else for (const s of args) {
          const i = mgmt.nameServers.indexOf(s);
          if (i >= 0) mgmt.nameServers.splice(i, 1);
        }
      }
      return '';
    });
    this.configTrie.register('ip domain-lookup', 'Enable DNS lookups', () => {
      const dev = this.d() as unknown as { getManagementService?: () => import('./router/management/RouterManagementService').RouterManagementService };
      const mgmt = dev.getManagementService?.();
      if (mgmt) mgmt.ipDomainLookupEnabled = true;
      return '';
    });
    this.configTrie.register('no ip domain-lookup', 'Disable DNS lookups', () => {
      const dev = this.d() as unknown as { getManagementService?: () => import('./router/management/RouterManagementService').RouterManagementService };
      const mgmt = dev.getManagementService?.();
      if (mgmt) mgmt.ipDomainLookupEnabled = false;
      return '';
    });
    this.configTrie.register('ip bootp server', 'Enable BOOTP server', () => {
      const r = this.d() as unknown as { _setServiceFlag?: (n: string, on: boolean) => void };
      r._setServiceFlag?.('bootp-server', true);
      return '';
    });
    this.configTrie.register('no ip bootp server', 'Disable BOOTP server', () => {
      const r = this.d() as unknown as { _setServiceFlag?: (n: string, on: boolean) => void };
      r._setServiceFlag?.('bootp-server', false);
      return '';
    });
    this.configTrie.register('ip finger', 'Enable finger service', () => {
      const r = this.d() as unknown as { _setServiceFlag?: (n: string, on: boolean) => void };
      r._setServiceFlag?.('finger', true);
      return '';
    });
    this.configTrie.register('no ip finger', 'Disable finger service', () => {
      const r = this.d() as unknown as { _setServiceFlag?: (n: string, on: boolean) => void };
      r._setServiceFlag?.('finger', false);
      return '';
    });
    this.configTrie.register('ip gratuitous-arps', 'Enable gratuitous ARP', () => {
      const r = this.d() as unknown as { _setServiceFlag?: (n: string, on: boolean) => void };
      r._setServiceFlag?.('gratuitous-arps', true);
      return '';
    });
    this.configTrie.register('no ip gratuitous-arps', 'Disable gratuitous ARP', () => {
      const r = this.d() as unknown as { _setServiceFlag?: (n: string, on: boolean) => void };
      r._setServiceFlag?.('gratuitous-arps', false);
      return '';
    });
    this.configTrie.register('no banner motd', 'Clear MOTD banner', () => {
      const dev = this.d() as unknown as { _setSshBanner?: (b: string) => void };
      dev._setSshBanner?.('');
      return '';
    });
    this.configTrie.registerGreedy('vrf', 'VRF configuration', (args, raw) => {
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `vrf ${args.join(' ')}`);
      return '';
    });
    this.configTrie.registerGreedy('vrf definition', 'Define a VRF', (args, raw) => {
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `vrf definition ${args.join(' ')}`);
      return '';
    });
    this.configTrie.registerGreedy('ip community-list', 'Define BGP community list', (args, raw) => {
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `ip community-list ${args.join(' ')}`);
      return '';
    });
    this.configTrie.registerGreedy('ip as-path access-list', 'Define BGP AS-path filter', (args, raw) => {
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `ip as-path access-list ${args.join(' ')}`);
      return '';
    });
    this.configTrie.registerGreedy('priority-list', 'Legacy PQ list', (args, raw) => {
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `priority-list ${args.join(' ')}`);
      return '';
    });
    this.configTrie.registerGreedy('queue-list', 'Legacy CQ list', (args, raw) => {
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `queue-list ${args.join(' ')}`);
      return '';
    });
    this.configTrie.registerGreedy('privilege', 'Configure command privilege levels', (args, raw) => {
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `privilege ${args.join(' ')}`);
      return '';
    });

    this.configTrie.registerGreedy('ip domain-name', 'Set domain name', (args) => {
      if (!args[0]) return CISCO_ERRORS.INCOMPLETE;
      const dev = this.d() as unknown as {
        getManagementService?: () => import('./router/management/RouterManagementService').RouterManagementService;
        _setDomainName?: (name: string) => void;
      };
      const mgmt = dev.getManagementService?.();
      if (mgmt) (mgmt as unknown as { domainName: string }).domainName = args[0];
      else dev._setDomainName?.(args[0]);
      return '';
    });
    this.configTrie.registerGreedy('ip domain', 'IP domain configuration', (args) => {
      if (args[0]?.toLowerCase() !== 'name' || !args[1]) return '';
      const dev = this.d() as unknown as { getManagementService?: () => import('./router/management/RouterManagementService').RouterManagementService };
      const mgmt = dev.getManagementService?.();
      if (mgmt) (mgmt as unknown as { domainName: string }).domainName = args[1];
      return '';
    });
    this.configTrie.registerGreedy('no ip domain-name', 'Clear domain name', () => {
      const dev = this.d() as unknown as {
        getManagementService?: () => import('./router/management/RouterManagementService').RouterManagementService;
        _setDomainName?: (name: string) => void;
      };
      const mgmt = dev.getManagementService?.();
      if (mgmt) (mgmt as unknown as { domainName: string }).domainName = '';
      else dev._setDomainName?.('');
      return '';
    });
    // `ip host <name> <ip>` — static hostname → IP mapping consulted by
    // outbound ssh / stelnet / ping / traceroute before any DNS fallback.
    this.configTrie.registerGreedy('ip host', 'Configure a static host entry', (args) => {
      if (args.length < 2) return '% Incomplete command.';
      const dev = this.d() as unknown as { _getHostsTable?: () => { upsert: (n: string, ip: string) => void } };
      dev._getHostsTable?.().upsert(args[0], args[1]);
      return '';
    });
    this.configTrie.registerGreedy('no ip host', 'Remove a static host entry', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const dev = this.d() as unknown as { _getHostsTable?: () => { remove: (n: string) => boolean } };
      dev._getHostsTable?.().remove(args[0]);
      return '';
    });
    this.configTrie.registerGreedy('banner', 'Set a banner', (args) => {
      const dev = this.d() as unknown as {
        _setSshBanner?: (b: string) => void;
        _setMotdBanner?: (b: string) => void;
        _setLoginBanner?: (b: string) => void;
        _setExecBanner?: (b: string) => void;
      };
      const which = args[0]?.toLowerCase();
      const rest = args.slice(1).join(' ').replace(/^[#^]\s*/, '').replace(/\s*[#^]\s*$/, '');
      if (which === 'motd') {
        dev._setMotdBanner?.(rest);
        dev._setSshBanner?.(rest);
      } else if (which === 'login') {
        dev._setLoginBanner?.(rest);
      } else if (which === 'exec') {
        dev._setExecBanner?.(rest);
      }
      return '';
    });
    this.configTrie.registerGreedy('logging', 'Logging configuration', (args) => {
      const head = (args[0] ?? '').toLowerCase();
      if (head === 'host') {
        if (!args[1]) return CISCO_ERRORS.INCOMPLETE;
        if (!isValidIPv4(args[1])) return CISCO_ERRORS.INVALID_INPUT;
      } else if (/^\d+\.\d+\.\d+\.\d+$/.test(head) && !isValidIPv4(head)) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      this.attachLoggingToDevice(this.d());
      this.logging.apply(args, false);
      this.syncSyslogAgent();
      return '';
    });
    this.configTrie.registerGreedy('no logging', 'Disable logging', (args) => {
      this.logging.apply(args, true);
      this.syncSyslogAgent();
      return '';
    });
    this.configTrie.registerGreedy('ntp', 'NTP configuration', (args) => {
      const a = args.map(s => s.toLowerCase());
      if (!a[0]) return CISCO_ERRORS.INCOMPLETE;
      if ((a[0] === 'server' || a[0] === 'peer') && !a[1]) return CISCO_ERRORS.INCOMPLETE;
      const agent = (this.d() as unknown as { getNtpAgent?: () => import('@/network/ntp/NtpAgent').NtpAgent }).getNtpAgent?.();
      if (!agent) return '';
      if (a[0] === 'server' && a[1]) {
        const target = a[1];
        const resolved = this.resolveNtpTarget(target);
        if (!resolved) {
          return `Translating "${args[1]}"...domain server (255.255.255.255)\n% Bad IP address or host name`;
        }
        agent.addServer(resolved, a.includes('prefer'), this.parseNtpKeyId(a));
      } else if (a[0] === 'peer' && a[1]) {
        const resolved = this.resolveNtpTarget(a[1]);
        if (!resolved) {
          return `Translating "${args[1]}"...domain server (255.255.255.255)\n% Bad IP address or host name`;
        }
        agent.addPeer(resolved, a.includes('prefer'), this.parseNtpKeyId(a));
      } else if (a[0] === 'master') {
        agent.setServerMode(true);
        if (a[1] && /^\d+$/.test(a[1])) agent.setLocalStratum(parseInt(a[1], 10));
      } else if (a[0] === 'source' && a[1]) {
        (agent as unknown as { setSourceInterface?: (n: string) => void }).setSourceInterface?.(a[1]);
      } else if (a[0] === 'authenticate') {
        (agent as unknown as { setAuthenticate?: (e: boolean) => void }).setAuthenticate?.(true);
      } else if (a[0] === 'authentication-key' && a[1] && a[2] === 'md5' && a[3]) {
        (agent as unknown as { addAuthKey?: (id: number, algo: string, key: string) => void }).addAuthKey?.(parseInt(a[1], 10), 'md5', a[3]);
      } else if (a[0] === 'trusted-key' && a[1]) {
        (agent as unknown as { addTrustedKey?: (id: number) => void }).addTrustedKey?.(parseInt(a[1], 10));
      } else if (a[0] === 'access-group' && a[1] && a[2]) {
        (agent as unknown as { setAccessGroup?: (kind: string, acl: string) => void }).setAccessGroup?.(a[1], a[2]);
      }
      return '';
    });
    this.configTrie.registerGreedy('no ntp', 'Remove NTP config', (args) => {
      const a = args.map(s => s.toLowerCase());
      const agent = (this.d() as unknown as { getNtpAgent?: () => import('@/network/ntp/NtpAgent').NtpAgent }).getNtpAgent?.();
      if (!agent) return '';
      if (a[0] === 'server' && a[1]) agent.removeServer(a[1]);
      else if (a[0] === 'master') { agent.setServerMode(false); agent.setLocalStratum(16); }
      return '';
    });
    this.configTrie.registerGreedy('snmp-server', 'SNMP configuration', (args) => {
      const dev = this.d() as unknown as { getSnmpService?: () => import('./router/management/SnmpService').SnmpService };
      const svc = dev.getSnmpService?.();
      if (!svc) return '';
      svc.configure(args);
      this.syncSnmpAgent();
      return '';
    });

    this.configTrie.registerGreedy('clock timezone', 'Set timezone', (args) => {
      const dev = this.d() as unknown as { getManagementService?: () => import('./router/management/RouterManagementService').RouterManagementService };
      const mgmt = dev.getManagementService?.();
      if (mgmt && args[0] && args[1]) {
        const offsetHrs = parseInt(args[1], 10);
        const offsetMin = parseInt(args[2] ?? '0', 10);
        const cfg = mgmt.getClock();
        cfg.timezone = args[0];
        cfg.offsetMin = (isNaN(offsetHrs) ? 0 : offsetHrs) * 60 + (isNaN(offsetMin) ? 0 : offsetMin) * (offsetHrs < 0 ? -1 : 1);
      }
      return '';
    });
    this.configTrie.registerGreedy('clock summer-time', 'Configure daylight saving time', (args) => {
      const dev = this.d() as unknown as { getManagementService?: () => import('./router/management/RouterManagementService').RouterManagementService };
      const mgmt = dev.getManagementService?.();
      if (mgmt && args[0]) {
        const cfg = mgmt.getClock();
        cfg.summerTimezone = args[0];
        if (args[1]?.toLowerCase() === 'recurring') {
          cfg.daylightStart = args.slice(2, 6).join(' ');
          cfg.daylightEnd = args.slice(6, 10).join(' ');
        }
      }
      return '';
    });
    this.configTrie.registerGreedy('clock set', 'Set system clock', (args) => {
      const dev = this.d() as unknown as { _setSystemClock?: (epochMs: number) => void };
      const parsedMs = this.parseClockSetArgs(args);
      if (parsedMs !== null) dev._setSystemClock?.(parsedMs);
      return '';
    });
    this.configTrie.registerGreedy('clock', 'Clock configuration (unhandled)', (args, raw) => {
      const dev = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      dev._recordUnhandledConfigLine?.(raw ?? `clock ${args.join(' ')}`);
      return '';
    });

    // Management commands missing on BOTH switch & router → shared here
    // (DRY). Recognised; the sim has no AAA/crypto datapath.
    this.configTrie.registerGreedy('aaa', 'AAA configuration', (args, raw) => {
      const dev = this.d() as unknown as { getManagementService?: () => import('./router/management/RouterManagementService').RouterManagementService };
      const mgmt = dev.getManagementService?.();
      if (mgmt) (mgmt as unknown as { recordRaw: (f: string, l: string) => void }).recordRaw('aaa', raw ?? `aaa ${args.join(' ')}`);
      return '';
    });
    this.configTrie.registerGreedy('enable secret', 'Set enable secret', (args) => {
      const dev = this.d() as unknown as { _setEnableSecret?: (s: string, algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7') => void };
      let algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7' = 'md5';
      let secret = '';
      if (args[0] === '0') { algo = 'plain'; secret = args.slice(1).join(' '); }
      else if (args[0] === '5') { algo = 'md5'; secret = args.slice(1).join(' '); }
      else if (args[0] === '7') { algo = 'type-7'; secret = args.slice(1).join(' '); }
      else if (args[0] === '8') { algo = 'sha256'; secret = args.slice(1).join(' '); }
      else if (args[0] === '9') { algo = 'scrypt'; secret = args.slice(1).join(' '); }
      else if (args[0] === 'level' && /^\d+$/.test(args[1] ?? '')) {
        secret = args.slice(2).join(' ');
      } else { secret = args.join(' '); }
      if (secret === '') return '% Incomplete command.';
      dev._setEnableSecret?.(secret, algo);
      return '';
    });
    this.configTrie.registerGreedy('enable password', 'Set enable password', (args) => {
      const dev = this.d() as unknown as { _setEnablePassword?: (p: string, algo: 'plain' | 'type-7') => void };
      let algo: 'plain' | 'type-7' = 'plain';
      let password = '';
      if (args[0] === '0') { algo = 'plain'; password = args.slice(1).join(' '); }
      else if (args[0] === '7') { algo = 'type-7'; password = args.slice(1).join(' '); }
      else { password = args.join(' '); }
      if (password === '') return '% Incomplete command.';
      dev._setEnablePassword?.(password, algo);
      return '';
    });
    // `username <name> [privilege N] [secret|password] <pwd>` — captures
    // the local-user database so the sshd dispatch can validate inbound
    // logins. Anything we don't parse is still accepted silently.
    this.configTrie.registerGreedy('username', 'Configure a local user', (args) => {
      const dev = this.d() as unknown as {
        _upsertCiscoUsername?: (name: string, kv: {
          privilege?: number; secret?: string; secretAlgo?: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7';
          autocommand?: string; nopassword?: boolean; description?: string;
        }) => void;
      };
      const name = args[0];
      if (!name || typeof dev._upsertCiscoUsername !== 'function') return '';
      const kv: {
        privilege?: number; secret?: string; secretAlgo?: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7';
        autocommand?: string; nopassword?: boolean; description?: string;
      } = {};
      for (let i = 1; i < args.length; i++) {
        const tok = args[i];
        if (tok === 'privilege' && /^\d+$/.test(args[i + 1] ?? '')) { kv.privilege = Number(args[++i]); continue; }
        if (tok === 'nopassword') { kv.nopassword = true; continue; }
        if (tok === 'autocommand') { kv.autocommand = args.slice(i + 1).join(' '); i = args.length; continue; }
        if (tok === 'description') { kv.description = args.slice(i + 1).join(' '); i = args.length; continue; }
        if (tok === 'secret' || tok === 'password') {
          const isSecret = tok === 'secret';
          const next = args[i + 1];
          let algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7' = isSecret ? 'md5' : 'plain';
          let value: string;
          if (next === '0') { algo = 'plain'; value = args[i + 2] ?? ''; i += 2; }
          else if (next === '5') { algo = 'md5'; value = args[i + 2] ?? ''; i += 2; }
          else if (next === '7') { algo = 'type-7'; value = args[i + 2] ?? ''; i += 2; }
          else if (next === '8') { algo = 'sha256'; value = args[i + 2] ?? ''; i += 2; }
          else if (next === '9') { algo = 'scrypt'; value = args[i + 2] ?? ''; i += 2; }
          else { value = next ?? ''; i++; }
          kv.secret = value;
          kv.secretAlgo = algo;
          continue;
        }
      }
      dev._upsertCiscoUsername(name, kv);
      return '';
    });
    this.configTrie.registerGreedy('crypto', 'Crypto configuration (unhandled keywords)', (args, raw) => {
      const dev = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      dev._recordUnhandledConfigLine?.(raw ?? `crypto ${args.join(' ')}`);
      return '';
    });
    this.configTrie.registerGreedy('service', 'Service configuration', (args) => {
      const dev = this.d() as unknown as { _setServiceFlag?: (name: string, on: boolean) => void };
      const name = args.join(' ');
      if (name) dev._setServiceFlag?.(name, true);
      return '';
    });
    this.configTrie.registerGreedy('no service', 'Disable a service', (args) => {
      const dev = this.d() as unknown as { _setServiceFlag?: (name: string, on: boolean) => void };
      const name = args.join(' ');
      if (name) dev._setServiceFlag?.(name, false);
      return '';
    });
    this.configTrie.registerGreedy('no username', 'Remove a local user', (args) => {
      const dev = this.d() as unknown as { _removeLocalUser?: (n: string) => void };
      if (args[0] && typeof dev._removeLocalUser === 'function') dev._removeLocalUser(args[0]);
      return '';
    });
    this.configTrie.registerGreedy('login', 'Login configuration', (args) => {
      const dev = this.d() as unknown as {
        _configureLoginBlock?: (s: number, a: number, w: number) => void;
        _setLoginBlockConfigLine?: (line: string) => void;
      };
      if (args[0] === 'block-for' && /^\d+$/.test(args[1] ?? '')) {
        const seconds = Number(args[1]);
        let attempts = 0;
        let within = 0;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === 'attempts' && /^\d+$/.test(args[i + 1] ?? '')) attempts = Number(args[++i]);
          else if (args[i] === 'within' && /^\d+$/.test(args[i + 1] ?? '')) within = Number(args[++i]);
        }
        if (typeof dev._configureLoginBlock === 'function') {
          dev._configureLoginBlock(seconds, attempts, within);
        }
      }
      return '';
    });
    this.configTrie.registerGreedy('ip ssh', 'SSH server configuration', (args, raw) => {
      const dev = this.d() as unknown as {
        getManagementService?: () => import('./router/management/RouterManagementService').RouterManagementService;
        _recordUnhandledConfigLine?: (l: string) => void;
      };
      const mgmt = dev.getManagementService?.();
      const ssh = mgmt?.getSsh();
      const head = args[0]?.toLowerCase();
      if (!ssh) {
        dev._recordUnhandledConfigLine?.(raw ?? `ip ssh ${args.join(' ')}`);
        return '';
      }
      if (head === 'version' && args[1]) (ssh as unknown as { version: number }).version = parseInt(args[1], 10);
      else if (head === 'time-out' && args[1]) (ssh as unknown as { timeout: number }).timeout = parseInt(args[1], 10);
      else if (head === 'authentication-retries' && args[1]) (ssh as unknown as { retries: number }).retries = parseInt(args[1], 10);
      else if (head === 'port' && args[1]) (ssh as unknown as { port: number }).port = parseInt(args[1], 10);
      else dev._recordUnhandledConfigLine?.(raw ?? `ip ssh ${args.join(' ')}`);
      (ssh as unknown as { enabled: boolean }).enabled = true;
      return '';
    });

    // `line {console|vty|aux} …` → shared config-line sub-mode.
    // We remember the selected VTY range so subsequent directives
    // (exec-timeout, access-class, transport input, …) land in the
    // right VtyLineConfig block.
    this.configTrie.registerGreedy('line', 'Enter line configuration', (args) => {
      this.mode = 'config-line';
      if (args[0]?.toLowerCase() === 'vty') {
        const first = Number.parseInt(args[1] ?? '0', 10);
        const last  = Number.parseInt(args[2] ?? args[1] ?? '0', 10);
        this.selectedVtyRange = { first, last };
        const dev = this.d() as unknown as { _getVtyLineConfig?: () => { upsert: (p: object) => void } };
        dev._getVtyLineConfig?.().upsert({ first, last });
      } else {
        this.selectedVtyRange = null;
      }
      return '';
    });
    for (const kw of ['login', 'password',
      'logging', 'privilege', 'no', 'speed', 'stopbits',
      'session-timeout', 'history', 'length', 'width', 'authorization',
      'accounting', 'rotary', 'autocommand', 'motd-banner', 'exec']) {
      this.configLineTrie.registerGreedy(kw, `line ${kw}`, (args, raw) => {
        const range = this.selectedVtyRange;
        if (!range) return '';
        if (kw === 'password' && !args[0]) return '% Incomplete command.';
        const dev = this.d() as unknown as { _getVtyLineConfig?: () => { upsert: (p: object) => void } };
        const update: Record<string, unknown> = { first: range.first, last: range.last };
        if (kw === 'login') {
          update.loginMethod = args[0] === 'authentication' && args[1] ? `authentication ${args[1]}` : args[0] ?? 'local';
        } else if (kw === 'password') {
          update.password = args.slice(1).join(' ') || args[0];
        } else if (kw === 'logging' && args[0]?.toLowerCase() === 'synchronous') {
          update.loggingSynchronous = true;
        } else if (kw === 'privilege' && args[0]?.toLowerCase() === 'level' && args[1]) {
          update.privilegeLevel = parseInt(args[1], 10);
        } else if (kw === 'session-timeout' && args[0]) {
          update.sessionTimeoutMinutes = parseInt(args[0], 10);
        } else if (kw === 'history' && args[0]?.toLowerCase() === 'size' && args[1]) {
          update.historySize = parseInt(args[1], 10);
        } else if (kw === 'length' && args[0]) {
          update.terminalLength = parseInt(args[0], 10);
        } else if (kw === 'width' && args[0]) {
          update.terminalWidth = parseInt(args[0], 10);
        } else if (kw === 'autocommand') {
          update.autocommand = args.join(' ');
        } else if (kw === 'motd-banner') {
          update.motdBannerSuppressed = false;
        } else if (kw === 'exec' && args[0]?.toLowerCase() === 'banner') {
          update.execBannerSuppressed = false;
        } else if (kw === 'authorization' && args[0] && args[1]) {
          update.authorizationList = `${args[0]} ${args[1]}`;
        } else if (kw === 'accounting' && args[0] && args[1]) {
          update.accountingList = `${args[0]} ${args[1]}`;
        } else if (kw === 'speed' && args[0]) {
          update.speedBaud = parseInt(args[0], 10);
        } else if (kw === 'stopbits' && args[0]) {
          update.stopbits = parseInt(args[0], 10);
        } else if (kw === 'rotary' && args[0]) {
          update.rotaryGroup = parseInt(args[0], 10);
        } else if (kw === 'no' && args.length > 0) {
          update.removed = (raw ?? `no ${args.join(' ')}`).trim();
        }
        dev._getVtyLineConfig?.().upsert(update as Parameters<NonNullable<ReturnType<NonNullable<typeof dev._getVtyLineConfig>>['upsert']>>[0]);
        return '';
      });
    }
    // `exec-timeout <minutes> [seconds]` — persisted on the VTY block
    // so show running-config can echo it back exactly.
    this.configLineTrie.registerGreedy('exec-timeout', 'Set line exec timeout', (args) => {
      const range = this.selectedVtyRange;
      if (!range) return '';
      if (args.length === 0) return '% Incomplete command.';
      if (!/^\d+$/.test(args[0]) || (args[1] !== undefined && !/^\d+$/.test(args[1]))) {
        return "% Invalid input detected at '^' marker.";
      }
      const dev = this.d() as unknown as { _getVtyLineConfig?: () => { upsert: (p: object) => void } };
      dev._getVtyLineConfig?.().upsert({
        first: range.first, last: range.last,
        execTimeoutMinutes: parseInt(args[0], 10),
        execTimeoutSeconds: parseInt(args[1] ?? '0', 10),
      });
      return '';
    });
    // `access-class <acl> {in|out}` — VTY ACL gate (§21).
    this.configLineTrie.registerGreedy('access-class', 'Apply ACL to VTY', (args) => {
      const range = this.selectedVtyRange;
      if (!range) return '';
      if (!args[0] || !args[1]) return '% Incomplete command.';
      const dir = args[1].toLowerCase();
      if (dir !== 'in' && dir !== 'out') return "% Invalid input detected at '^' marker.";
      const dev = this.d() as unknown as { _getVtyLineConfig?: () => { upsert: (p: object) => void } };
      const field = dir === 'out' ? 'accessClassOut' : 'accessClassIn';
      dev._getVtyLineConfig?.().upsert({ first: range.first, last: range.last, [field]: args[0] });
      return '';
    });
    // `transport input {all|ssh|telnet|none}` — the only line directive
    // we *do* react to today, because the sshd dispatch needs to know
    // whether SSH is administratively allowed on the VTY. Anything we
    // don't recognise is accepted silently, matching real IOS.
    this.configLineTrie.registerGreedy('transport', 'transport input/output', (args) => {
      const dev = this.d() as unknown as {
        _setVtyTransportInput?: (t: 'ssh' | 'telnet' | 'all' | 'none') => void;
        _getVtyLineConfig?: () => { upsert: (p: object) => void };
      };
      const dir = args[0]?.toLowerCase();
      if (dir !== 'input' && dir !== 'output') return "% Invalid input detected at '^' marker.";
      const proto = (args[1] ?? '').toLowerCase();
      if (!proto) return '% Incomplete command.';
      if (proto !== 'all' && proto !== 'ssh' && proto !== 'telnet' && proto !== 'none') {
        return "% Invalid input detected at '^' marker.";
      }
      if (dir === 'input' && typeof dev._setVtyTransportInput === 'function') {
        dev._setVtyTransportInput(proto);
        const range = this.selectedVtyRange;
        if (range) dev._getVtyLineConfig?.().upsert({ first: range.first, last: range.last, transportInput: proto });
      }
      return '';
    });

    // ARP config commands (shared between router and switch)
    registerArpConfigCommands(this.configTrie, () => this.d());
  }
}
