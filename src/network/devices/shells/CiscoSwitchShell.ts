/**
 * CiscoSwitchShell - Cisco IOS CLI Engine with FSM for Switches
 *
 * Modes (FSM States):
 *   - user: User EXEC (>)
 *   - privileged: Privileged EXEC (#)
 *   - config: Global Config ((config)#)
 *   - config-if: Interface Config ((config-if)#)
 *   - config-vlan: VLAN Config ((config-vlan)#)
 *
 * Uses CommandTrie for abbreviation matching, tab completion, and ? help.
 */

import { CommandTrie } from './CommandTrie';
import type { ISwitchShell } from './ISwitchShell';
import type { Switch } from '../Switch';

/** CLI Mode (FSM State) */
export type CLIMode = 'user' | 'privileged' | 'config' | 'config-if' | 'config-vlan';

export class CiscoSwitchShell implements ISwitchShell {
  private mode: CLIMode = 'user';
  private selectedInterface: string | null = null;
  private selectedInterfaceRange: string[] = [];
  private selectedVlan: number | null = null;

  // Per-mode command tries
  private userTrie = new CommandTrie();
  private privilegedTrie = new CommandTrie();
  private configTrie = new CommandTrie();
  private configIfTrie = new CommandTrie();
  private configVlanTrie = new CommandTrie();

  constructor() {
    this.buildUserCommands();
    this.buildPrivilegedCommands();
    this.buildConfigCommands();
    this.buildConfigIfCommands();
    this.buildConfigVlanCommands();
  }

  // ─── Mode Management ──────────────────────────────────────────────

  getMode(): CLIMode { return this.mode; }

  getPrompt(sw: Switch): string {
    const host = sw.getHostname();
    switch (this.mode) {
      case 'user':        return `${host}>`;
      case 'privileged':  return `${host}#`;
      case 'config':      return `${host}(config)#`;
      case 'config-if':   return `${host}(config-if)#`;
      case 'config-vlan': return `${host}(config-vlan)#`;
      default:            return `${host}>`;
    }
  }

  getSelectedInterface(): string | null { return this.selectedInterface; }
  getSelectedInterfaceRange(): string[] { return [...this.selectedInterfaceRange]; }

  // ─── Main Execute ─────────────────────────────────────────────────

  execute(sw: Switch, input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return '';

    // Handle pipe filtering: "show logging | include DHCP"
    let pipeFilter: { type: string; pattern: string } | null = null;
    let cmdPart = trimmed;
    const pipeIdx = trimmed.indexOf(' | ');
    if (pipeIdx !== -1) {
      cmdPart = trimmed.substring(0, pipeIdx).trim();
      const filterPart = trimmed.substring(pipeIdx + 3).trim();
      const filterMatch = filterPart.match(/^(include|exclude|grep|findstr)\s+(.+)$/i);
      if (filterMatch) {
        pipeFilter = { type: filterMatch[1].toLowerCase(), pattern: filterMatch[2] };
      }
    }

    // Handle ? for help (preserve trailing space: "show ?" vs "show?")
    if (cmdPart.endsWith('?')) {
      this.swRef = sw;
      const helpInput = cmdPart.slice(0, -1);
      const result = this.getHelp(helpInput);
      this.swRef = null;
      return result;
    }

    // Global shortcuts
    if (cmdPart.toLowerCase() === 'exit') return this.cmdExit();
    if (cmdPart.toLowerCase() === 'end' || cmdPart === '\x03') return this.cmdEnd();
    if (cmdPart.toLowerCase() === 'logout' && this.mode === 'user') return 'Connection closed.';
    if (cmdPart.toLowerCase() === 'disable' && this.mode === 'privileged') {
      this.mode = 'user';
      return '';
    }

    // Bind switch reference for command closures
    this.swRef = sw;

    // Get the trie for current mode
    const trie = this.getActiveTrie();
    const result = trie.match(cmdPart);

    let output: string;
    switch (result.status) {
      case 'ok':
        output = result.node?.action ? result.node.action(result.args, cmdPart) : '';
        break;

      case 'ambiguous':
        output = result.error || `% Ambiguous command: "${cmdPart}"`;
        break;

      case 'incomplete':
        output = result.error || '% Incomplete command.';
        break;

      case 'invalid':
        output = result.error || `% Invalid input detected at '^' marker.`;
        break;

      default:
        output = `% Unrecognized command "${cmdPart}"`;
    }

    this.swRef = null;

    // Apply pipe filter if present
    if (pipeFilter && output) {
      const lines = output.split('\n');
      const pattern = pipeFilter.pattern.toLowerCase();
      if (pipeFilter.type === 'include' || pipeFilter.type === 'grep' || pipeFilter.type === 'findstr') {
        output = lines.filter(l => l.toLowerCase().includes(pattern)).join('\n');
      } else if (pipeFilter.type === 'exclude') {
        output = lines.filter(l => !l.toLowerCase().includes(pattern)).join('\n');
      }
    }

    return output;
  }

