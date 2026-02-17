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

type VRPSwitchMode = 'user' | 'system' | 'interface' | 'vlan';

export class HuaweiSwitchShell implements ISwitchShell {
  private mode: VRPSwitchMode = 'user';
  private selectedInterface: string | null = null;
  private selectedVlan: number | null = null;

  // Per-mode command tries
  private userTrie = new CommandTrie();
  private systemTrie = new CommandTrie();
  private interfaceTrie = new CommandTrie();
  private vlanTrie = new CommandTrie();

  private swRef: Switch | null = null;

  constructor() {
    this.buildUserCommands();
    this.buildSystemCommands();
    this.buildInterfaceCommands();
    this.buildVlanCommands();
  }

  getMode(): VRPSwitchMode { return this.mode; }

  getPrompt(sw: Switch): string {
    const host = sw.getHostname();
    switch (this.mode) {
      case 'user':      return `<${host}>`;
      case 'system':    return `[${host}]`;
      case 'interface': return `[${host}-${this.selectedInterface}]`;
      case 'vlan':      return `[${host}-vlan${this.selectedVlan}]`;
      default:          return `<${host}>`;
    }
  }

  // ─── Main Execute ─────────────────────────────────────────────────

  execute(sw: Switch, input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return '';

    // Handle ? for help
    if (trimmed.endsWith('?')) {
      this.swRef = sw;
      const helpInput = trimmed.slice(0, -1);
      const result = this.getHelp(helpInput);
      this.swRef = null;
      return result;
    }

    const lower = trimmed.toLowerCase();

    // Global navigation commands (available in all modes)
    if (lower === 'return') {
      this.mode = 'user';
      this.selectedInterface = null;
      this.selectedVlan = null;
      return '';
    }
    if (lower === 'quit') return this.cmdQuit();

    // Bind switch reference for command closures
    this.swRef = sw;

    // Get the trie for current mode
    const trie = this.getActiveTrie();
    const result = trie.match(trimmed);

    let output: string;
    switch (result.status) {
      case 'ok':
        output = result.node?.action ? result.node.action(result.args, trimmed) : '';
        break;

      case 'ambiguous':
        output = `Error: Ambiguous command "${trimmed}"`;
        break;

      case 'incomplete':
        output = 'Error: Incomplete command.';
        break;

      case 'invalid':
        output = `Error: Unrecognized command "${trimmed}"`;
        break;

      default:
        output = `Error: Unrecognized command "${trimmed}"`;
    }

    this.swRef = null;
    return output;
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

    // display commands
    this.registerDisplayCommands(this.userTrie);
  }

  // ─── Command Tree: System View ([hostname]) ───────────────────────

  private buildSystemCommands(): void {
    // display commands (available in system view too)
    this.registerDisplayCommands(this.systemTrie);

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

    // port trunk allow-pass vlan <id> [<id>...]
    this.interfaceTrie.registerGreedy('port trunk allow-pass vlan', 'Set trunk allowed VLANs', (args) => {
      if (!this.swRef || !this.selectedInterface || args.length < 1) return 'Error: Incomplete command.';
      const vlans = new Set<number>();
      for (const arg of args) {
        const id = parseInt(arg, 10);
        if (!isNaN(id)) vlans.add(id);
      }
      this.swRef.setTrunkAllowedVlans(this.selectedInterface, vlans);
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
        if (allowedArr.length < 4094) {
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
      if (allowedArr.length < 4094) {
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
