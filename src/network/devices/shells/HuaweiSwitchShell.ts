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
import { parsePipeFilter, applyPipeFilter, resolveHuaweiNav } from './cli-utils';
import {
  displayClock, displayCpuUsage, displayMemoryUsage, displayUsers,
  displayDevice, displayHistoryCommand, displayAlarm, displayElabel,
  displayLicense, displayLogbuffer, displayTrapbuffer,
  displayPatchInformation, displayDiagnosticInformation,
} from './huawei/HuaweiCommonDisplay';
import { registerHuaweiCommonMgmt } from './huawei/HuaweiCommonConfig';

type VRPSwitchMode = 'user' | 'system' | 'interface' | 'vlan' | 'mst-region';

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

  private swRef: Switch | null = null;
  private history: string[] = [];

  // STP/RSTP/MSTP global config (switch-only, L2). Default: VRP MSTP.
  private stp: {
    enabled: boolean;
    mode: 'stp' | 'rstp' | 'mstp';
    priority: number;
    root: '' | 'primary' | 'secondary';
    bpduProtection: boolean;
  } = { enabled: true, mode: 'mstp', priority: 32768, root: '', bpduProtection: false };

  private mstRegion: {
    name: string; revision: number; instances: Map<number, string>;
  } = { name: '', revision: 0, instances: new Map() };

  /** Per-interface STP config lines (rendered verbatim in `display this`). */
  private ifStp = new Map<string, string[]>();

  constructor() {
    this.buildUserCommands();
    this.buildSystemCommands();
    this.buildInterfaceCommands();
    this.buildVlanCommands();
    this.buildMstRegionCommands();
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
    // display + common management commands (available in system view too)
    this.registerDisplayCommands(this.systemTrie);
    this.registerCommonMgmt(this.systemTrie);
    this.registerStpSystemCommands(this.systemTrie);

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

    // interface <name>
    this.systemTrie.registerGreedy('interface', 'Enter interface view', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
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
  }

  // ─── Command Tree: Interface View ([hostname-GigabitEthernet0/0/X]) ──

  private buildInterfaceCommands(): void {
    // display commands
    this.registerDisplayCommands(this.interfaceTrie);
    this.registerStpInterfaceCommands(this.interfaceTrie);

    // shutdown
    this.interfaceTrie.register('shutdown', 'Shut down interface', () => {
      if (!this.swRef || !this.selectedInterface) return '';
      const port = this.swRef.getPort(this.selectedInterface);
      if (port) port.setUp(false);
      return '';
    });

    // undo shutdown
    this.interfaceTrie.register('undo shutdown', 'Bring up interface', () => {
      if (!this.swRef || !this.selectedInterface) return '';
      const port = this.swRef.getPort(this.selectedInterface);
      if (port) port.setUp(true);
      return '';
    });

    // description <text>
    this.interfaceTrie.registerGreedy('description', 'Set interface description', (args) => {
      if (!this.swRef || !this.selectedInterface || args.length < 1) return 'Error: Incomplete command.';
      this.swRef.setInterfaceDescription(this.selectedInterface, args.join(' '));
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
  }

  // ─── Shared Display Commands ──────────────────────────────────────

  private registerDisplayCommands(trie: CommandTrie): void {
    trie.register('display version', 'Display VRP version information', () => {
      if (!this.swRef) return '';
      return this.displayVersion(this.swRef);
    });

    trie.register('display vlan', 'Display VLAN information', () => {
      if (!this.swRef) return '';
      return this.displayVlan(this.swRef);
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

    trie.register('display mac-address', 'Display MAC address table', () => {
      if (!this.swRef) return '';
      return this.displayMacAddress(this.swRef);
    });

    trie.register('display mac-address aging-time', 'Display MAC aging time', () => {
      if (!this.swRef) return '';
      return this.displayMacAgingTime(this.swRef);
    });

    trie.register('display current-configuration', 'Display running configuration', () => {
      if (!this.swRef) return '';
      return this.displayCurrentConfig(this.swRef);
    });

    trie.registerGreedy('display current-configuration interface', 'Display interface configuration', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      return this.displayCurrentConfigInterface(this.swRef, args.join(' '));
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
        case 'enable':  this.stp.enabled = true;  return '';
        case 'disable': this.stp.enabled = false; return '';
        case 'mode': {
          const m = a[1];
          if (m !== 'stp' && m !== 'rstp' && m !== 'mstp') {
            return 'Error: Wrong parameter found at \'^\' position.';
          }
          this.stp.mode = m;
          return '';
        }
        case 'priority': {
          const p = parseInt(a[1], 10);
          if (isNaN(p) || p < 0 || p > 61440 || p % 4096 !== 0) {
            return 'Error: Wrong parameter found at \'^\' position.';
          }
          this.stp.priority = p;
          return '';
        }
        case 'root':
          if (a[1] === 'primary')   { this.stp.root = 'primary';   this.stp.priority = 0;     return ''; }
          if (a[1] === 'secondary') { this.stp.root = 'secondary'; this.stp.priority = 4096;  return ''; }
          return 'Error: Wrong parameter found at \'^\' position.';
        case 'bpdu-protection':
          this.stp.bpduProtection = true;
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
    t.register('active region-configuration', 'Activate MST region', () => '');
    t.register('check region-configuration', 'Check MST region', () => '');
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
    trie.register('display stp brief', 'Display STP brief', () => this.displayStpBrief());
    trie.registerGreedy('display stp interface', 'Display STP for an interface', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      return this.displayStpBrief(this.resolveInterfaceName(args.join(' ')) || args.join(' '));
    });
  }

  private displayStp(): string {
    const modeName = this.stp.mode.toUpperCase();
    return [
      `-------[CIST Global Info][Mode ${modeName}]-------`,
      `CIST Bridge         :${this.stp.priority}.${this.swRef?.getHostname() ?? ''}`,
      `Config Times        :Hello 2s MaxAge 20s FwDly 15s MaxHop 20`,
      `Active Times        :Hello 2s MaxAge 20s FwDly 15s MaxHop 20`,
      `CIST Root/ERPC      :${this.stp.priority}.0000-0000-0000 / 0`,
      `CIST RegRoot/IRPC   :${this.stp.priority}.0000-0000-0000 / 0`,
      `CIST RootPortId     :0.0`,
      `BPDU-Protection     :${this.stp.bpduProtection ? 'Enabled' : 'Disabled'}`,
      `TC or TCN received  :0`,
      `STP Status          :${this.stp.enabled ? 'Enabled' : 'Disabled'}`,
    ].join('\n');
  }

  private displayStpBrief(only?: string): string {
    if (!this.swRef) return '';
    const header = ' MSTID  Port                        Role  STP State     Protection';
    const rows: string[] = [];
    for (const p of this.swRef.getPortNames()) {
      if (only && p !== only) continue;
      const st = this.swRef.getSTPState(p);
      const state = st === 'forwarding' ? 'FORWARDING'
        : st === 'disabled' ? 'DISCARDING' : st.toUpperCase();
      rows.push(`     0  ${p.padEnd(27)} DESI  ${state.padEnd(13)} NONE`);
    }
    if (only && rows.length === 0) {
      return `Error: The port ${only} does not exist.`;
    }
    return [header, ...rows].join('\n');
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
    }

    return `Error: Unrecognized command "undo ${args.join(' ')}"`;
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
