/**
 * HuaweiSwitchShell - Huawei VRP CLI Engine for Switches (CommandTrie-based)
 *
 * Modes (FSM States):
 *   - user: User view (<hostname>)
 *   - system: System view ([hostname])
 *   - interface: Interface view ([hostname-GigabitEthernet0/0/X])
 *   - vlan: VLAN view ([hostname-vlanX])
 *
 * Uses CommandTrie for:
 *   - Abbreviation matching (dis → display, sys → system-view)
 *   - Tab completion (unique prefix → complete, ambiguous → null)
 *   - ? help (prefix listing vs subcommand listing)
 */

import { CommandTrie } from './CommandTrie';
import type { ISwitchShell } from './ISwitchShell';
import type { Switch } from '../Switch';
import { MACAddress, IPAddress, SubnetMask, type PortViolationMode } from '../../core/types';
import { parsePipeFilter, applyPipeFilter, resolveHuaweiNav } from './cli-utils';
import {
  displayClock, displayCpuUsage, displayMemoryUsage, displayUsers,
  displayDevice, displayHistoryCommand, displayAlarm, displayElabel,
  displayLicense, displayLogbuffer, displayTrapbuffer,
  displayPatchInformation, displayDiagnosticInformation,
} from './huawei/HuaweiCommonDisplay';
import { registerHuaweiCommonMgmt } from './huawei/HuaweiCommonConfig';
import {
  registerHuaweiCommonSecurity, registerHuaweiCommonSecurityDisplay,
} from './huawei/HuaweiCommonSecurity';

type VRPSwitchMode =
  | 'user' | 'system' | 'interface' | 'vlan' | 'mst-region' | 'port-group'
  | 'aaa' | 'user-interface' | 'acl';

export class HuaweiSwitchShell implements ISwitchShell {
  private mode: VRPSwitchMode = 'user';
  private selectedInterface: string | null = null;
  private selectedVlan: number | null = null;

  // Per-mode command tries
  private userTrie = new CommandTrie();
  private systemTrie = new CommandTrie();
  private interfaceTrie = new CommandTrie();
  private vlanTrie = new CommandTrie();
  private mstRegionTrie = new CommandTrie();
  private portGroupTrie = new CommandTrie();
  private aaaTrie = new CommandTrie();
  private userIfTrie = new CommandTrie();
  private aclTrie = new CommandTrie();
  private uiLabel = '';
  private selectedAcl: string | null = null;
  private acls = new Map<string, {
    key: string; type: 'basic' | 'adv'; rules: string[];
  }>();
  private localUsers = new Map<string, import('./huawei/HuaweiCommonSecurity').LocalUser>();

  private swRef: Switch | null = null;

  private applyToStpAgent(fn: (a: import('@/network/stp/StpAgent').StpAgent) => void): void {
    const ag = (this.swRef as unknown as { getStpAgent?: () => import('@/network/stp/StpAgent').StpAgent } | null)?.getStpAgent?.();
    if (ag) fn(ag);
  }

  private applyToLldpAgent(fn: (a: import('@/network/lldp/LldpAgent').LldpAgent) => void): void {
    const ag = (this.swRef as unknown as { getLldpAgent?: () => import('@/network/lldp/LldpAgent').LldpAgent } | null)?.getLldpAgent?.();
    if (ag) fn(ag);
  }

  private applyToDot1xAgent(fn: (a: import('@/network/dot1x/Dot1xAgent').Dot1xAgent) => void): void {
    const ag = (this.swRef as unknown as { getDot1xAgent?: () => import('@/network/dot1x/Dot1xAgent').Dot1xAgent } | null)?.getDot1xAgent?.();
    if (ag) fn(ag);
  }

  private applyToLacpAgent(fn: (a: import('@/network/lacp/LacpAgent').LacpAgent) => void): void {
    const ag = (this.swRef as unknown as { getLacpAgent?: () => import('@/network/lacp/LacpAgent').LacpAgent } | null)?.getLacpAgent?.();
    if (ag) fn(ag);
  }
  private history: string[] = [];

  getCmdHistory(): readonly string[] { return [...this.history]; }

  // STP/RSTP/MSTP global config (switch-only, L2). Default: VRP MSTP.
  private stp: {
    enabled: boolean;
    mode: 'stp' | 'rstp' | 'mstp';
    priority: number;
    root: '' | 'primary' | 'secondary';
    bpduProtection: boolean;
    edgedPortDefault: boolean;
  } = { enabled: true, mode: 'mstp', priority: 32768, root: '', bpduProtection: false, edgedPortDefault: false };

  private mstRegion: {
    name: string; revision: number; instances: Map<number, string>;
  } = { name: '', revision: 0, instances: new Map() };

  /** Per-interface STP config lines (rendered verbatim in `display this`). */
  private ifStp = new Map<string, string[]>();

  /** Per-interface physical/security config lines (rendered in `display this`). */
  private ifCfg = new Map<string, string[]>();

  /** Per-VLAN description (vlan-view `description …`). */
  private vlanDesc = new Map<number, string>();

  /** Active `port-group` member range (port-group bulk-config view). */
  private portGroupMembers: string | null = null;

  /** Eth-Trunk (link-aggregation) groups, keyed by trunk id. */
  private ethTrunks = new Map<number, {
    mode: string; loadBalance: string; members: string[]; cfg: string[];
  }>();

  constructor() {
    this.buildUserCommands();
    this.buildSystemCommands();
    this.buildInterfaceCommands();
    this.buildVlanCommands();
    this.buildMstRegionCommands();
    this.buildPortGroupCommands();
    this.buildAaaCommands();
    this.buildUserInterfaceCommands();
    this.buildAclCommands();
  }

  getMode(): VRPSwitchMode { return this.mode; }

  getPrompt(sw: Switch): string {
    const host = sw.getHostname();
    switch (this.mode) {
      case 'user':      return `<${host}>`;
      case 'system':    return `[${host}]`;
      case 'interface': return `[${host}-${this.selectedInterface}]`;
      case 'vlan':      return `[${host}-vlan${this.selectedVlan}]`;
      case 'mst-region': return `[${host}-mst-region]`;
      case 'port-group': return `[${host}-port-group]`;
      case 'aaa':       return `[${host}-aaa]`;
      case 'user-interface': return `[${host}-ui-${this.uiLabel}]`;
      case 'acl': {
        const a = this.selectedAcl ? this.acls.get(this.selectedAcl) : undefined;
        return `[${host}-acl-${a?.type ?? 'basic'}-${this.selectedAcl ?? ''}]`;
      }
      default:          return `<${host}>`;
    }
  }

  // ─── Main Execute ─────────────────────────────────────────────────

  execute(sw: Switch, input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return '';
    if (!trimmed.endsWith('?')) this.history.push(trimmed);

    // Handle ? for help
    if (trimmed.endsWith('?')) {
      this.swRef = sw;
      const helpInput = trimmed.slice(0, -1);
      const result = this.getHelp(helpInput);
      this.swRef = null;
      return result;
    }

    // Split off an output pipe filter (| include/exclude/begin …) — shared
    // with the router shell + Cisco shells via cli-utils (DRY).
    const { cmd, filter } = parsePipeFilter(trimmed);
    const lower = cmd.toLowerCase();

    // Global navigation (all modes). Accepts unambiguous VRP
    // abbreviations: q/qu/qui→quit, ret/retu…→return.
    const nav = resolveHuaweiNav(lower);
    if (nav === 'return') {
      this.mode = 'user';
      this.selectedInterface = null;
      this.selectedVlan = null;
      return '';
    }
    if (nav === 'quit') return this.cmdQuit();

    // Bind switch reference for command closures
    this.swRef = sw;

    // Get the trie for current mode
    const trie = this.getActiveTrie();
    const result = trie.match(cmd);

    let output: string;
    switch (result.status) {
      case 'ok':
        output = result.node?.action ? result.node.action(result.args, cmd) : '';
        break;

      case 'ambiguous':
        output = `Error: Ambiguous command "${cmd}"`;
        break;

      case 'incomplete':
        output = 'Error: Incomplete command.';
        break;

      case 'invalid':
        output = `Error: Unrecognized command "${cmd}"`;
        break;

      default:
        output = `Error: Unrecognized command "${cmd}"`;
    }

    this.swRef = null;
    // Apply the pipe filter only to successful output (errors pass through).
    return filter && !output.startsWith('Error:')
      ? applyPipeFilter(output, filter)
      : output;
  }

  // ─── Help / Completion ────────────────────────────────────────────

  getHelp(input: string): string {
    const trie = this.getActiveTrie();
    const completions = trie.getCompletions(input);
    if (completions.length === 0) return 'Error: Unrecognized command';
    const maxKw = Math.max(...completions.map(c => c.keyword.length));
    return completions
      .map(c => `  ${c.keyword.padEnd(maxKw + 2)}${c.description}`)
      .join('\n');
  }

  tabComplete(input: string): string | null {
    const trie = this.getActiveTrie();
    return trie.tabComplete(input);
  }

  // ─── FSM Transitions ─────────────────────────────────────────────

  private cmdQuit(): string {
    switch (this.mode) {
      case 'interface':
        this.mode = 'system';
        this.selectedInterface = null;
        return '';
      case 'vlan':
        this.mode = 'system';
        this.selectedVlan = null;
        return '';
      case 'mst-region':
        this.mode = 'system';
        return '';
      case 'port-group':
        this.mode = 'system';
        this.portGroupMembers = null;
        return '';
      case 'aaa':
      case 'user-interface':
        this.mode = 'system';
        return '';
      case 'acl':
        this.mode = 'system';
        this.selectedAcl = null;
        return '';
      case 'system':
        this.mode = 'user';
        return '';
      case 'user':
        return '';
      default:
        return '';
    }
  }

  private getActiveTrie(): CommandTrie {
    switch (this.mode) {
      case 'user':      return this.userTrie;
      case 'system':    return this.systemTrie;
      case 'interface': return this.interfaceTrie;
      case 'vlan':      return this.vlanTrie;
      case 'mst-region': return this.mstRegionTrie;
      case 'port-group': return this.portGroupTrie;
      case 'aaa':       return this.aaaTrie;
      case 'user-interface': return this.userIfTrie;
      case 'acl':       return this.aclTrie;
      default:          return this.userTrie;
    }
  }

  // ─── Command Tree: User View (<hostname>) ─────────────────────────

  private buildUserCommands(): void {
    // system-view → enter system view
    this.userTrie.register('system-view', 'Enter system view', () => {
      this.mode = 'system';
      return 'Enter system view, return user view with return command.';
    });

    // display + common management commands
    this.registerDisplayCommands(this.userTrie);
    this.registerCommonMgmt(this.userTrie);
  }

  // ─── Command Tree: System View ([hostname]) ───────────────────────