  // ─── Help / Completion ────────────────────────────────────────────

  getHelp(input: string): string {
    const trie = this.getActiveTrie();
    const completions = trie.getCompletions(input);
    if (completions.length === 0) return '% Unrecognized command';
    const maxKw = Math.max(...completions.map(c => c.keyword.length));
    return completions
      .map(c => `  ${c.keyword.padEnd(maxKw + 2)}${c.description}`)
      .join('\n');
  }

  tabComplete(input: string): string | null {
    const trie = this.getActiveTrie();
    return trie.tabComplete(input);
  }

  // ─── Running Config Builder ───────────────────────────────────────

  buildRunningConfig(sw: Switch): string {
    const lines = [
      'Building configuration...',
      '',
      'Current configuration:',
      '!',
      `hostname ${sw.getHostname()}`,
      '!',
    ];

    // VLANs
    for (const [id, vlan] of sw.getVLANs()) {
      if (id === 1) continue;
      lines.push(`vlan ${id}`);
      lines.push(` name ${vlan.name}`);
      lines.push('!');
    }

    // Interfaces
    const ports = sw._getPortsInternal();
    const configs = sw._getSwitchportConfigs();
    for (const [portName, port] of ports) {
      const cfg = configs.get(portName);
      if (!cfg) continue;

      lines.push(`interface ${portName}`);
      if (cfg.mode === 'trunk') {
        lines.push(` switchport mode trunk`);
        if (cfg.trunkNativeVlan !== 1) {
          lines.push(` switchport trunk native vlan ${cfg.trunkNativeVlan}`);
        }
      } else {
        lines.push(` switchport mode access`);
        if (cfg.accessVlan !== 1) {
          lines.push(` switchport access vlan ${cfg.accessVlan}`);
        }
      }
      if (!port.getIsUp()) {
        lines.push(` shutdown`);
      }
      lines.push('!');
    }

    lines.push('end');
    return lines.join('\n');
  }

  // ─── FSM Transitions ─────────────────────────────────────────────

  private cmdExit(): string {
    switch (this.mode) {
      case 'config-if':
        this.mode = 'config';
        this.selectedInterface = null;
        this.selectedInterfaceRange = [];
        return '';
      case 'config-vlan':
        this.mode = 'config';
        this.selectedVlan = null;
        return '';
      case 'config':
        this.mode = 'privileged';
        return '';
      case 'privileged':
        this.mode = 'user';
        return '';
      case 'user':
        return 'Connection closed.';
      default:
        return '';
    }
  }

  private cmdEnd(): string {
    if (this.mode === 'config' || this.mode === 'config-if' || this.mode === 'config-vlan') {
      this.mode = 'privileged';
      this.selectedInterface = null;
      this.selectedInterfaceRange = [];
      this.selectedVlan = null;
      return '';
    }
    return '';
  }

  private getActiveTrie(): CommandTrie {
    switch (this.mode) {
      case 'user':        return this.userTrie;
      case 'privileged':  return this.privilegedTrie;
      case 'config':      return this.configTrie;
      case 'config-if':   return this.configIfTrie;
      case 'config-vlan': return this.configVlanTrie;
      default:            return this.userTrie;
    }
  }

  // ─── Command Tree: User EXEC Mode (>) ────────────────────────────

  private swRef: Switch | null = null;

  private buildUserCommands(): void {
    this.userTrie.register('enable', 'Enter privileged EXEC mode', () => {
      this.mode = 'privileged';
      return '';
    });

    this.userTrie.register('show version', 'Display system hardware and software status', () => {
      if (!this.swRef) return '';
      return `Cisco IOS Software, C2960 Software\n${this.swRef.getHostname()} uptime is 0 days, 0 hours`;
    });

    this.userTrie.register('show ip dhcp snooping', 'Display DHCP snooping configuration', () => {
      if (!this.swRef) return '';
      return this.showDHCPSnooping(this.swRef);
    });

    this.userTrie.register('show ip dhcp snooping binding', 'Display DHCP snooping binding table', () => {
      if (!this.swRef) return '';
      return this.showDHCPSnoopingBinding(this.swRef);
    });

    this.userTrie.register('show logging', 'Display syslog messages', () => {
      if (!this.swRef) return '';
      return this.showLogging(this.swRef);
    });

    this.userTrie.registerGreedy('ping', 'Send echo messages', (args) => {
      return `Type escape sequence to abort.\n% Ping not yet implemented on switch.`;
    });
  }

  // ─── Command Tree: Privileged EXEC Mode (#) ──────────────────────

  private buildPrivilegedCommands(): void {
    this.privilegedTrie.register('enable', 'Already in privileged mode', () => '');

    this.privilegedTrie.register('configure terminal', 'Enter configuration mode', () => {
      this.mode = 'config';
      return 'Enter configuration commands, one per line.  End with CNTL/Z.';
    });

    this.privilegedTrie.register('show mac address-table', 'Display MAC address table', () => {
      if (!this.swRef) return '';
      return this.showMACAddressTable(this.swRef);
    });

    this.privilegedTrie.register('show vlan brief', 'Display VLAN summary', () => {
      if (!this.swRef) return '';
      return this.showVlanBrief(this.swRef);
    });

    this.privilegedTrie.register('show vlan', 'Display VLAN information', () => {
      if (!this.swRef) return '';
      return this.showVlanBrief(this.swRef);
    });

    this.privilegedTrie.register('show interfaces status', 'Display interface status', () => {
      if (!this.swRef) return '';
      return this.showInterfacesStatus(this.swRef);
    });

    this.privilegedTrie.register('show interfaces', 'Display interface information', () => {
      if (!this.swRef) return '';
      return this.showInterfacesStatus(this.swRef);
    });

    this.privilegedTrie.register('show running-config', 'Display current running configuration', () => {
      if (!this.swRef) return '';
      return this.buildRunningConfig(this.swRef);
    });

    this.privilegedTrie.register('show startup-config', 'Display startup configuration', () => {
      if (!this.swRef) return '';
      const startup = this.swRef.getStartupConfig();
      return startup ? `Startup config (serialized):\n${startup}` : 'startup-config is not present';
    });

    this.privilegedTrie.register('show spanning-tree', 'Display spanning tree state', () => {
      if (!this.swRef) return '';
      return this.showSpanningTree(this.swRef);
    });

    this.privilegedTrie.register('write memory', 'Save running-config to startup-config', () => {
      if (!this.swRef) return '';
      return this.swRef.writeMemory();
    });

    this.privilegedTrie.register('write', 'Save running-config to startup-config', () => {
      if (!this.swRef) return '';
      return this.swRef.writeMemory();
    });

    this.privilegedTrie.register('copy running-config startup-config', 'Save running-config to startup-config', () => {
      if (!this.swRef) return '';
      return this.swRef.writeMemory();
    });

    this.privilegedTrie.register('show version', 'Display system information', () => {
      if (!this.swRef) return '';
      return `Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.2(7)E2\n${this.swRef.getHostname()} uptime is 0 days, 0 hours`;
    });

    this.privilegedTrie.register('reload', 'Restart the switch', () => {
      if (!this.swRef) return '';
      this.swRef.powerOff();
      this.swRef.powerOn();
      this.mode = 'user';
      return 'System restarting...';
    });

    this.privilegedTrie.register('show ip dhcp snooping', 'Display DHCP snooping configuration', () => {
      if (!this.swRef) return '';
      return this.showDHCPSnooping(this.swRef);
    });

    this.privilegedTrie.register('show ip dhcp snooping binding', 'Display DHCP snooping binding table', () => {
      if (!this.swRef) return '';
      return this.showDHCPSnoopingBinding(this.swRef);
    });

    this.privilegedTrie.register('show logging', 'Display syslog messages', () => {
      if (!this.swRef) return '';
      return this.showLogging(this.swRef);
    });
  }