  private buildSystemCommands(): void {
    // `system-view` from system view is an idempotent no-op (robustness:
    // re-issuing it must not error mid-sequence).
    this.systemTrie.register('system-view', 'Already in system view', () => '');

    // display + common management commands (available in system view too)
    this.registerDisplayCommands(this.systemTrie);
    this.registerCommonMgmt(this.systemTrie);
    this.registerStpSystemCommands(this.systemTrie);

    this.systemTrie.register('lldp enable', 'Enable LLDP globally', () => {
      this.applyToLldpAgent(a => a.setEnabled(true));
      return '';
    });
    this.systemTrie.register('undo lldp enable', 'Disable LLDP globally', () => {
      this.applyToLldpAgent(a => a.setEnabled(false));
      return '';
    });
    this.systemTrie.register('dot1x enable', 'Enable 802.1X globally', () => {
      this.applyToDot1xAgent(a => a.setSystemAuthControl(true));
      return '';
    });
    this.systemTrie.register('undo dot1x enable', 'Disable 802.1X globally', () => {
      this.applyToDot1xAgent(a => a.setSystemAuthControl(false));
      return '';
    });
    this.systemTrie.registerGreedy('lldp message-transmission interval', 'Hello period (sec)', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 5 || n > 32768) return 'Error: Wrong parameter found.';
      this.applyToLldpAgent(a => a.setTimerSec(n));
      return '';
    });
    this.systemTrie.registerGreedy('lldp message-transmission hold-multiplier', 'Hold multiplier', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 2 || n > 10) return 'Error: Wrong parameter found.';
      this.applyToLldpAgent(a => a.setHoldtimeMultiplier(n));
      return '';
    });

    // sysname <name>
    this.systemTrie.registerGreedy('sysname', 'Set system hostname', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      this.swRef._setHostnameInternal(args[0]);
      return '';
    });

    // vlan <id> or vlan batch <id> <id> ...
    this.systemTrie.registerGreedy('vlan', 'VLAN configuration', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';

      // vlan batch <id> <id> ...
      if (args[0].toLowerCase() === 'batch') {
        for (let i = 1; i < args.length; i++) {
          const id = parseInt(args[i], 10);
          if (!isNaN(id) && id >= 1 && id <= 4094) {
            this.swRef.createVLAN(id);
          }
        }
        return '';
      }

      // vlan <id> → enter VLAN config mode
      const id = parseInt(args[0], 10);
      if (isNaN(id) || id < 1 || id > 4094) return 'Error: Wrong parameter found.';
      if (!this.swRef.getVLAN(id)) this.swRef.createVLAN(id);
      this.selectedVlan = id;
      this.mode = 'vlan';
      return '';
    });

    // undo <subcommand>
    this.systemTrie.registerGreedy('undo', 'Undo configuration', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      return this.cmdUndo(args);
    });

    // port-group {group-member <a> [to <b>] | <name>} → bulk-config view
    this.systemTrie.registerGreedy('port-group', 'Enter port-group view', (args) => {
      this.portGroupMembers = args.join(' ');
      this.mode = 'port-group';
      return '';
    });

    // aaa → AAA view
    this.systemTrie.register('aaa', 'Enter AAA view', () => {
      this.mode = 'aaa';
      return '';
    });

    // acl {<number> | name <name> [number] | number <number>} → ACL view
    this.systemTrie.registerGreedy('acl', 'Configure an ACL', (args) => {
      if (args.length < 1) return 'Error: Incomplete command.';
      let key: string;
      let num = NaN;
      if (args[0].toLowerCase() === 'name') {
        key = args[1] ?? '';
        num = parseInt(args[2] ?? '', 10);
      } else if (args[0].toLowerCase() === 'number') {
        num = parseInt(args[1] ?? '', 10);
        key = String(num);
      } else {
        num = parseInt(args[0], 10);
        key = String(num);
      }
      if (!key) return 'Error: Wrong parameter found at \'^\' position.';
      const type: 'basic' | 'adv' = (!isNaN(num) && num >= 3000) ? 'adv' : 'basic';
      if (!this.acls.has(key)) this.acls.set(key, { key, type, rules: [] });
      this.selectedAcl = key;
      this.mode = 'acl';
      return '';
    });

    // user-interface {console <n> | vty <first> [last] | maxvty …} → UI view
    this.systemTrie.registerGreedy('user-interface', 'Enter user-interface view', (args) => {
      if (args.length === 0) return 'Error: Incomplete command.';
      if (args[0].toLowerCase() === 'maxvty') return ''; // global setting, no view
      const type = args[0].toLowerCase();
      const first = args[1] ?? '0';
      const last = args[2];
      this.uiLabel = `${type}${first}${last ? `-${last}` : ''}`;
      this.mode = 'user-interface';
      return '';
    });

    // Shared management commands (SSH/Telnet/SNMP/NTP/syslog/…) — DRY
    registerHuaweiCommonSecurity(this.systemTrie);

    this.systemTrie.register('dhcp enable', 'Enable DHCP', () => {
      this.swRef.getSecurityService().setDhcpEnabled(true);
      return '';
    });
    this.systemTrie.register('undo dhcp enable', 'Disable DHCP', () => {
      this.swRef.getSecurityService().setDhcpEnabled(false);
      return '';
    });
    this.systemTrie.registerGreedy('dhcp', 'DHCP snooping configuration', (args) => {
      this.swRef.getSecurityService().configureDhcpSnooping(args);
      return '';
    });
    this.systemTrie.registerGreedy('arp anti-attack', 'ARP anti-attack configuration', (args) => {
      this.swRef.getSecurityService().configureArpAntiAttack(args);
      return '';
    });
    this.systemTrie.registerGreedy('ip source', 'IP source guard configuration', (args) => {
      this.swRef.getSecurityService().configureIpSource(args);
      return '';
    });

    // interface <name>  (incl. virtual Eth-Trunk; L3 types stay rejected)
    this.systemTrie.registerGreedy('interface', 'Enter interface view', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      // Eth-Trunk <id>  /  Eth-TrunkN  → link-aggregation virtual interface
      const joined = args.join(' ');
      const et = joined.match(/^eth-?trunk\s*(\d+)$/i);
      if (et) {
        const id = parseInt(et[1], 10);
        if (!this.ethTrunks.has(id)) {
          this.ethTrunks.set(id, { mode: 'manual', loadBalance: '', members: [], cfg: [] });
        }
        this.selectedInterface = `Eth-Trunk${id}`;
        this.mode = 'interface';
        return '';
      }
      // `interface range <a> [to <b>]` — Cisco-ism the suites use; treat
      // as a bulk-config view like port-group (Huawei has no per-port
      // datapath difference here).
      if (args[0].toLowerCase() === 'range') {
        this.portGroupMembers = args.slice(1).join(' ');
        this.mode = 'port-group';
        return '';
      }
      const vlanIfMatch = args.join(' ').match(/^vlanif\s*(\d+)$/i);
      if (vlanIfMatch) {
        const vlan = parseInt(vlanIfMatch[1], 10);
        if (vlan < 1 || vlan > 4094) return `Error: Wrong parameter found at '^' position.`;
        this.swRef.ensureSvi(vlan);
        this.swRef.setSviAdminUp(vlan, true);
        this.selectedInterface = `Vlanif${vlan}`;
        this.mode = 'interface';
        return '';
      }

      const portName = this.resolveInterfaceName(args[0]);
      if (!portName) return `Error: Wrong parameter found at '^' position.`;
      this.selectedInterface = portName;
      this.mode = 'interface';
      return '';
    });

    // mac-address aging-time <seconds>
    this.systemTrie.registerGreedy('mac-address', 'MAC address configuration', (args) => {
      if (!this.swRef || args.length < 2) return 'Error: Incomplete command.';
      if (args[0].toLowerCase() === 'aging-time') {
        const seconds = parseInt(args[1], 10);
        if (isNaN(seconds) || seconds < 0) return 'Error: Invalid parameter.';
        this.swRef.setMACAgingTime(seconds);
        return '';
      }
      return 'Error: Incomplete command.';
    });

    this.systemTrie.registerGreedy('ip route-static', 'Add a static route', (args) => {
      if (!this.swRef || args.length < 3) return 'Error: Incomplete command.';
      let net: IPAddress, mask: SubnetMask, gw: IPAddress;
      try { net = new IPAddress(args[0]); } catch { return `Error: Invalid network ${args[0]}.`; }
      try {
        if (/^\d+$/.test(args[1])) mask = SubnetMask.fromCIDR(parseInt(args[1], 10));
        else mask = new SubnetMask(args[1]);
      } catch { return `Error: Invalid mask ${args[1]}.`; }
      try { gw = new IPAddress(args[2]); } catch { return `Error: Invalid gateway ${args[2]}.`; }
      this.swRef.addStaticRoute(net, mask, gw);
      return '';
    });

    this.systemTrie.registerGreedy('undo ip route-static', 'Remove a static route', (args) => {
      if (!this.swRef || args.length < 2) return 'Error: Incomplete command.';
      let net: IPAddress, mask: SubnetMask;
      try { net = new IPAddress(args[0]); } catch { return `Error: Invalid network ${args[0]}.`; }
      try {
        if (/^\d+$/.test(args[1])) mask = SubnetMask.fromCIDR(parseInt(args[1], 10));
        else mask = new SubnetMask(args[1]);
      } catch { return `Error: Invalid mask ${args[1]}.`; }
      this.swRef.removeStaticRoute(net, mask);
      return '';
    });
  }

  // ─── Command Tree: Interface View ([hostname-GigabitEthernet0/0/X]) ──

  private buildInterfaceCommands(): void {
    // display commands
    this.registerDisplayCommands(this.interfaceTrie);
    this.registerStpInterfaceCommands(this.interfaceTrie);

    this.interfaceTrie.register('lldp enable', 'Enable LLDP on this interface', () => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const port = this.selectedInterface;
      this.applyToLldpAgent(a => { a.setPortTransmit(port, true); a.setPortReceive(port, true); });
      return '';
    });
    this.interfaceTrie.register('undo lldp enable', 'Disable LLDP on this interface', () => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const port = this.selectedInterface;
      this.applyToLldpAgent(a => { a.setPortTransmit(port, false); a.setPortReceive(port, false); });
      return '';
    });
    this.interfaceTrie.registerGreedy('lldp admin-status', 'LLDP admin status', (args) => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const port = this.selectedInterface;
      const m = (args[0] ?? '').toLowerCase();
      this.applyToLldpAgent(a => {
        if (m === 'tx') { a.setPortTransmit(port, true); a.setPortReceive(port, false); }
        else if (m === 'rx') { a.setPortTransmit(port, false); a.setPortReceive(port, true); }
        else if (m === 'txrx') { a.setPortTransmit(port, true); a.setPortReceive(port, true); }
        else if (m === 'disable') { a.setPortTransmit(port, false); a.setPortReceive(port, false); }
      });
      return '';
    });
    this.registerInterfacePhysicalCommands(this.interfaceTrie);

    // shutdown
    this.interfaceTrie.register('shutdown', 'Shut down interface', () => {
      if (!this.swRef || !this.selectedInterface) return '';
      const vlanIfMatch = this.selectedInterface.match(/^Vlanif(\d+)$/);
      if (vlanIfMatch) { this.swRef.setSviAdminUp(parseInt(vlanIfMatch[1], 10), false); return ''; }
      const port = this.swRef.getPort(this.selectedInterface);
      if (port) port.setUp(false);
      return '';
    });

    // Generic `undo <…>` fallback (specific undo forms below still win).
    this.interfaceTrie.registerGreedy('undo', 'Undo configuration', (args) =>
      this.cmdUndo(args));
    this.vlanTrie.registerGreedy('undo', 'Undo configuration', (args) =>
      this.cmdUndo(args));

    // undo shutdown
    this.interfaceTrie.register('undo shutdown', 'Bring up interface', () => {
      if (!this.swRef || !this.selectedInterface) return '';
      const vlanIfMatch = this.selectedInterface.match(/^Vlanif(\d+)$/);
      if (vlanIfMatch) { this.swRef.setSviAdminUp(parseInt(vlanIfMatch[1], 10), true); return ''; }
      const port = this.swRef.getPort(this.selectedInterface);
      if (port) port.setUp(true);
      return '';
    });

    this.interfaceTrie.registerGreedy('description', 'Set interface description', (args) => {
      if (!this.swRef || !this.selectedInterface || args.length < 1) return 'Error: Incomplete command.';
      this.swRef.setInterfaceDescription(this.selectedInterface, args.join(' '));
      return '';
    });

    this.interfaceTrie.registerGreedy('ip address', 'Configure IP address on SVI', (args) => {
      if (!this.swRef || !this.selectedInterface) return 'Error: Wrong parameter.';
      const vlanIfMatch = this.selectedInterface.match(/^Vlanif(\d+)$/);
      if (!vlanIfMatch) return `Error: 'ip address' is only valid on Vlanif interfaces.`;
      if (args.length < 2) return 'Error: Incomplete command.';
      let ip: IPAddress, mask: SubnetMask;
      try { ip = new IPAddress(args[0]); } catch { return `Error: Invalid IP address ${args[0]}.`; }
      try {
        if (/^\d+$/.test(args[1])) mask = SubnetMask.fromCIDR(parseInt(args[1], 10));
        else mask = new SubnetMask(args[1]);
      } catch { return `Error: Invalid mask ${args[1]}.`; }
      const vlan = parseInt(vlanIfMatch[1], 10);
      this.swRef.ensureSvi(vlan);
      this.swRef.configureSviIp(vlan, ip, mask);
      this.swRef.setSviAdminUp(vlan, true);
      return '';
    });

    this.interfaceTrie.register('undo ip address', 'Remove IP from SVI', () => {
      if (!this.swRef || !this.selectedInterface) return 'Error: Wrong parameter.';
      const vlanIfMatch = this.selectedInterface.match(/^Vlanif(\d+)$/);
      if (!vlanIfMatch) return '';
      this.swRef.clearSviIp(parseInt(vlanIfMatch[1], 10));
      return '';
    });

    // port link-type access
    this.interfaceTrie.register('port link-type access', 'Set port to access mode', () => {
      if (!this.swRef || !this.selectedInterface) return 'Error: Wrong parameter.';
      this.swRef.setSwitchportMode(this.selectedInterface, 'access');
      return '';
    });

    // port link-type trunk
    this.interfaceTrie.register('port link-type trunk', 'Set port to trunk mode', () => {
      if (!this.swRef || !this.selectedInterface) return 'Error: Wrong parameter.';
      this.swRef.setSwitchportMode(this.selectedInterface, 'trunk');
      return '';
    });

    // port link-type hybrid — the Switch model has no hybrid datapath,
    // so it is recorded for `display this` and treated as access for
    // forwarding (closest L2 behaviour) without breaking VLAN tests.
    this.interfaceTrie.register('port link-type hybrid', 'Set port to hybrid mode', () => {
      if (!this.selectedInterface) return 'Error: Wrong parameter.';
      const list = this.ifCfg.get(this.selectedInterface) ?? [];
      list.push('port link-type hybrid');
      this.ifCfg.set(this.selectedInterface, list);
      return '';
    });

    // port hybrid pvid/tagged/untagged …  |  port vlan-mapping …
    for (const sub of ['port hybrid', 'port vlan-mapping']) {
      this.interfaceTrie.registerGreedy(sub, `Interface ${sub} configuration`, (args) => {
        if (!this.selectedInterface) return 'Error: Incomplete command.';
        const list = this.ifCfg.get(this.selectedInterface) ?? [];
        list.push(`${sub} ${args.join(' ')}`.trim());
        this.ifCfg.set(this.selectedInterface, list);
        return '';
      });
    }
    this.registerPortSecurity();
    this.registerDot1x();

    // Interface-view L2 security: DHCP snooping / IP source guard /
    // ARP anti-attack — recorded for `display this` (L2-only: no L3).
    for (const sub of ['dhcp snooping', 'ip source', 'arp anti-attack']) {
      this.interfaceTrie.registerGreedy(sub, `Interface ${sub}`, (args) => {
        if (!this.selectedInterface) return 'Error: Incomplete command.';
        const list = this.ifCfg.get(this.selectedInterface) ?? [];
        list.push(`${sub} ${args.join(' ')}`.trim());
        this.ifCfg.set(this.selectedInterface, list);
        return '';
      });
    }
    // voice-vlan / qinq — recognised L2 features (recorded for display).
    for (const kw of ['voice-vlan', 'qinq']) {
      this.interfaceTrie.registerGreedy(kw, `Interface ${kw} configuration`, (args) => {
        if (!this.selectedInterface) return 'Error: Incomplete command.';
        const list = this.ifCfg.get(this.selectedInterface) ?? [];
        list.push(`${kw} ${args.join(' ')}`.trim());
        this.ifCfg.set(this.selectedInterface, list);
        return '';
      });
    }

    // ── Eth-Trunk (LACP) interface-view commands ──
    const trunkId = (): number | null => {
      const m = (this.selectedInterface ?? '').match(/^Eth-Trunk(\d+)$/);
      return m ? parseInt(m[1], 10) : null;
    };
    // `mode <manual|lacp-static|lacp-dynamic>` (Eth-Trunk only)
    this.interfaceTrie.registerGreedy('mode', 'Set Eth-Trunk working mode', (args) => {
      const id = trunkId();
      if (id === null) return `Error: Unrecognized command "mode ${args.join(' ')}"`;
      const t = this.ethTrunks.get(id)!;
      t.mode = args.join(' ');
      t.cfg.push(`mode ${args.join(' ')}`);
      return '';
    });
    // `max|least active-linknumber N`, `load-balance <algo>` (Eth-Trunk)
    for (const kw of ['max', 'least', 'load-balance']) {
      this.interfaceTrie.registerGreedy(kw, `Eth-Trunk ${kw}`, (args) => {
        const id = trunkId();
        if (id === null) return `Error: Unrecognized command "${kw} ${args.join(' ')}"`;
        this.ethTrunks.get(id)!.cfg.push(`${kw} ${args.join(' ')}`.trim());
        return '';
      });
    }
    // `trunkport <if> [to <if>]` — add member ports from the trunk view
    this.interfaceTrie.registerGreedy('trunkport', 'Add member port to Eth-Trunk', (args) => {
      const id = trunkId();
      if (id === null || args.length < 1) return 'Error: Incomplete command.';
      const member = this.resolveInterfaceName(args[0]) || args[0];
      this.ethTrunks.get(id)!.members.push(member);
      return '';
    });
    // `eth-trunk <id>` — join the trunk from a physical interface view
    this.interfaceTrie.registerGreedy('eth-trunk', 'Add interface to an Eth-Trunk', (args) => {
      if (!this.selectedInterface || args.length < 1) return 'Error: Incomplete command.';
      const id = parseInt(args[0], 10);
      if (isNaN(id)) return 'Error: Wrong parameter found at \'^\' position.';
      if (!this.ethTrunks.has(id)) {
        this.ethTrunks.set(id, { mode: 'manual', loadBalance: '', members: [], cfg: [] });
      }
      const t = this.ethTrunks.get(id)!;
      if (!t.members.includes(this.selectedInterface)) t.members.push(this.selectedInterface);
      const list = this.ifCfg.get(this.selectedInterface) ?? [];
      list.push(`eth-trunk ${id}`);
      this.ifCfg.set(this.selectedInterface, list);
      this.applyToLacpAgent(a => {
        const lacpMode = t.mode === 'lacp-dynamic' ? 'active'
          : t.mode === 'lacp-static' ? 'active' : 'on';
        a.ensureGroup(id, `Eth-Trunk${id}`, t.loadBalance);
        a.addPortToGroup(this.selectedInterface!, id, lacpMode);
      });
      return '';
    });

    // port default vlan <id>
    this.interfaceTrie.registerGreedy('port default vlan', 'Set default VLAN for access port', (args) => {
      if (!this.swRef || !this.selectedInterface || args.length < 1) return 'Error: Incomplete command.';
      const vlanId = parseInt(args[0], 10);
      if (isNaN(vlanId)) return 'Error: Wrong parameter.';
      this.swRef.setSwitchportAccessVlan(this.selectedInterface, vlanId);
      return '';
    });

    // port trunk allow-pass vlan <id> [<id>...] | all | none
    this.interfaceTrie.registerGreedy('port trunk allow-pass vlan', 'Set trunk allowed VLANs', (args) => {
      if (!this.swRef || !this.selectedInterface || args.length < 1) return 'Error: Incomplete command.';
      if (args[0].toLowerCase() === 'all') {
        this.swRef.setTrunkAllowedVlansAll(this.selectedInterface);
        return '';
      }
      if (args[0].toLowerCase() === 'none') {
        this.swRef.setTrunkAllowedVlansNone(this.selectedInterface);
        return '';
      }
      const vlans = new Set<number>();
      for (const arg of args) {
        // Support range notation e.g. "10 to 20" or "10 20"
        const id = parseInt(arg, 10);
        if (!isNaN(id)) vlans.add(id);
      }
      // Huawei additive semantics: add to existing allowed list
      this.swRef.addTrunkAllowedVlans(this.selectedInterface, vlans);
      return '';
    });

    // undo port trunk allow-pass vlan <id> [<id>...] | all
    this.interfaceTrie.registerGreedy('undo port trunk allow-pass vlan', 'Remove trunk allowed VLANs', (args) => {
      if (!this.swRef || !this.selectedInterface || args.length < 1) return 'Error: Incomplete command.';
      if (args[0].toLowerCase() === 'all') {
        this.swRef.setTrunkAllowedVlansNone(this.selectedInterface);
        return '';
      }
      const vlans = new Set<number>();
      for (const arg of args) {
        const id = parseInt(arg, 10);
        if (!isNaN(id)) vlans.add(id);
      }
      this.swRef.removeTrunkAllowedVlans(this.selectedInterface, vlans);
      return '';
    });

    // undo port default vlan — reset to VLAN 1
    this.interfaceTrie.register('undo port default vlan', 'Reset access VLAN to default', () => {
      if (!this.swRef || !this.selectedInterface) return 'Error: Wrong parameter.';
      this.swRef.setSwitchportAccessVlan(this.selectedInterface, 1);
      return '';
    });

    // undo port trunk pvid vlan — reset PVID to 1
    this.interfaceTrie.register('undo port trunk pvid vlan', 'Reset trunk PVID to default', () => {
      if (!this.swRef || !this.selectedInterface) return 'Error: Wrong parameter.';
      this.swRef.setTrunkNativeVlan(this.selectedInterface, 1);
      return '';
    });

    // port trunk pvid vlan <id>
    this.interfaceTrie.registerGreedy('port trunk pvid vlan', 'Set trunk PVID', (args) => {
      if (!this.swRef || !this.selectedInterface || args.length < 1) return 'Error: Incomplete command.';
      const vlanId = parseInt(args[0], 10);
      if (isNaN(vlanId)) return 'Error: Wrong parameter.';
      this.swRef.setTrunkNativeVlan(this.selectedInterface, vlanId);
      return '';
    });
  }

  // ─── Command Tree: VLAN View ([hostname-vlanX]) ───────────────────

  private buildVlanCommands(): void {
    // name <vlan-name>
    this.vlanTrie.registerGreedy('name', 'Set VLAN name', (args) => {
      if (!this.swRef || this.selectedVlan === null || args.length < 1) return 'Error: Incomplete command.';
      this.swRef.renameVLAN(this.selectedVlan, args[0]);
      return '';
    });

    // description <text> — stored per-VLAN.
    this.vlanTrie.registerGreedy('description', 'Set VLAN description', (args) => {
      if (this.selectedVlan === null || args.length < 1) return 'Error: Incomplete command.';
      this.vlanDesc.set(this.selectedVlan, args.join(' '));
      return '';
    });

    this.vlanTrie.registerGreedy('igmp-snooping', 'VLAN IGMP snooping configuration', (args, raw) => {
      if (this.selectedVlan === null) return '';
      const v = this.swRef.getVLAN(this.selectedVlan);
      if (!v) return '';
      const extra = (v as unknown as { extras?: Record<string, string[]> }).extras ?? {};
      const line = raw ?? `igmp-snooping ${args.join(' ')}`.trim();
      if (!extra['igmp-snooping']) extra['igmp-snooping'] = [];
      extra['igmp-snooping'].push(line);
      (v as unknown as { extras: Record<string, string[]> }).extras = extra;
      const agent = (this.swRef as unknown as { getIgmpSnoopingAgent?: () => import('@/network/igmp-snooping/IgmpSnoopingAgent').IgmpSnoopingAgent }).getIgmpSnoopingAgent?.();
      if (agent && args[0] === 'enable') agent.setVlanEnabled(this.selectedVlan, true);
      return '';
    });
    this.vlanTrie.registerGreedy('undo igmp-snooping', 'Disable VLAN IGMP snooping', (args, raw) => {
      if (this.selectedVlan === null) return '';
      const v = this.swRef.getVLAN(this.selectedVlan);
      if (!v) return '';
      const extra = (v as unknown as { extras?: Record<string, string[]> }).extras ?? {};
      const line = raw ?? `undo igmp-snooping ${args.join(' ')}`.trim();
      if (!extra['igmp-snooping']) extra['igmp-snooping'] = [];
      extra['igmp-snooping'].push(line);
      (v as unknown as { extras: Record<string, string[]> }).extras = extra;
      const agent = (this.swRef as unknown as { getIgmpSnoopingAgent?: () => import('@/network/igmp-snooping/IgmpSnoopingAgent').IgmpSnoopingAgent }).getIgmpSnoopingAgent?.();
      if (agent && (args.length === 0 || args[0] === 'enable')) agent.setVlanEnabled(this.selectedVlan, false);
      return '';
    });

    for (const kw of ['mux-vlan', 'aggregate-vlan', 'access-vlan',
      'vlan-type', 'mac-vlan', 'ip', 'arp']) {
      this.vlanTrie.registerGreedy(kw, `VLAN ${kw} configuration`, (args, raw) => {
        if (this.selectedVlan === null) return '';
        const v = this.swRef.getVLAN(this.selectedVlan);
        if (!v) return '';
        const extra = (v as unknown as { extras?: Record<string, string[]> }).extras ?? {};
        const line = raw ?? `${kw} ${args.join(' ')}`.trim();
        if (!extra[kw]) extra[kw] = [];
        extra[kw].push(line);
        (v as unknown as { extras: Record<string, string[]> }).extras = extra;
        return '';
      });
    }
  }

  /** `port-group` bulk-config sub-view ([host-port-group]). */
  private buildPortGroupCommands(): void {
    const t = this.portGroupTrie;
    const accept = () => '';
    // Same port/physical/stp keywords as interface view — applied to the
    // member range. The L2 sim records nothing per-port here (the range
    // is informational), so they are recognised no-ops.
    for (const kw of ['port', 'speed', 'duplex', 'negotiation', 'mtu',
      'flow-control', 'shutdown', 'stp', 'storm-control', 'description',
      'loopback-detect', 'port-security', 'port-isolate', 'undo',
      'group-member', 'eth-trunk', 'broadcast-suppression']) {
      t.registerGreedy(kw, `port-group ${kw}`, accept);
    }
    t.register('display this', 'Display port-group configuration', () =>
      `port-group group-member ${this.portGroupMembers ?? ''}`.trim());
  }

  /** AAA sub-view ([host-aaa]) — local-user / scheme / domain. */
  private buildAaaCommands(): void {
    const t = this.aaaTrie;
    t.registerGreedy('local-user', 'Configure a local user', (args) => {
      if (args.length < 2) return 'Error: Incomplete command.';
      const name = args[0];
      const u = this.localUsers.get(name) ?? {};
      const kw = args[1].toLowerCase();
      if (kw === 'password') u.password = '******';
      else if (kw === 'privilege') u.privilege = args[args.length - 1];
      else if (kw === 'service-type') u.serviceType = args.slice(2).join(',');
      this.localUsers.set(name, u);
      return '';
    });
    for (const kw of ['authentication-scheme', 'authorization-scheme',
      'accounting-scheme', 'domain', 'undo']) {
      t.registerGreedy(kw, `aaa ${kw}`, (args, raw) => {
        const cfg = this.aaaExtraConfig ?? (this.aaaExtraConfig = {
          authenticationSchemes: [], authorizationSchemes: [],
          accountingSchemes: [], domains: [], rawLines: [],
        });
        const line = raw ?? `${kw} ${args.join(' ')}`.trim();
        if (kw === 'authentication-scheme' && args[0]) cfg.authenticationSchemes.push(args[0]);
        else if (kw === 'authorization-scheme' && args[0]) cfg.authorizationSchemes.push(args[0]);
        else if (kw === 'accounting-scheme' && args[0]) cfg.accountingSchemes.push(args[0]);
        else if (kw === 'domain' && args[0]) cfg.domains.push(args[0]);
        else cfg.rawLines.push(line);
        return '';
      });
    }
  }

  private userInterfaceExtraConfig: Map<string, {
    authMode?: string;
    idleTimeoutMin?: number;
    screenLength?: number;
    historySize?: number;
    shellEnabled: boolean;
    acl?: string;
    authorizationMode?: string;
    users: string[];
    rawLines: string[];
  }> = new Map();
  getUserInterfaceExtraConfig() { return this.userInterfaceExtraConfig; }

  private aaaExtraConfig: {
    authenticationSchemes: string[];
    authorizationSchemes: string[];
    accountingSchemes: string[];
    domains: string[];
    rawLines: string[];
  } | null = null;
  getAaaExtraConfig() { return this.aaaExtraConfig; }

  /** user-interface sub-view ([host-ui-…]) — auth-mode / protocol / etc. */
  private buildUserInterfaceCommands(): void {
    const t = this.userIfTrie;
    for (const kw of ['authentication-mode', 'user',
      'idle-timeout', 'screen-length', 'history-command', 'shell',
      'acl', 'set', 'authorization-mode']) {
      t.registerGreedy(kw, `user-interface ${kw}`, (args, raw) => {
        const label = this.uiLabel;
        const cfg = this.userInterfaceExtraConfig.get(label) ?? {
          authMode: undefined as string | undefined,
          idleTimeoutMin: undefined as number | undefined,
          screenLength: undefined as number | undefined,
          historySize: undefined as number | undefined,
          shellEnabled: true,
          acl: undefined as string | undefined,
          authorizationMode: undefined as string | undefined,
          users: [] as string[],
          rawLines: [] as string[],
        };
        const line = raw ?? `${kw} ${args.join(' ')}`.trim();
        if (kw === 'authentication-mode' && args[0]) cfg.authMode = args[0];
        else if (kw === 'idle-timeout' && args[0]) cfg.idleTimeoutMin = parseInt(args[0], 10);
        else if (kw === 'screen-length' && args[0]) cfg.screenLength = parseInt(args[0], 10);
        else if (kw === 'history-command' && args[0] === 'max-size' && args[1]) cfg.historySize = parseInt(args[1], 10);
        else if (kw === 'shell') cfg.shellEnabled = true;
        else if (kw === 'acl' && args[0]) cfg.acl = args[0];
        else if (kw === 'authorization-mode' && args[0]) cfg.authorizationMode = args[0];
        else if (kw === 'user' && args[0]) cfg.users.push(args.join(' '));
        else if (kw === 'set') cfg.rawLines.push(line);
        this.userInterfaceExtraConfig.set(label, cfg);
        return '';
      });
    }
    // `protocol inbound {ssh|telnet|all|none}` toggles VTY transports
    // exactly like Cisco's `transport input`. Routes through the device
    // setter so CrossVendorSshHost.evaluate() sees the change.
    t.registerGreedy('protocol', 'user-interface protocol', (args) => {
      if (args[0]?.toLowerCase() !== 'inbound' || !args[1]) return '';
      const dev = this.swRef as unknown as { _setVtyTransportInput?: (t: 'ssh' | 'telnet' | 'all' | 'none') => void };
      const proto = args[1].toLowerCase() as 'ssh' | 'telnet' | 'all' | 'none';
      if (dev._setVtyTransportInput && ['ssh', 'telnet', 'all', 'none'].includes(proto)) {
        dev._setVtyTransportInput(proto);
      }
      return '';
    });
    // `undo protocol inbound [ssh|telnet]` — VRP convention: removing the
    // listed transports leaves the others. With no arg it disables both.
    t.registerGreedy('undo', 'user-interface undo', (args) => {
      if (args[0]?.toLowerCase() !== 'protocol' || args[1]?.toLowerCase() !== 'inbound') return '';
      const dev = this.swRef as unknown as { _setVtyTransportInput?: (t: 'ssh' | 'telnet' | 'all' | 'none') => void };
      const removed = (args[2] ?? '').toLowerCase();
      if (!dev._setVtyTransportInput) return '';
      if (removed === 'ssh') dev._setVtyTransportInput('telnet');
      else if (removed === 'telnet') dev._setVtyTransportInput('ssh');
      else dev._setVtyTransportInput('none');
      return '';
    });
    t.register('display this', 'Display user-interface configuration', () =>
      `user-interface ${this.uiLabel.replace(/(\D)(\d)/, '$1 $2')}`);
  }

  /** ACL sub-view ([host-acl-{basic|adv}-<id>]) — rule list. */
  private buildAclCommands(): void {
    const t = this.aclTrie;
    t.registerGreedy('rule', 'Configure an ACL rule', (args) => {
      if (!this.selectedAcl) return 'Error: Incomplete command.';
      this.acls.get(this.selectedAcl)?.rules.push(`rule ${args.join(' ')}`.trim());
      return '';
    });
    t.registerGreedy('description', 'ACL description', (args) => {
      if (!this.selectedAcl) return '';
      const acl = this.acls.get(this.selectedAcl);
      if (acl) (acl as unknown as { description?: string }).description = args.join(' ');
      return '';
    });
    t.registerGreedy('step', 'Set ACL rule step', (args) => {
      if (!this.selectedAcl) return '';
      const acl = this.acls.get(this.selectedAcl);
      if (acl) (acl as unknown as { step?: number }).step = parseInt(args[0] ?? '5', 10);
      return '';
    });
    t.registerGreedy('undo', 'ACL undo', (args) => {
      if (!this.selectedAcl) return '';
      const acl = this.acls.get(this.selectedAcl);
      if (!acl) return '';
      if (args[0] === 'rule' && args[1]) {
        const seq = parseInt(args[1], 10);
        if (!isNaN(seq)) {
          acl.rules = acl.rules.filter(r => !new RegExp(`^rule\\s+${seq}\\b`).test(r));
        }
      }
      return '';
    });
    t.register('display this', 'Display ACL configuration', () =>
      this.renderAcl(this.selectedAcl));
  }

  private renderAcl(key: string | null): string {
    if (!key) return '';
    const a = this.acls.get(key);
    if (!a) return `Error: The ACL ${key} does not exist.`;
    const kind = a.type === 'adv' ? 'advanced' : 'basic';
    return [`acl ${kind} ${a.key}`, ...a.rules.map(r => ` ${r}`)].join('\n');
  }

  // ─── Shared Display Commands ──────────────────────────────────────

  private registerDisplayCommands(trie: CommandTrie): void {
    trie.register('display version', 'Display VRP version information', () => {
      if (!this.swRef) return '';
      return this.displayVersion(this.swRef);
    });
    trie.register('display port-security', 'Display port-security status', () =>
      this.displayPortSecurity());

    // display vlan [summary | <id>]
    trie.registerGreedy('display vlan', 'Display VLAN information', (args) => {
      if (!this.swRef) return '';
      const full = this.displayVlan(this.swRef);
      if (args.length === 0) return full;
      if (args[0].toLowerCase() === 'summary') {
        const ids: number[] = [];
        for (const [id] of this.swRef.getVLANs()) ids.push(id);
        return [
          `The total number of vlans is : ${ids.length}`,
          `--------------------------------`,
          `static vlan:`,
          `Total ${ids.length} static vlan.`,
          ids.sort((a, b) => a - b).join(' '),
        ].join('\n');
      }
      const id = parseInt(args[0], 10);
      if (!isNaN(id)) {
        const lines = full.split('\n');
        const hit = lines.filter(l => new RegExp(`(^|\\s)${id}(\\s|$)`).test(l));
        return [lines[0] ?? '', ...(hit.length ? hit : [`VLAN ${id} not found`])].join('\n');
      }
      return full;
    });

    // display port vlan [active]
    trie.registerGreedy('display port vlan', 'Display port VLAN assignment', () => {
      if (!this.swRef) return '';
      const rows = ['Port                    Link Type    PVID  Trunk VLAN List'];
      for (const p of this.swRef.getPortNames()) {
        const cfg = this.swRef.getSwitchportConfig(p);
        if (!cfg) continue;
        const pvid = cfg.mode === 'trunk' ? cfg.trunkNativeVlan : cfg.accessVlan;
        rows.push(`${p.padEnd(24)}${cfg.mode.padEnd(13)}${String(pvid).padEnd(6)}-`);
      }
      return rows.join('\n');
    });

    trie.register('display interface brief', 'Display interface summary', () => {
      if (!this.swRef) return '';
      return this.displayInterfaceBrief(this.swRef);
    });

    trie.registerGreedy('display interface', 'Display interface details', (args) => {
      if (!this.swRef) return '';
      if (args.length === 0) return this.displayInterfaceBrief(this.swRef);
      return this.displayInterface(this.swRef, args.join(' '));
    });

    trie.register('display ip routing-table', 'Display IP routing table', () => {
      if (!this.swRef) return '';
      const rows = this.swRef.getL3RoutingTable();
      const header = 'Route Flags: R - relay, D - download to fib\n' +
        '------------------------------------------------------------------------------\n' +
        'Routing Tables: Public\n' +
        `         Destinations : ${rows.length}       Routes : ${rows.length}\n\n` +
        'Destination/Mask    Proto   Pre  Cost      Flags NextHop         Interface\n';
      const lines = rows.map(r => {
        const dest = `${r.network}/${r.mask.toCIDR()}`.padEnd(20);
        const proto = (r.proto === 'connected' ? 'Direct' : 'Static').padEnd(8);
        const pre = (r.proto === 'connected' ? '0' : '60').padEnd(5);
        const nh = (r.nextHop ? r.nextHop.toString() : r.network.toString()).padEnd(16);
        return `${dest}${proto}${pre}0         D     ${nh}${r.iface}`;
      });
      return header + lines.join('\n');
    });

    trie.register('display mac-address aging-time', 'Display MAC aging time', () => {
      if (!this.swRef) return '';
      return this.displayMacAgingTime(this.swRef);
    });

    // display mac-address [vlan <id> | <if> | dynamic | static]
    trie.registerGreedy('display mac-address', 'Display MAC address table', (args) => {
      if (!this.swRef) return '';
      const full = this.displayMacAddress(this.swRef);
      if (args.length === 0) return full;
      if (args[0].toLowerCase() === 'vlan' && args[1]) {
        const id = args[1];
        const lines = full.split('\n');
        const head = lines.slice(0, 2);
        const body = lines.slice(2).filter(l =>
          new RegExp(`\\b${id}\\b`).test(l));
        return [...head, ...body].join('\n');
      }
      return full;
    });

    trie.register('display current-configuration', 'Display running configuration', () => {
      if (!this.swRef) return '';
      return this.displayCurrentConfig(this.swRef);
    });

    trie.registerGreedy('display current-configuration interface', 'Display interface configuration', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      return this.displayCurrentConfigInterface(this.swRef, args.join(' '));
    });

    // display current-configuration configuration <module>  (vlan, …)
    trie.registerGreedy('display current-configuration configuration', 'Display module configuration', (args) => {
      if (!this.swRef) return '';
      const full = this.displayCurrentConfig(this.swRef);
      const mod = (args[0] ?? '').toLowerCase();
      if (mod === 'vlan') {
        const block = full.split('\n').filter(l => /vlan/i.test(l));
        return block.length ? block.join('\n') : '#';
      }
      return full;
    });

    // L2 switch: only the management interface has an IP. Recognised so
    // the command doesn't error (no Vlanif/L3 routing on an L2 switch).
    trie.register('display ip interface brief', 'Display IP interface brief', () => {
      const host = this.swRef?.getHostname() ?? 'SW';
      return [
        `*down: administratively down`,
        `Interface                   IP Address/Mask      Physical   Protocol`,
        `MEth0/0/1                   unassigned           down       down`,
        `(${host}: L2 switch — no Vlanif/L3 interfaces)`,
      ].join('\n');
    });

    // ── Common VRP display commands (shared with the router, DRY) ──
    trie.register('display clock', 'Display system clock', () => displayClock());
    trie.register('display cpu-usage', 'Display CPU usage', () => displayCpuUsage());
    trie.register('display memory-usage', 'Display memory usage', () => displayMemoryUsage());
    trie.register('display users', 'Display user sessions', () => displayUsers());
    trie.register('display device', 'Display device status', () =>
      this.swRef ? displayDevice(this.swRef.getHostname()) : '');
    trie.register('display history-command', 'Display command history', () =>
      displayHistoryCommand(this.history));

    // `display this` — running config of the CURRENT view only.
    trie.register('display this', 'Display active view configuration', () => {
      if (!this.swRef) return '';
      if (this.mode === 'interface' && this.selectedInterface) {
        const etm = this.selectedInterface.match(/^Eth-Trunk(\d+)$/);
        if (etm) return this.displayEthTrunkConfig(parseInt(etm[1], 10));
        return this.displayCurrentConfigInterface(this.swRef, this.selectedInterface);
      }
      return this.displayCurrentConfig(this.swRef);
    });

    // `display saved-configuration` / `display startup` — mirror running
    // config (the sim has no separate flash image).
    trie.register('display saved-configuration', 'Display saved configuration', () =>
      this.swRef ? this.displayCurrentConfig(this.swRef) : '');
    trie.register('display startup', 'Display startup configuration', () =>
      this.swRef ? this.displayCurrentConfig(this.swRef) : '');

    // Informational displays (shared with the router, DRY).
    trie.register('display alarm', 'Display alarm records', () => displayAlarm());
    trie.register('display elabel', 'Display electronic label', () =>
      this.swRef ? displayElabel(this.swRef.getHostname()) : '');
    trie.register('display license', 'Display license information', () => displayLicense());
    trie.register('display logbuffer', 'Display log buffer', () => displayLogbuffer());
    trie.register('display trapbuffer', 'Display trap buffer', () => displayTrapbuffer());
    trie.register('display patch-information', 'Display patch information', () =>
      displayPatchInformation());
    trie.register('display diagnostic-information', 'Collect diagnostic information', () =>
      displayDiagnosticInformation());

    // STP display family (switch-only).
    this.registerStpDisplay(trie);

    // Shared management `display` commands (DRY).
    registerHuaweiCommonSecurityDisplay(trie, () => this.localUsers);

    // display acl {all | <number|name>}
    trie.registerGreedy('display acl', 'Display ACL configuration', (args) => {
      if (this.acls.size === 0) return 'Info: No ACL is configured.';
      const sel = (args[0] ?? 'all').toLowerCase();
      if (sel === 'all') {
        return [...this.acls.keys()].map(k => this.renderAcl(k)).join('\n');
      }
      return this.renderAcl(this.acls.has(args[0]) ? args[0] : sel);
    });

    // Eth-Trunk + counters.
    trie.registerGreedy('display igmp-snooping', 'Display IGMP snooping state', (args) => {
      const agent = (this.swRef as unknown as { getIgmpSnoopingAgent?: () => import('@/network/igmp-snooping/IgmpSnoopingAgent').IgmpSnoopingAgent } | null)?.getIgmpSnoopingAgent?.();
      if (!agent) return '';
      const vlans = agent.listVlans();
      if (args[0] === 'group') {
        const vIdx = args.indexOf('vlan');
        const filter = vIdx >= 0 ? parseInt(args[vIdx + 1] ?? '', 10) : NaN;
        const rows: string[] = [];
        for (const { vlan, group } of agent.listGroups(Number.isNaN(filter) ? undefined : filter)) {
          rows.push(` Group address: ${group.group}`);
          rows.push(`  VLAN ID: ${vlan}`);
          rows.push(`  Member ports: ${[...group.memberPorts].join(' ') || '(none)'}`);
        }
        return rows.length ? rows.join('\n') : 'Info: No multicast group entry is found.';
      }
      if (vlans.length === 0) return 'Info: IGMP snooping is not enabled on any VLAN.';
      const cfg = agent.getConfig();
      const lines: string[] = [];
      for (const v of vlans) {
        lines.push(`VLAN ID: ${v.vlan}`);
        lines.push(`  IGMP snooping: ${v.enabled ? 'enabled' : 'disabled'}`);
        lines.push(`  Immediate leave: ${cfg.immediateLeave.has(v.vlan) ? 'enabled' : 'disabled'}`);
        lines.push(`  Router ports: ${[...v.routerPorts].join(' ') || '(none)'}`);
      }
      return lines.join('\n');
    });
    trie.registerGreedy('display eth-trunk', 'Display Eth-Trunk information', (args) => {
      const id = parseInt(args[0] ?? '', 10);
      if (isNaN(id)) {
        if (this.ethTrunks.size === 0) return 'Info: No Eth-Trunk is configured.';
        return [...this.ethTrunks.keys()].map(k => this.displayEthTrunk(k)).join('\n\n');
      }
      return this.displayEthTrunk(id);
    });
    trie.registerGreedy('display counters', 'Display interface counters', (args) => {
      if (!this.swRef) return '';
      const ifName = args.filter(a => /\d\/\d/.test(a)).join(' ');
      const port = ifName ? (this.resolveInterfaceName(ifName) || ifName) : 'all interfaces';
      return [
        `Interface counters (${port}):`,
        '  Input :  0 packets,  0 bytes,  0 errors',
        '  Output:  0 packets,  0 bytes,  0 errors',
      ].join('\n');
    });
    trie.registerGreedy('reset counters', 'Clear interface counters', () =>
      ''); // acknowledged, no output (matches VRP)
  }

  /**
   * VRP lifecycle / management commands common to every view + the
   * router shell (save, reboot, reset, commit, screen-length, header).
   * Single source via huawei/HuaweiCommonConfig (DRY).
   */
  private registerCommonMgmt(trie: CommandTrie): void {
    registerHuaweiCommonMgmt(trie);
  }

  // ─── STP / RSTP / MSTP (switch-only, L2) ──────────────────────────

  /** System-view `stp …` configuration commands. */
  private registerStpSystemCommands(trie: CommandTrie): void {
    trie.registerGreedy('stp', 'Spanning Tree Protocol configuration', (args) => {
      const a = args.map(s => s.toLowerCase());
      if (a.length === 0) return 'Error: Incomplete command.';

      switch (a[0]) {
        case 'enable':
          this.stp.enabled = true;
          this.applyToStpAgent(ag => ag.setEnabled(true));
          return '';
        case 'disable':
          this.stp.enabled = false;
          this.applyToStpAgent(ag => ag.setEnabled(false));
          return '';
        case 'mode': {
          const m = a[1];
          if (m !== 'stp' && m !== 'rstp' && m !== 'mstp') {
            return 'Error: Wrong parameter found at \'^\' position.';
          }
          this.stp.mode = m;
          this.applyToStpAgent(ag => ag.setMode(m === 'stp' ? 'stp' : 'rstp'));
          return '';
        }
        case 'priority': {
          const p = parseInt(a[1], 10);
          if (isNaN(p) || p < 0 || p > 61440 || p % 4096 !== 0) {
            return 'Error: Wrong parameter found at \'^\' position.';
          }
          this.stp.priority = p;
          this.applyToStpAgent(ag => ag.setBridgePriority(p));
          return '';
        }
        case 'root':
          if (a[1] === 'primary') {
            this.stp.root = 'primary'; this.stp.priority = 0;
            this.applyToStpAgent(ag => ag.setBridgePriority(0));
            return '';
          }
          if (a[1] === 'secondary') {
            this.stp.root = 'secondary'; this.stp.priority = 4096;
            this.applyToStpAgent(ag => ag.setBridgePriority(4096));
            return '';
          }
          return 'Error: Wrong parameter found at \'^\' position.';
        case 'bpdu-protection':
          this.stp.bpduProtection = true;
          return '';
        case 'edged-port':
          if (a[1] !== 'default') return 'Error: Wrong parameter found at \'^\' position.';
          this.stp.edgedPortDefault = true;
          return '';
        case 'pathcost-standard':
        case 'tc-protection':
        case 'converge':
        case 'timer':
          return ''; // accepted, no behavioural effect in the sim
        case 'region-configuration':
          this.mode = 'mst-region';
          return '';
        default:
          return `Error: Unrecognized command "stp ${args.join(' ')}"`;
      }
    });
  }

  /** Interface-view `stp …` configuration commands. */
  private registerStpInterfaceCommands(trie: CommandTrie): void {
    trie.registerGreedy('stp', 'Interface STP configuration', (args) => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const a = args.map(s => s.toLowerCase());
      if (a.length === 0) return 'Error: Incomplete command.';
      const valid = new Set(['edged-port', 'bpdu-protection', 'cost',
        'port', 'disable', 'enable', 'bpdu-filter', 'loop-protection',
        'root-protection', 'tc-restriction']);
      if (!valid.has(a[0])) {
        return `Error: Unrecognized command "stp ${args.join(' ')}"`;
      }
      // Persist a normalised line for `display this`.
      const list = this.ifStp.get(this.selectedInterface) ?? [];
      list.push(`stp ${args.join(' ')}`);
      this.ifStp.set(this.selectedInterface, list);
      return '';
    });
  }

  /**
   * Interface-view physical / security config commands. Most are
   * "accept, validate loosely, persist for `display this`" — the L2
   * sim does not model PHY rate negotiation, so storing the intent is
   * the faithful behaviour.
   */
  private registerInterfacePhysicalCommands(trie: CommandTrie): void {
    const record = (line: string) => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const list = this.ifCfg.get(this.selectedInterface) ?? [];
      list.push(line);
      this.ifCfg.set(this.selectedInterface, list);
      return '';
    };
    // Simple keyword commands that take the rest of the line verbatim.
    // L2/physical interface keywords only — an L2 switch port must NOT
    // accept L3 (ip/arp) config, so those are deliberately excluded.
    for (const kw of [
      'speed', 'duplex', 'negotiation', 'mtu', 'jumboframe', 'flow-control',
      'loopback-detect', 'port-security', 'storm-control',
      'broadcast-suppression', 'port-isolate', 'port-mirroring',
      'trust', 'qos', 'traffic-policy', 'traffic-filter', 'am',
      'mac-limit',
    ]) {
      trie.registerGreedy(kw, `Interface ${kw} configuration`, (args) =>
        record(`${kw} ${args.join(' ')}`.trim()));
    }
  }

  /** MST region sub-view command tree ([host-mst-region]). */
  private buildMstRegionCommands(): void {
    const t = this.mstRegionTrie;
    t.registerGreedy('region-name', 'Set MST region name', (args) => {
      if (args.length < 1) return 'Error: Incomplete command.';
      this.mstRegion.name = args[0];
      return '';
    });
    t.registerGreedy('instance', 'Map VLANs to an MST instance', (args) => {
      if (args.length < 3 || args[1].toLowerCase() !== 'vlan') {
        return 'Error: Incomplete command.';
      }
      const id = parseInt(args[0], 10);
      if (isNaN(id)) return 'Error: Wrong parameter found at \'^\' position.';
      this.mstRegion.instances.set(id, args.slice(2).join(' '));
      return '';
    });
    t.registerGreedy('revision-level', 'Set MST revision level', (args) => {
      const n = parseInt(args[0], 10);
      if (!isNaN(n)) this.mstRegion.revision = n;
      return '';
    });
    t.register('active region-configuration', 'Activate MST region', () => {
      (this.mstRegion as unknown as { activated?: boolean; activatedAtMs?: number }).activated = true;
      (this.mstRegion as unknown as { activatedAtMs?: number }).activatedAtMs = Date.now();
      return 'Info: This operation may take a few seconds. Please wait for a moment...done.';
    });
    t.register('check region-configuration', 'Check MST region', () => {
      const region = this.mstRegion as unknown as { name?: string; revision?: number; vlanMap?: Map<number, number> };
      const lines = [
        `Region Name: ${region.name ?? ''}`,
        `Revision Level: ${region.revision ?? 0}`,
        `Instance Vlans Mapped`,
      ];
      if (region.vlanMap) {
        for (const [instance, vlans] of region.vlanMap as unknown as Map<number, number[]>) {
          lines.push(`${String(instance).padEnd(8)} ${Array.isArray(vlans) ? vlans.join(',') : vlans}`);
        }
      }
      return lines.join('\n');
    });
    t.register('display this', 'Display MST region configuration', () => {
      const lines = ['stp region-configuration'];
      if (this.mstRegion.name) lines.push(` region-name ${this.mstRegion.name}`);
      for (const [id, v] of this.mstRegion.instances) {
        lines.push(` instance ${id} vlan ${v}`);
      }
      lines.push('#');
      return lines.join('\n');
    });
  }

  /** `display stp` family — rendered from shell-tracked config + ports. */
  private registerStpDisplay(trie: CommandTrie): void {
    trie.register('display stp', 'Display STP status', () => this.displayStp());
    trie.register('display stp global', 'Display STP global info', () => this.displayStp());
    trie.register('display stp brief', 'Display STP brief', () => this.displayStpBrief());
    trie.register('display stp mode', 'Display STP working mode', () =>
      `STP mode: ${this.stp.mode.toUpperCase()}`);
    trie.register('display stp topology-change', 'Display STP topology changes', () => [
      'CIST topology change information',
      '  Number of topology changes        : 0',
      '  Time since last topology change   : 0 days 0h:0m:0s',
      '  Last topology change port         : -',
    ].join('\n'));
    trie.register('display stp region-configuration', 'Display MST region configuration', () => {
      const lines = [
        'Oper configuration',
        `  Format selector      :0`,
        `  Region name          :${this.mstRegion.name || (this.swRef?.getHostname() ?? '')}`,
        `  Revision level       :${this.mstRegion.revision}`,
        '',
        '  Instance   VLANs Mapped',
        '  0          1 to 4094',
      ];
      for (const [id, v] of this.mstRegion.instances) lines.push(`  ${String(id).padEnd(11)}${v}`);
      return lines.join('\n');
    });
    trie.registerGreedy('display lldp neighbor', 'Display LLDP neighbours', (args) => {
      if (!this.swRef) return '';
      const ag = (this.swRef as unknown as { getLldpAgent?: () => import('@/network/lldp/LldpAgent').LldpAgent }).getLldpAgent?.();
      if (!ag) return '';
      const ns = ag.getNeighbors();
      const brief = args.some(a => a.toLowerCase() === 'brief');
      if (brief) {
        const lines = ['Local Intf                Neighbor Dev    Neighbor Intf   Exptime(s)'];
        for (const n of ns) {
          const remain = Math.max(0, Math.floor((n.expiresAtMs - Date.now()) / 1000));
          lines.push(`${n.localPort.padEnd(25)} ${n.systemName.padEnd(15)} ${n.portId.padEnd(15)} ${remain}`);
        }
        lines.push(`Total: ${ns.length}`);
        return lines.join('\n');
      }
      const lines: string[] = [];
      for (const n of ns) {
        lines.push(`${n.localPort} has 1 neighbor(s):`);
        lines.push(`  Neighbor index : 1`);
        lines.push(`  Chassis type   : MAC address`);
        lines.push(`  Chassis ID     : ${n.chassisId}`);
        lines.push(`  Port ID type   : Interface name`);
        lines.push(`  Port ID        : ${n.portId}`);
        lines.push(`  Port description: ${n.portDescription}`);
        lines.push(`  System name    : ${n.systemName}`);
        lines.push(`  System description:`);
        lines.push(`  ${n.systemDescription}`);
        const remain = Math.max(0, Math.floor((n.expiresAtMs - Date.now()) / 1000));
        lines.push(`  Expired time   : ${remain} s`);
        lines.push('');
      }
      lines.push(`Total: ${ns.length}`);
      return lines.join('\n');
    });
    trie.register('display lldp local', 'Display LLDP local info', () => {
      if (!this.swRef) return '';
      const ag = (this.swRef as unknown as { getLldpAgent?: () => import('@/network/lldp/LldpAgent').LldpAgent }).getLldpAgent?.();
      const cfg = ag?.getConfig();
      return [
        'Local LLDP information:',
        `System name      : ${this.swRef.getHostname()}`,
        `LLDP status      : ${cfg?.enabled ? 'enabled' : 'disabled'}`,
        `Message tx interval : ${cfg?.timerSec ?? 30} s`,
        `Message tx hold-multiplier : ${cfg?.holdtimeMultiplier ?? 4}`,
        `Reinit delay : ${cfg?.reinitDelaySec ?? 2} s`,
      ].join('\n');
    });
    trie.registerGreedy('display stp interface', 'Display STP for an interface', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      return this.displayStpBrief(this.resolveInterfaceName(args.join(' ')) || args.join(' '));
    });
    trie.registerGreedy('display stp instance', 'Display STP for an MST instance', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      const id = parseInt(args[0], 10);
      if (isNaN(id) || id < 0 || id > 4094) return 'Error: Wrong parameter found.';
      if (id !== 0 && !this.mstRegion.instances.has(id)) {
        return `Error: The instance ${id} does not exist.`;
      }
      return this.displayStpBrief(undefined, id);
    });
  }

  private displayStp(): string {
    const modeName = this.stp.mode.toUpperCase();
    const ag = (this.swRef as unknown as { getStpAgent?: () => import('@/network/stp/StpAgent').StpAgent } | undefined)?.getStpAgent?.();
    const root = ag?.getRootBridge();
    const cfg = ag?.getConfig();
    const rootPort = ag?.getRootPort();
    const own = ag?.ownBridgeId();
    const helloSec = cfg?.helloSec ?? 2;
    const maxAgeSec = cfg?.maxAgeSec ?? 20;
    const fwDelaySec = cfg?.forwardDelaySec ?? 15;
    const rootCost = ag?.getRootPathCost() ?? 0;
    const localPrio = own?.priority ?? this.stp.priority;
    const localMacFmt = own ? own.mac.replace(/(.{2})(.{2})(.{2})(.{2})(.{2})(.{2})/, '$1$2-$3$4-$5$6') : '0000-0000-0000';
    const rootMacFmt = root ? root.mac.replace(/(.{2})(.{2})(.{2})(.{2})(.{2})(.{2})/, '$1$2-$3$4-$5$6') : localMacFmt;
    const rootPrio = root?.priority ?? localPrio;
    const portNames = this.swRef?.getPortNames() ?? [];
    const rootPortIdx = rootPort ? portNames.indexOf(rootPort) : -1;
    const rootPortId = rootPortIdx >= 0 ? `${rootPortIdx + 1}.${rootPortIdx + 1}` : '0.0';
    return [
      `-------[CIST Global Info][Mode ${modeName}]-------`,
      `CIST Bridge         :${localPrio}.${this.swRef?.getHostname() ?? ''}`,
      `Config Times        :Hello ${helloSec}s MaxAge ${maxAgeSec}s FwDly ${fwDelaySec}s MaxHop 20`,
      `Active Times        :Hello ${helloSec}s MaxAge ${maxAgeSec}s FwDly ${fwDelaySec}s MaxHop 20`,
      `CIST Root/ERPC      :${rootPrio}.${rootMacFmt} / ${rootCost}`,
      `CIST RegRoot/IRPC   :${rootPrio}.${rootMacFmt} / 0`,
      `CIST RootPortId     :${rootPortId}`,
      `BPDU-Protection     :${this.stp.bpduProtection ? 'Enabled' : 'Disabled'}`,
      `TC or TCN received  :0`,
      `STP Status          :${this.stp.enabled ? 'Enabled' : 'Disabled'}`,
    ].join('\n');
  }

  private toHuaweiMac(mac?: string): string {
    if (!mac) return '0000-0000-0000';
    const hex = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase().padStart(12, '0').slice(0, 12);
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
  }

  private huaweiPortId(portName: string): string {
    const names = this.swRef?.getPortNames() ?? [];
    const idx = names.indexOf(portName);
    return `128.${idx >= 0 ? idx + 1 : 0}`;
  }

  private psecPort() {
    if (!this.swRef || !this.selectedInterface) return null;
    return this.swRef.getPort(this.selectedInterface)?.getPortSecurity() ?? null;
  }

  private recordIfCfg(line: string): void {
    if (!this.selectedInterface) return;
    const list = this.ifCfg.get(this.selectedInterface) ?? [];
    list.push(line);
    this.ifCfg.set(this.selectedInterface, list);
  }

  private parsePsecMac(s: string): MACAddress | null {
    const m = s.match(/^([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})$/);
    try {
      if (!m) return new MACAddress(s);
      const octets = (m[1] + m[2] + m[3]).match(/.{2}/g)!.map((h) => parseInt(h, 16));
      return new MACAddress(octets);
    } catch {
      return null;
    }
  }

  private registerDot1x(): void {
    const it = this.interfaceTrie;
    const portModeMap: Record<string, import('@/network/dot1x/types').Dot1xPortMode> = {
      auto: 'auto',
      'authorized-force': 'force-authorized',
      'unauthorized-force': 'force-unauthorized',
    };
    it.register('dot1x enable', 'Enable 802.1X on this interface', () => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const iface = this.selectedInterface;
      this.applyToDot1xAgent(a => a.setPortMode(iface, 'auto'));
      this.recordIfCfg('dot1x enable');
      return '';
    });
    it.register('undo dot1x enable', 'Disable 802.1X on this interface', () => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const iface = this.selectedInterface;
      this.applyToDot1xAgent(a => a.setPortMode(iface, 'disabled'));
      return '';
    });
    it.registerGreedy('dot1x port-control', '802.1X port control mode', (args) => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const mode = portModeMap[(args[0] ?? '').toLowerCase()];
      if (!mode) return 'Error: Wrong parameter.';
      const iface = this.selectedInterface;
      this.applyToDot1xAgent(a => a.setPortMode(iface, mode));
      this.recordIfCfg(`dot1x port-control ${args[0].toLowerCase()}`);
      return '';
    });
  }

  private registerPortSecurity(): void {
    const it = this.interfaceTrie;
    it.register('port-security enable', 'Enable port security', () => {
      const sec = this.psecPort();
      if (!sec) return 'Error: Incomplete command.';
      sec.enable();
      this.recordIfCfg('port-security enable');
      return '';
    });
    it.register('undo port-security enable', 'Disable port security', () => {
      const sec = this.psecPort();
      if (!sec) return 'Error: Incomplete command.';
      sec.disable();
      return '';
    });
    it.registerGreedy('port-security max-mac-num', 'Max secure MAC count', (args) => {
      const sec = this.psecPort();
      if (!sec) return 'Error: Incomplete command.';
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 1) return 'Error: Wrong parameter.';
      sec.setMaxMACAddresses(n);
      this.recordIfCfg(`port-security max-mac-num ${n}`);
      return '';
    });
    it.registerGreedy('port-security protect-action', 'Violation action', (args) => {
      const sec = this.psecPort();
      if (!sec) return 'Error: Incomplete command.';
      const a = (args[0] ?? '').toLowerCase();
      if (a !== 'protect' && a !== 'restrict' && a !== 'shutdown') return 'Error: Wrong parameter.';
      sec.setViolationMode(a as PortViolationMode);
      this.recordIfCfg(`port-security protect-action ${a}`);
      return '';
    });
    it.registerGreedy('port-security mac-address sticky', 'Sticky secure MAC', (args) => {
      const sec = this.psecPort();
      if (!sec) return 'Error: Incomplete command.';
      if (args.length === 0) {
        sec.enableSticky();
        this.recordIfCfg('port-security mac-address sticky');
        return '';
      }
      const mac = this.parsePsecMac(args[0]);
      if (!mac) return 'Error: Wrong parameter.';
      const vlanIdx = args.indexOf('vlan');
      const vlan = vlanIdx >= 0 ? parseInt(args[vlanIdx + 1] ?? '1', 10) : 1;
      sec.addStickyMAC(mac, isNaN(vlan) ? 1 : vlan);
      return '';
    });
    it.register('undo port-security mac-address sticky', 'Disable sticky', () => {
      const sec = this.psecPort();
      if (!sec) return 'Error: Incomplete command.';
      sec.disableSticky();
      return '';
    });
  }

  private displayPortSecurity(): string {
    if (!this.swRef) return '';
    const header = 'Port-security    MaxMac  Action     Sticky  Secure  Violations  Port';
    const rows: string[] = [];
    for (const name of this.swRef.getPortNames()) {
      const sec = this.swRef.getPort(name)?.getPortSecurity();
      if (!sec || !sec.isEnabled()) continue;
      const action = sec.getViolationMode().padEnd(10);
      const sticky = (sec.isStickyEnabled() ? 'Yes' : 'No').padEnd(6);
      const secure = String(sec.getEntries().length).padEnd(7);
      const viol = String(sec.getViolationCount()).padEnd(11);
      rows.push(`Enabled          ${String(sec.getMaxMACAddresses()).padEnd(7)} ${action} ${sticky}  ${secure} ${viol} ${name}`);
    }
    if (rows.length === 0) return 'Port-security is not enabled on any interface.';
    return [header, ...rows].join('\n');
  }

  private displayStpBrief(only?: string, mstid = 0): string {
    if (!this.swRef) return '';
    const ag = (this.swRef as unknown as { getStpAgent?: () => import('@/network/stp/StpAgent').StpAgent }).getStpAgent?.();
    const header = ' MSTID  Port                        Role  STP State     Protection';
    const mst = String(mstid).padStart(6);
    const rows: string[] = [];
    for (const p of this.swRef.getPortNames()) {
      if (only && p !== only) continue;
      const st = this.swRef.getSTPState(p);
      const state = st === 'forwarding' ? 'FORWARDING'
        : st === 'blocking' ? 'DISCARDING'
        : st === 'disabled' ? 'DISCARDING' : st.toUpperCase();
      const r = ag?.getPortRole(p) ?? 'designated';
      const role = r === 'root' ? 'ROOT' : r === 'alternate' ? 'ALTE'
        : r === 'backup' ? 'BACK' : r === 'disabled' ? 'DISA' : 'DESI';
      rows.push(`${mst}  ${p.padEnd(27)} ${role}  ${state.padEnd(13)} NONE`);
    }
    if (only && rows.length === 0) {
      return `Error: The port ${only} does not exist.`;
    }
    return [header, ...rows].join('\n');
  }

  /** `display this` body for an Eth-Trunk interface view. */
  private displayEthTrunkConfig(id: number): string {
    const t = this.ethTrunks.get(id);
    if (!t) return `Error: The Eth-Trunk ${id} does not exist.`;
    const lines = [`interface Eth-Trunk${id}`, ...t.cfg.map(c => ` ${c}`)];
    lines.push('#');
    return lines.join('\n');
  }

  /** `display eth-trunk <id>` — bundle summary + member list. */
  private displayEthTrunk(id: number): string {
    const t = this.ethTrunks.get(id);
    if (!t) return `Error: The Eth-Trunk ${id} does not exist.`;
    const agent = (this.swRef as unknown as { getLacpAgent?: () => import('@/network/lacp/LacpAgent').LacpAgent } | null)?.getLacpAgent?.();
    const liveMembers = agent ? agent.getGroupMembers(id) : [];
    const liveByPort = new Map(liveMembers.map(m => [m.portName, m] as const));
    const upCount = liveMembers.filter(m => m.bundled).length;
    const operate = upCount > 0 ? 'up' : 'down';
    const lines = [
      `Eth-Trunk${id}'s state information is:`,
      `WorkingMode: ${t.mode.toUpperCase()}`,
      `Least Active-linknumber: 1   Max Active-linknumber: ${t.members.length || 8}`,
      `Operate status: ${operate}   Number Of Up Ports In Trunk: ${upCount}`,
      '--------------------------------------------------------------------------------',
      'PortName                      Status      Weight',
      ...t.members.map(m => {
        const info = liveByPort.get(m);
        const status = info?.bundled ? 'Up' : 'Down';
        return `${m.padEnd(30)}${status.padEnd(12)}1`;
      }),
    ];
    return lines.join('\n');
  }

  // ─── Undo Command ────────────────────────────────────────────────

  private cmdUndo(args: string[]): string {
    if (args.length < 1 || !this.swRef) return 'Error: Incomplete command.';

    if (args[0].toLowerCase() === 'vlan') {
      if (args.length < 2) return 'Error: Incomplete command.';
      const id = parseInt(args[1], 10);
      if (isNaN(id)) return 'Error: Wrong parameter.';
      if (id === 1) return 'Error: Default VLAN 1 cannot be deleted.';
      return this.swRef.deleteVLAN(id) ? '' : `Error: VLAN ${id} does not exist.`;
    }

    if (args[0].toLowerCase() === 'shutdown') {
      if (this.selectedInterface) {
        const port = this.swRef.getPort(this.selectedInterface);
        if (port) port.setUp(true);
        return '';
      }
      return '';
    }

    if (args[0].toLowerCase() === 'description') {
      if (this.mode === 'interface' && this.selectedInterface) {
        this.swRef.setInterfaceDescription(this.selectedInterface, '');
      } else if (this.mode === 'vlan' && this.selectedVlan !== null) {
        this.vlanDesc.delete(this.selectedVlan);
      }
      return '';
    }

    // VRP accepts `undo` of essentially any prior config. The L2 sim
    // doesn't reverse every feature's datapath, but the command must be
    // recognised (returning an error here derails command sequences).
    return '';
  }

  // ─── Display Implementations ──────────────────────────────────────

  private displayVersion(sw: Switch): string {
    return [
      'Huawei Versatile Routing Platform Software',
      'VRP (R) software, Version 5.170 (S5720 V200R019C10SPC500)',
      'Copyright (C) 2000-2025 HUAWEI TECH CO., LTD',
      '',
      `BOARD TYPE:          S5720-28X-LI-AC`,
      `CPLD Version:        1.0`,
      `BootROM Version:     1.0`,
      `${sw.getHostname()} uptime is 0 days, 0 hours, 0 minutes`,
    ].join('\n');
  }

  private displayVlan(sw: Switch): string {
    const vlans = sw.getVLANs();
    const configs = sw._getSwitchportConfigs();

    const lines = [
      'VLAN ID  Name                          Status   Ports',
      '-------  ----------------------------  -------  ----------------------------',
    ];

    for (const [id, vlan] of vlans) {
      const name = vlan.name.padEnd(30);
      const portsInVlan: string[] = [];
      for (const [portName, cfg] of configs) {
        if (cfg.mode === 'access' && cfg.accessVlan === id) {
          portsInVlan.push(portName);
        }
      }
      const portsStr = portsInVlan.join(', ');
      lines.push(`${String(id).padEnd(9)}${name}active   ${portsStr}`);
    }

    return lines.join('\n');
  }

  private displayInterfaceBrief(sw: Switch): string {
    const ports = sw._getPortsInternal();

    const lines = ['Interface                     PHY     Protocol  InUti  OutUti'];
    for (const [portName, port] of ports) {
      const phys = port.getIsUp() ? (port.isConnected() ? 'up' : 'down') : 'down';
      const proto = port.getIsUp() ? (port.isConnected() ? 'up' : 'down') : 'down';
      lines.push(`${portName.padEnd(30)}${phys.padEnd(8)}${proto.padEnd(10)}0%     0%`);
    }
    return lines.join('\n');
  }

  private displayInterface(sw: Switch, ifName: string): string {
    const portName = this.resolveInterfaceName(ifName) || ifName;
    const port = sw.getPort(portName);
    if (!port) return `Error: Wrong parameter found at '^' position.`;

    const desc = sw.getInterfaceDescription(portName) || '';
    const isUp = port.getIsUp();
    const isConn = port.isConnected();

    return [
      `${portName} current state : ${isUp ? (isConn ? 'UP' : 'DOWN') : 'Administratively DOWN'}`,
      `Line protocol current state : ${isConn ? 'UP' : 'DOWN'}`,
      `Description: ${desc}`,
      `The Maximum Transmit Unit is 1500`,
      `Internet protocol processing : disabled`,
      `Input:  0 packets, 0 bytes`,
      `Output: 0 packets, 0 bytes`,
    ].join('\n');
  }

  private displayMacAddress(sw: Switch): string {
    const entries = sw.getMACTable();
    const lines = [
      'MAC address table of slot 0:',
      '-------------------------------------------------------------------------------',
      'MAC Address    VLAN/VSI   Learned-From   Type',
      '-------------------------------------------------------------------------------',
    ];

    if (entries.length === 0) {
      lines.push('No entries found.');
    } else {
      for (const e of entries) {
        lines.push(`${e.mac.padEnd(15)}${String(e.vlan).padEnd(11)}${e.port.padEnd(15)}${e.type}`);
      }
    }

    lines.push('-------------------------------------------------------------------------------');
    lines.push(`Total items displayed = ${entries.length}`);
    return lines.join('\n');
  }

  private displayMacAgingTime(sw: Switch): string {
    return `Aging time: ${sw.getMACAgingTime()} seconds`;
  }

  private displayCurrentConfig(sw: Switch): string {
    const lines = [
      '#',
      `sysname ${sw.getHostname()}`,
      '#',
    ];

    // VLANs
    for (const [id, vlan] of sw.getVLANs()) {
      if (id === 1) continue;
      lines.push(`vlan ${id}`);
      lines.push(` name ${vlan.name}`);
      lines.push('#');
    }

    // Interfaces
    const ports = sw._getPortsInternal();
    const configs = sw._getSwitchportConfigs();
    const descs = sw._getInterfaceDescriptions();
    for (const [portName, port] of ports) {
      const cfg = configs.get(portName);
      if (!cfg) continue;

      lines.push(`interface ${portName}`);
      const desc = descs.get(portName);
      if (desc) lines.push(` description ${desc}`);
      if (cfg.mode === 'trunk') {
        lines.push(` port link-type trunk`);
        if (cfg.trunkNativeVlan !== 1) {
          lines.push(` port trunk pvid vlan ${cfg.trunkNativeVlan}`);
        }
        const allowedArr = Array.from(cfg.trunkAllowedVlans).sort((a, b) => a - b);
        if (allowedArr.length >= 4094) {
          lines.push(` port trunk allow-pass vlan all`);
        } else if (allowedArr.length === 0) {
          lines.push(` port trunk allow-pass vlan none`);
        } else {
          lines.push(` port trunk allow-pass vlan ${allowedArr.join(' ')}`);
        }
      } else {
        lines.push(` port link-type access`);
        if (cfg.accessVlan !== 1) {
          lines.push(` port default vlan ${cfg.accessVlan}`);
        }
      }
      if (!port.getIsUp()) lines.push(` shutdown`);
      lines.push('#');
    }

    lines.push('return');
    return lines.join('\n');
  }

  private displayCurrentConfigInterface(sw: Switch, ifName: string): string {
    const portName = this.resolveInterfaceName(ifName) || ifName;
    const port = sw.getPort(portName);
    const cfg = sw.getSwitchportConfig(portName);
    if (!port || !cfg) return `Error: Wrong parameter found at '^' position.`;

    const lines = [`interface ${portName}`];
    const desc = sw.getInterfaceDescription(portName);
    if (desc) lines.push(` description ${desc}`);
    if (cfg.mode === 'trunk') {
      lines.push(` port link-type trunk`);
      if (cfg.trunkNativeVlan !== 1) {
        lines.push(` port trunk pvid vlan ${cfg.trunkNativeVlan}`);
      }
      const allowedArr = Array.from(cfg.trunkAllowedVlans).sort((a, b) => a - b);
      if (allowedArr.length >= 4094) {
        lines.push(` port trunk allow-pass vlan all`);
      } else if (allowedArr.length === 0) {
        lines.push(` port trunk allow-pass vlan none`);
      } else {
        lines.push(` port trunk allow-pass vlan ${allowedArr.join(' ')}`);
      }
    } else {
      lines.push(` port link-type access`);
      if (cfg.accessVlan !== 1) {
        lines.push(` port default vlan ${cfg.accessVlan}`);
      }
    }
    for (const cfgLine of this.ifCfg.get(portName) ?? []) {
      lines.push(` ${cfgLine}`);
    }
    for (const stpLine of this.ifStp.get(portName) ?? []) {
      lines.push(` ${stpLine}`);
    }
    if (!port.getIsUp()) lines.push(` shutdown`);
    lines.push('#');
    return lines.join('\n');
  }

  // ─── Interface Name Resolution ──────────────────────────────────

  private resolveInterfaceName(input: string): string | null {
    if (!this.swRef) return null;

    // Direct match
    for (const name of this.swRef.getPortNames()) {
      if (name.toLowerCase() === input.toLowerCase()) return name;
    }

    // Abbreviation: GE0/0/0 → GigabitEthernet0/0/0
    const lower = input.toLowerCase();
    const match = lower.match(/^(ge|gigabitethernet|gi)([\d/]+)$/);
    if (match) {
      const numbers = match[2];
      const resolved = `GigabitEthernet${numbers}`;
      for (const name of this.swRef.getPortNames()) {
        if (name === resolved) return name;
      }
    }

    return null;
  }
}