  // ─── Command Tree: Global Config Mode ((config)#) ────────────────

  private buildConfigCommands(): void {
    this.configTrie.registerGreedy('hostname', 'Set system hostname', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      this.swRef._setHostnameInternal(args[0]);
      return '';
    });

    this.configTrie.registerGreedy('vlan', 'VLAN configuration', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const id = parseInt(args[0], 10);
      if (isNaN(id) || id < 1 || id > 4094) return '% Invalid VLAN ID';
      if (!this.swRef.getVLAN(id)) {
        this.swRef.createVLAN(id);
      }
      this.selectedVlan = id;
      this.mode = 'config-vlan';
      return '';
    });

    this.configTrie.registerGreedy('no vlan', 'Delete a VLAN', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const id = parseInt(args[0], 10);
      if (isNaN(id)) return '% Invalid VLAN ID';
      if (id === 1) return '% Default VLAN 1 may not be deleted.';
      return this.swRef.deleteVLAN(id) ? '' : `% VLAN ${id} not found.`;
    });

    this.configTrie.registerGreedy('interface', 'Select an interface to configure', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';

      if (args[0].toLowerCase() === 'range') {
        return this.handleInterfaceRange(args.slice(1));
      }

      const portName = this.resolveInterfaceName(args[0]);
      if (!portName || !this.swRef.getPort(portName)) {
        return `% Invalid interface name "${args[0]}"`;
      }
      this.selectedInterface = portName;
      this.selectedInterfaceRange = [portName];
      this.mode = 'config-if';
      return '';
    });

    this.configTrie.registerGreedy('mac address-table aging-time', 'Set MAC address aging time', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const seconds = parseInt(args[0], 10);
      if (isNaN(seconds) || seconds < 0) return '% Invalid aging time';
      this.swRef.setMACAgingTime(seconds);
      return '';
    });

    this.configTrie.register('no shutdown', 'Enable interface', () => '');

    this.configTrie.register('show running-config', 'Display current configuration', () => {
      if (!this.swRef) return '';
      return this.buildRunningConfig(this.swRef);
    });

    this.configTrie.register('do show running-config', 'Display current configuration', () => {
      if (!this.swRef) return '';
      return this.buildRunningConfig(this.swRef);
    });

    this.configTrie.register('do show vlan brief', 'Display VLAN summary', () => {
      if (!this.swRef) return '';
      return this.showVlanBrief(this.swRef);
    });

    this.configTrie.register('do show mac address-table', 'Display MAC address table', () => {
      if (!this.swRef) return '';
      return this.showMACAddressTable(this.swRef);
    });

    this.configTrie.register('do write memory', 'Save configuration', () => {
      if (!this.swRef) return '';
      return this.swRef.writeMemory();
    });

    this.configTrie.register('ip dhcp snooping', 'Enable DHCP snooping globally', () => {
      if (!this.swRef) return '';
      this.swRef._getDHCPSnoopingConfig().enabled = true;
      return '';
    });

    this.configTrie.registerGreedy('ip dhcp snooping vlan', 'Enable DHCP snooping on VLANs', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const cfg = this.swRef._getDHCPSnoopingConfig();
      const parts = args[0].split(',');
      for (const part of parts) {
        if (part.includes('-')) {
          const [s, e] = part.split('-').map(Number);
          if (!isNaN(s) && !isNaN(e)) {
            for (let i = s; i <= e; i++) cfg.vlans.add(i);
          }
        } else {
          const v = parseInt(part, 10);
          if (!isNaN(v)) cfg.vlans.add(v);
        }
      }
      return '';
    });

    this.configTrie.register('ip dhcp snooping verify mac-address', 'Enable MAC address verification', () => {
      if (!this.swRef) return '';
      this.swRef._getDHCPSnoopingConfig().verifyMac = true;
      return '';
    });

    this.configTrie.registerGreedy('logging', 'Configure syslog server', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      this.swRef._setSyslogServer(args[0]);
      return '';
    });
  }

  // ─── Command Tree: Interface Config Mode ((config-if)#) ──────────

  private buildConfigIfCommands(): void {
    this.configIfTrie.register('switchport mode access', 'Set interface to access mode', () => {
      if (!this.swRef) return '';
      return this.applyToSelectedInterfaces(portName =>
        this.swRef!.setSwitchportMode(portName, 'access') ? '' : '% Error'
      );
    });

    this.configIfTrie.register('switchport mode trunk', 'Set interface to trunk mode', () => {
      if (!this.swRef) return '';
      return this.applyToSelectedInterfaces(portName =>
        this.swRef!.setSwitchportMode(portName, 'trunk') ? '' : '% Error'
      );
    });

    this.configIfTrie.registerGreedy('switchport access vlan', 'Assign interface to access VLAN', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const vlanId = parseInt(args[0], 10);
      if (isNaN(vlanId) || vlanId < 1 || vlanId > 4094) return '% Invalid VLAN ID';
      return this.applyToSelectedInterfaces(portName =>
        this.swRef!.setSwitchportAccessVlan(portName, vlanId) ? '' : '% Error'
      );
    });

    this.configIfTrie.registerGreedy('switchport trunk native vlan', 'Set trunk native VLAN', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const vlanId = parseInt(args[0], 10);
      if (isNaN(vlanId)) return '% Invalid VLAN ID';
      return this.applyToSelectedInterfaces(portName =>
        this.swRef!.setTrunkNativeVlan(portName, vlanId) ? '' : '% Error'
      );
    });

    this.configIfTrie.registerGreedy('switchport trunk allowed vlan', 'Set trunk allowed VLANs', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const vlans = this.parseVlanList(args[0]);
      if (!vlans) return '% Invalid VLAN list';
      return this.applyToSelectedInterfaces(portName =>
        this.swRef!.setTrunkAllowedVlans(portName, vlans) ? '' : '% Error'
      );
    });

    this.configIfTrie.register('shutdown', 'Disable interface', () => {
      if (!this.swRef) return '';
      return this.applyToSelectedInterfaces(portName => {
        const port = this.swRef!.getPort(portName);
        if (port) { port.setUp(false); return ''; }
        return '% Error';
      });
    });

    this.configIfTrie.register('no shutdown', 'Enable interface', () => {
      if (!this.swRef) return '';
      return this.applyToSelectedInterfaces(portName => {
        const port = this.swRef!.getPort(portName);
        if (port) { port.setUp(true); return ''; }
        return '% Error';
      });
    });

    this.configIfTrie.registerGreedy('description', 'Interface description', () => '');

    this.configIfTrie.register('ip dhcp snooping trust', 'Set interface as trusted for DHCP snooping', () => {
      if (!this.swRef) return '';
      const cfg = this.swRef._getDHCPSnoopingConfig();
      return this.applyToSelectedInterfaces(portName => {
        cfg.trustedPorts.add(portName);
        return '';
      });
    });

    this.configIfTrie.registerGreedy('ip dhcp snooping limit rate', 'Set DHCP snooping rate limit', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const rate = parseInt(args[0], 10);
      if (isNaN(rate) || rate < 1) return '% Invalid rate value';
      const cfg = this.swRef._getDHCPSnoopingConfig();
      return this.applyToSelectedInterfaces(portName => {
        cfg.rateLimits.set(portName, rate);
        return '';
      });
    });

    this.configIfTrie.register('do show running-config', 'Display current configuration', () => {
      if (!this.swRef) return '';
      return this.buildRunningConfig(this.swRef);
    });
  }

  // ─── Command Tree: VLAN Config Mode ((config-vlan)#) ─────────────

  private buildConfigVlanCommands(): void {
    this.configVlanTrie.registerGreedy('name', 'Set VLAN name', (args) => {
      if (!this.swRef || !this.selectedVlan || args.length < 1) return '% Incomplete command.';
      return this.swRef.renameVLAN(this.selectedVlan, args[0]) ? '' : '% VLAN not found';
    });
  }

  // ─── Show Command Implementations ────────────────────────────────

  private showMACAddressTable(sw: Switch): string {
    const entries = sw.getMACTable();
    if (entries.length === 0) return 'Mac Address Table\n-------------------------------------------\nNo entries.';

    const lines = [
      'Mac Address Table',
      '-------------------------------------------',
      '',
      'Vlan    Mac Address       Type        Ports',
      '----    -----------       --------    -----',
    ];

    const sorted = [...entries].sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac));
    for (const e of sorted) {
      const vlan = String(e.vlan).padEnd(8);
      const mac = e.mac.padEnd(18);
      const type = e.type === 'static' ? 'STATIC  ' : 'DYNAMIC ';
      lines.push(`${vlan}${mac}${type}    ${e.port}`);
    }

    lines.push('');
    lines.push(`Total Mac Addresses for this criterion: ${entries.length}`);
    return lines.join('\n');
  }

  private showVlanBrief(sw: Switch): string {
    const vlans = sw.getVLANs();
    const configs = sw._getSwitchportConfigs();

    const lines = [
      'VLAN Name                             Status    Ports',
      '---- -------------------------------- --------- -------------------------------',
    ];

    for (const [id, vlan] of vlans) {
      const name = vlan.name.padEnd(33);
      const status = 'active';

      const portsInVlan: string[] = [];
      for (const [portName, cfg] of configs) {
        if (cfg.mode === 'access' && cfg.accessVlan === id) {
          portsInVlan.push(this.abbreviateInterface(portName));
        }
      }

      const portsStr = portsInVlan.join(', ');
      lines.push(`${String(id).padEnd(5)}${name}${status.padEnd(10)}${portsStr}`);
    }

    return lines.join('\n');
  }

  private showInterfacesStatus(sw: Switch): string {
    const ports = sw._getPortsInternal();
    const configs = sw._getSwitchportConfigs();

    const lines = [
      'Port        Name               Status       Vlan       Duplex  Speed Type',
      '----------  -----------------  -----------  ---------  ------  ----- ----',
    ];

    for (const [portName, port] of ports) {
      const cfg = configs.get(portName);
      const shortName = this.abbreviateInterface(portName).padEnd(12);
      const desc = ''.padEnd(19);
      const status = (port.getIsUp() ? (port.isConnected() ? 'connected' : 'notconnect') : 'disabled').padEnd(13);
      const vlanStr = cfg?.mode === 'trunk' ? 'trunk' : String(cfg?.accessVlan || 1);
      const duplex = 'a-full';
      const speed = portName.startsWith('Gi') ? 'a-1000' : 'a-100';
      const type = portName.startsWith('Gi') ? '1000BASE-T' : '10/100BaseTX';

      lines.push(`${shortName}${desc}${status}${vlanStr.padEnd(11)}${duplex.padEnd(8)}${speed.padEnd(6)}${type}`);
    }

    return lines.join('\n');
  }

  private showSpanningTree(sw: Switch): string {
    const stpStates = sw._getSTPStates();
    const lines = [
      'VLAN0001',
      '  Spanning tree enabled protocol ieee',
      '  Root ID    Priority    32769',
      `             Address     ${sw.getPort(sw.getPortNames()[0])?.getMAC() || '0000.0000.0000'}`,
      '',
      'Interface        Role  Sts  Cost      Prio.Nbr  Type',
      '---------------- ----  ---  --------  --------  ----',
    ];

    for (const [portName, state] of stpStates) {
      const shortName = this.abbreviateInterface(portName).padEnd(17);
      const role = 'Desg';
      const sts = state === 'forwarding' ? 'FWD' :
                  state === 'blocking'   ? 'BLK' :
                  state === 'listening'  ? 'LIS' :
                  state === 'learning'   ? 'LRN' : 'DIS';
      lines.push(`${shortName}${role.padEnd(6)}${sts.padEnd(5)}19        128.${portName.replace(/\D/g, '').padEnd(6)}P2p`);
    }

    return lines.join('\n');
  }

  // ─── DHCP Snooping Display ───────────────────────────────────────

  private showDHCPSnooping(sw: Switch): string {
    const cfg = sw._getDHCPSnoopingConfig();
    const lines: string[] = [];

    lines.push(`Switch DHCP snooping is ${cfg.enabled ? 'enabled' : 'disabled'}`);

    if (cfg.vlans.size > 0) {
      const vlanList = Array.from(cfg.vlans).sort((a, b) => a - b).join(',');
      lines.push(`DHCP snooping is configured on following VLANs:`);
      lines.push(`${vlanList}`);
    }

    if (cfg.verifyMac) {
      lines.push(`DHCP snooping verify mac-address is enabled`);
    }

    if (cfg.trustedPorts.size > 0) {
      const trusted = Array.from(cfg.trustedPorts)
        .map(p => this.abbreviateInterface(p))
        .join(', ');
      lines.push(`Trusted ports: ${trusted}`);
    }

    for (const [port, rate] of cfg.rateLimits) {
      lines.push(`  ${this.abbreviateInterface(port)}: rate limit ${rate} pps`);
    }

    return lines.join('\n');
  }

  private showDHCPSnoopingBinding(sw: Switch): string {
    const bindings = sw._getSnoopingBindings();
    const lines: string[] = [];

    lines.push('MacAddress          IP address        Lease(sec)  Type           VLAN  Interface');
    lines.push('------------------  ----------------  ----------  -------------  ----  --------------------');

    if (bindings.length === 0) {
      lines.push('Total number of bindings: 0');
    } else {
      for (const b of bindings) {
        const mac = b.macAddress.padEnd(20);
        const ip = b.ipAddress.padEnd(18);
        const lease = String(b.lease).padEnd(12);
        const type = b.type.padEnd(15);
        const vlan = String(b.vlan).padEnd(6);
        lines.push(`${mac}${ip}${lease}${type}${vlan}${b.port}`);
      }
      lines.push(`Total number of bindings: ${bindings.length}`);
    }

    return lines.join('\n');
  }

  private showLogging(sw: Switch): string {
    const logs = sw._getSnoopingLog();
    const syslog = sw._getSyslogServer();
    const lines: string[] = [];

    lines.push(`Syslog logging: enabled`);
    if (syslog) {
      lines.push(`  Logging to ${syslog}`);
    }
    lines.push('');

    if (logs.length > 0) {
      for (const log of logs) {
        lines.push(log);
      }
    } else {
      const cfg = sw._getDHCPSnoopingConfig();
      if (cfg.enabled) {
        lines.push(`*${new Date().toLocaleString()}: %DHCP_SNOOPING-5-DHCP_SNOOPING_ENABLED: DHCP Snooping enabled globally`);
        if (cfg.verifyMac) {
          lines.push(`*${new Date().toLocaleString()}: %DHCP_SNOOPING-5-DHCP_SNOOPING_VERIFY_MAC: DHCP snooping verify mac-address enabled`);
        }
      }
    }

    return lines.join('\n');
  }

  // ─── Interface Resolution ─────────────────────────────────────────

  private resolveInterfaceName(input: string): string | null {
    const lower = input.toLowerCase();

    if (this.swRef) {
      for (const name of this.swRef.getPortNames()) {
        if (name.toLowerCase() === lower) return name;
      }
    }

    const prefixMap: Record<string, string> = {
      'fa': 'FastEthernet',
      'fas': 'FastEthernet',
      'fast': 'FastEthernet',
      'faste': 'FastEthernet',
      'fastet': 'FastEthernet',
      'fasteth': 'FastEthernet',
      'fastetherr': 'FastEthernet',
      'fastethernet': 'FastEthernet',
      'gi': 'GigabitEthernet',
      'gig': 'GigabitEthernet',
      'giga': 'GigabitEthernet',
      'gigab': 'GigabitEthernet',
      'gigabi': 'GigabitEthernet',
      'gigabit': 'GigabitEthernet',
      'gigabite': 'GigabitEthernet',
      'gigabitet': 'GigabitEthernet',
      'gigabiteth': 'GigabitEthernet',
      'gigabitethernet': 'GigabitEthernet',
      'eth': 'eth',
    };

    const match = lower.match(/^([a-z]+)([\d/.-]+)$/);
    if (!match) return null;

    const [, prefix, numbers] = match;
    const fullPrefix = prefixMap[prefix];
    if (!fullPrefix) return null;

    const resolved = `${fullPrefix}${numbers}`;

    if (this.swRef) {
      for (const name of this.swRef.getPortNames()) {
        if (name === resolved) return name;
      }
    }

    return null;
  }

  private handleInterfaceRange(args: string[]): string {
    if (args.length < 1) return '% Incomplete command.';

    const rangeStr = args.join(' ').replace(/\s*-\s*/g, '-');
    const rangeMatch = rangeStr.match(/^([a-zA-Z]+)\s*([\d/]+)-([\d/]+)$/);

    if (!rangeMatch) {
      const simpleMatch = rangeStr.match(/^([a-zA-Z]+)([\d]+\/[\d]+)-([\d]+)$/);
      if (!simpleMatch) return '% Invalid interface range.';

      const [, prefix, start, endNum] = simpleMatch;
      const slashIdx = start.lastIndexOf('/');
      const baseNum = start.substring(0, slashIdx + 1);
      const startNum = parseInt(start.substring(slashIdx + 1), 10);
      const end = parseInt(endNum, 10);

      const interfaces: string[] = [];
      for (let i = startNum; i <= end; i++) {
        const name = this.resolveInterfaceName(`${prefix}${baseNum}${i}`);
        if (name) interfaces.push(name);
      }

      if (interfaces.length === 0) return '% No valid interfaces in range.';
      this.selectedInterface = interfaces[0];
      this.selectedInterfaceRange = interfaces;
      this.mode = 'config-if';
      return '';
    }

    const [, prefix, startSlot, endSlot] = rangeMatch;
    const slashIdx = startSlot.lastIndexOf('/');
    const baseSlot = startSlot.substring(0, slashIdx + 1);
    const startNum = parseInt(startSlot.substring(slashIdx + 1), 10);
    const endNum = parseInt(endSlot, 10);

    const interfaces: string[] = [];
    for (let i = startNum; i <= endNum; i++) {
      const name = this.resolveInterfaceName(`${prefix}${baseSlot}${i}`);
      if (name) interfaces.push(name);
    }

    if (interfaces.length === 0) return '% No valid interfaces in range.';
    this.selectedInterface = interfaces[0];
    this.selectedInterfaceRange = interfaces;
    this.mode = 'config-if';
    return '';
  }

  private applyToSelectedInterfaces(fn: (portName: string) => string): string {
    const results: string[] = [];
    for (const portName of this.selectedInterfaceRange) {
      const result = fn(portName);
      if (result) results.push(result);
    }
    return results.join('\n');
  }

  // ─── VLAN List Parser ────────────────────────────────────────────

  private parseVlanList(input: string): Set<number> | null {
    const vlans = new Set<number>();
    const parts = input.split(',');
    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number);
        if (isNaN(start) || isNaN(end)) return null;
        for (let i = start; i <= end; i++) vlans.add(i);
      } else {
        const num = parseInt(part, 10);
        if (isNaN(num)) return null;
        vlans.add(num);
      }
    }
    return vlans;
  }

  // ─── Abbreviation Helper ──────────────────────────────────────────

  private abbreviateInterface(name: string): string {
    return name
      .replace('FastEthernet', 'Fa')
      .replace('GigabitEthernet', 'Gi');
  }
}
