/**
 * CiscoSwitch - Cisco IOS switch with realistic terminal emulation
 *
 * Features:
 * - Realistic boot sequence
 * - Configuration modes (user, privileged, config, interface, vlan)
 * - VLAN management (create, delete, name)
 * - Switchport configuration (mode, access vlan, trunk)
 * - Spanning-tree configuration
 * - Port security
 * - MAC address table
 *
 * @example
 * ```typescript
 * const sw = new CiscoSwitch({ id: 's1', name: 'Switch 1', hostname: 'SW1' });
 * sw.powerOn();
 *
 * await sw.executeCommand('enable');
 * await sw.executeCommand('configure terminal');
 * await sw.executeCommand('vlan 10');
 * await sw.executeCommand('name SALES');
 * ```
 */

import { Switch } from './Switch';
import { DeviceConfig, OSType } from './types';

/**
 * Configuration mode
 */
type ConfigMode = 'user' | 'privileged' | 'config' | 'interface' | 'vlan' | 'line';

/**
 * VLAN configuration
 */
interface VLANConfig {
  id: number;
  name: string;
  status: 'active' | 'suspend';
  ports: string[];
}

/**
 * Switchport configuration
 */
interface SwitchportConfig {
  mode: 'access' | 'trunk' | 'dynamic';
  accessVlan: number;
  trunkAllowedVlans: number[];
  portSecurity: boolean;
  portSecurityMaximum: number;
}

/**
 * CiscoSwitch - Cisco IOS switch device
 */
export class CiscoSwitch extends Switch {
  private commandHistory: string[];
  private configMode: ConfigMode;
  private enablePassword: string;
  private enableSecret: string;
  private isEnabled: boolean;
  private awaitingPassword: boolean;
  private vlans: Map<number, VLANConfig>;
  private switchportConfigs: Map<string, SwitchportConfig>;
  private currentInterface: string;
  private currentVlan: number;
  private spanningTreeMode: string;

  constructor(config: DeviceConfig) {
    const id = config.id || `cisco-switch-${Date.now()}`;
    const name = config.name || id;

    // Cisco switches typically have 24 ports
    super(id, name, 24);

    // Override type to cisco-switch
    (this as any).type = 'cisco-switch';

    // Set UI properties if provided
    if (config.hostname) {
      this.setHostname(config.hostname);
    } else {
      this.setHostname('Switch');
    }
    if (config.x !== undefined && config.y !== undefined) {
      this.setPosition(config.x, config.y);
    }

    this.commandHistory = [];
    this.configMode = 'user';
    this.enablePassword = '';
    this.enableSecret = '';
    this.isEnabled = false;
    this.awaitingPassword = false;
    this.vlans = new Map();
    this.switchportConfigs = new Map();
    this.currentInterface = '';
    this.currentVlan = 0;
    this.spanningTreeMode = 'pvst';

    // Initialize default VLAN 1
    this.vlans.set(1, {
      id: 1,
      name: 'default',
      status: 'active',
      ports: this.getPorts()
    });

    // Power on if requested
    if (config.isPoweredOn !== false) {
      this.powerOn();
    }
  }

  /**
   * Returns OS type for terminal emulation
   */
  public getOSType(): OSType {
    return 'cisco-ios';
  }

  /**
   * Returns realistic Cisco IOS switch boot sequence
   */
  public getBootSequence(): string {
    return `
System Bootstrap, Version 15.0(2)SE4, RELEASE SOFTWARE (fc1)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 2013 by cisco Systems, Inc.

Initializing memory...

BOOTLDR: C2960 Boot Loader (C2960-HBOOT-M) Version 12.2(53r)SEY3, RELEASE SOFTWARE (fc1)

           cisco Systems, Inc.
           170 West Tasman Drive
           San Jose, California 95134-1706

Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE4, RELEASE SOFTWARE (fc1)
Copyright (c) 1986-2013 by Cisco Systems, Inc.

cisco WS-C2960-24TT-L (PowerPC405) processor with 65536K bytes of memory.
Processor board ID FOC1010X104
24 FastEthernet interfaces
2 Gigabit Ethernet interfaces
64K bytes of flash-simulated non-volatile configuration memory.

Press RETURN to get started!
`;
  }

  public setEnableSecret(secret: string): void {
    this.enableSecret = secret;
  }

  public setEnablePassword(password: string): void {
    this.enablePassword = password;
  }

  /**
   * Executes a Cisco IOS command
   */
  public async executeCommand(command: string): Promise<string> {
    if (!this.isOnline()) {
      return 'Device is offline';
    }

    const cmd = command.trim();

    if (this.awaitingPassword) {
      return this.handlePasswordInput(cmd);
    }

    if (cmd) {
      this.commandHistory.push(cmd);
    }

    if (!cmd) {
      return '';
    }

    // Route to appropriate mode handler
    if (this.configMode === 'interface') {
      return this.executeInterfaceCommand(cmd);
    }

    if (this.configMode === 'vlan') {
      return this.executeVlanConfigCommand(cmd);
    }

    if (this.configMode === 'line') {
      return this.executeLineCommand(cmd);
    }

    if (this.configMode === 'config') {
      return this.executeConfigCommand(cmd);
    }

    if (this.isEnabled || this.configMode === 'privileged') {
      return this.executePrivilegedCommand(cmd);
    }

    return this.executeUserCommand(cmd);
  }

  private handlePasswordInput(password: string): string {
    this.awaitingPassword = false;
    const correctPassword = this.enableSecret || this.enablePassword;

    if (password === correctPassword) {
      this.isEnabled = true;
      this.configMode = 'privileged';
      return '';
    }
    return '% Access denied\n';
  }

  private executeUserCommand(cmd: string): string {
    if (cmd === 'enable') {
      if (this.enableSecret || this.enablePassword) {
        this.awaitingPassword = true;
        return 'Password: ';
      }
      this.isEnabled = true;
      this.configMode = 'privileged';
      return '';
    }

    if (cmd === 'exit' || cmd === 'logout') {
      return 'Connection closed.';
    }

    if (cmd === '?') {
      return this.getUserModeHelp();
    }

    return `% Invalid input detected at '^' marker.`;
  }

  private executePrivilegedCommand(cmd: string): string {
    if (cmd === 'configure terminal' || cmd === 'conf t') {
      this.configMode = 'config';
      return 'Enter configuration commands, one per line.  End with CNTL/Z.';
    }

    if (cmd === 'disable') {
      this.isEnabled = false;
      this.configMode = 'user';
      return '';
    }

    if (cmd === 'exit' || cmd === 'logout') {
      this.isEnabled = false;
      this.configMode = 'user';
      return '';
    }

    if (cmd.startsWith('show ')) {
      return this.executeShowCommand(cmd);
    }

    if (cmd === '?') {
      return this.getPrivilegedModeHelp();
    }

    return `% Invalid input detected at '^' marker.`;
  }

  private executeConfigCommand(cmd: string): string {
    if (cmd === 'end') {
      this.configMode = 'privileged';
      return '';
    }

    if (cmd === 'exit') {
      this.configMode = 'privileged';
      return '';
    }

    if (cmd.startsWith('do ')) {
      return this.executePrivilegedCommand(cmd.substring(3));
    }

    if (cmd.startsWith('hostname ')) {
      this.setHostname(cmd.substring(9).trim());
      return '';
    }

    if (cmd.startsWith('interface ') || cmd.startsWith('int ')) {
      const parts = cmd.split(/\s+/);
      this.currentInterface = parts.slice(1).join('');
      this.configMode = 'interface';
      return '';
    }

    if (cmd.startsWith('vlan ')) {
      const vlanId = parseInt(cmd.substring(5).trim(), 10);
      if (!isNaN(vlanId) && vlanId >= 1 && vlanId <= 4094) {
        this.currentVlan = vlanId;
        // Create VLAN if it doesn't exist
        if (!this.vlans.has(vlanId)) {
          this.vlans.set(vlanId, {
            id: vlanId,
            name: `VLAN${vlanId.toString().padStart(4, '0')}`,
            status: 'active',
            ports: []
          });
        }
        this.configMode = 'vlan';
        return '';
      }
      return '% Invalid VLAN ID';
    }

    if (cmd.startsWith('no vlan ')) {
      const vlanId = parseInt(cmd.substring(8).trim(), 10);
      if (vlanId !== 1 && this.vlans.has(vlanId)) {
        this.vlans.delete(vlanId);
        return '';
      }
      if (vlanId === 1) {
        return '% Cannot delete default VLAN 1';
      }
      return '% VLAN not found';
    }

    if (cmd.startsWith('spanning-tree mode ')) {
      this.spanningTreeMode = cmd.substring(19).trim();
      return '';
    }

    if (cmd.startsWith('line ')) {
      this.configMode = 'line';
      return '';
    }

    if (cmd.startsWith('enable secret ')) {
      this.enableSecret = cmd.substring(14).trim();
      return '';
    }

    if (cmd.startsWith('enable password ')) {
      this.enablePassword = cmd.substring(16).trim();
      return '';
    }

    return '';
  }

  private executeVlanConfigCommand(cmd: string): string {
    if (cmd === 'exit') {
      this.configMode = 'config';
      return '';
    }

    if (cmd === 'end') {
      this.configMode = 'privileged';
      return '';
    }

    if (cmd.startsWith('name ')) {
      const name = cmd.substring(5).trim();
      const vlan = this.vlans.get(this.currentVlan);
      if (vlan) {
        vlan.name = name;
      }
      return '';
    }

    if (cmd === 'state active') {
      const vlan = this.vlans.get(this.currentVlan);
      if (vlan) {
        vlan.status = 'active';
      }
      return '';
    }

    if (cmd === 'state suspend') {
      const vlan = this.vlans.get(this.currentVlan);
      if (vlan) {
        vlan.status = 'suspend';
      }
      return '';
    }

    return '';
  }

  private executeInterfaceCommand(cmd: string): string {
    if (cmd === 'exit') {
      this.configMode = 'config';
      return '';
    }

    if (cmd === 'end') {
      this.configMode = 'privileged';
      return '';
    }

    if (cmd.startsWith('do ')) {
      return this.executePrivilegedCommand(cmd.substring(3));
    }

    // Get or create switchport config for this interface
    const ifaceName = this.currentInterface;
    if (!this.switchportConfigs.has(ifaceName)) {
      this.switchportConfigs.set(ifaceName, {
        mode: 'dynamic',
        accessVlan: 1,
        trunkAllowedVlans: [],
        portSecurity: false,
        portSecurityMaximum: 1
      });
    }
    const config = this.switchportConfigs.get(ifaceName)!;

    if (cmd === 'switchport mode access') {
      config.mode = 'access';
      return '';
    }

    if (cmd === 'switchport mode trunk') {
      config.mode = 'trunk';
      return '';
    }

    if (cmd.startsWith('switchport access vlan ')) {
      const vlanId = parseInt(cmd.substring(23).trim(), 10);
      if (!isNaN(vlanId)) {
        config.accessVlan = vlanId;
        // Create VLAN if it doesn't exist
        if (!this.vlans.has(vlanId)) {
          this.vlans.set(vlanId, {
            id: vlanId,
            name: `VLAN${vlanId.toString().padStart(4, '0')}`,
            status: 'active',
            ports: []
          });
        }
      }
      return '';
    }

    if (cmd.startsWith('switchport trunk allowed vlan ')) {
      const vlanStr = cmd.substring(30).trim();
      const vlanIds = vlanStr.split(',').map(v => parseInt(v.trim(), 10)).filter(v => !isNaN(v));
      config.trunkAllowedVlans = vlanIds;
      return '';
    }

    if (cmd === 'switchport port-security') {
      config.portSecurity = true;
      return '';
    }

    if (cmd.startsWith('switchport port-security maximum ')) {
      const max = parseInt(cmd.substring(33).trim(), 10);
      if (!isNaN(max)) {
        config.portSecurityMaximum = max;
      }
      return '';
    }

    if (cmd === 'no shutdown' || cmd === 'no shut') {
      return '';
    }

    if (cmd === 'shutdown') {
      return '';
    }

    return '';
  }

  private executeLineCommand(cmd: string): string {
    if (cmd === 'exit') {
      this.configMode = 'config';
      return '';
    }
    if (cmd === 'end') {
      this.configMode = 'privileged';
      return '';
    }
    return '';
  }

  private executeShowCommand(cmd: string): string {
    if (cmd === 'show version' || cmd === 'sh ver') {
      return this.getVersionOutput();
    }

    if (cmd === 'show mac address-table' || cmd === 'sh mac add') {
      return this.getMACTableOutput();
    }

    if (cmd === 'show vlan' || cmd === 'sh vlan') {
      return this.getVLANOutput();
    }

    if (cmd === 'show vlan brief' || cmd === 'sh vlan br') {
      return this.getVLANBriefOutput();
    }

    if (cmd === 'show interfaces status' || cmd === 'sh int status') {
      return this.getInterfaceStatusOutput();
    }

    if (cmd === 'show running-config' || cmd === 'sh run') {
      return this.getRunningConfigOutput();
    }

    if (cmd === 'show spanning-tree' || cmd === 'sh span') {
      return this.getSpanningTreeOutput();
    }

    if (cmd === 'show ?') {
      return this.getShowHelp();
    }

    return `% Invalid input detected at '^' marker.`;
  }

  private getVersionOutput(): string {
    return `Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE4, RELEASE SOFTWARE (fc1)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2013 by Cisco Systems, Inc.
Compiled Wed 26-Jun-13 02:49 by mnguyen

ROM: Bootstrap program is C2960 boot loader
BOOTLDR: C2960 Boot Loader (C2960-HBOOT-M) Version 12.2(53r)SEY3, RELEASE SOFTWARE (fc1)

${this.getHostname()} uptime is 0 minutes
System returned to ROM by power-on
System image file is "flash:/c2960-lanbasek9-mz.150-2.SE4.bin"

cisco WS-C2960-24TT-L (PowerPC405) processor with 65536K bytes of memory.
Processor board ID FOC1010X104
Last reset from power-on
1 Virtual Ethernet interface
24 FastEthernet interfaces
2 Gigabit Ethernet interfaces
The password-recovery mechanism is enabled.

64K bytes of flash-simulated non-volatile configuration memory.
Base ethernet MAC Address       : 00:1E:14:52:00:00
Model number                    : WS-C2960-24TT-L
System serial number            : FOC1010X104

Configuration register is 0xF`;
  }

  private getMACTableOutput(): string {
    const macTable = this.getMACTable();
    const entries = macTable.export();

    let output = '          Mac Address Table\n';
    output += '-------------------------------------------\n\n';
    output += 'Vlan    Mac Address       Type        Ports\n';
    output += '----    -----------       --------    -----\n';

    if (entries.length === 0) {
      return output + 'Total Mac Addresses for this criterion: 0\n';
    }

    for (const entry of entries) {
      const vlan = 1; // Default VLAN
      output += `${vlan.toString().padEnd(8)}${entry.mac.padEnd(18)}DYNAMIC     ${entry.port}\n`;
    }

    output += `Total Mac Addresses for this criterion: ${entries.length}\n`;

    return output;
  }

  private getVLANOutput(): string {
    let output = 'VLAN Name                             Status    Ports\n';
    output += '---- -------------------------------- --------- -------------------------------\n';

    for (const [vlanId, vlan] of this.vlans) {
      const status = vlan.status;
      const ports = this.getPorts().slice(0, 8).join(', ');
      output += `${vlanId.toString().padEnd(5)}${vlan.name.padEnd(33)}${status.padEnd(10)}${vlanId === 1 ? ports : ''}\n`;
    }

    output += '\n1002 fddi-default                     act/unsup\n';
    output += '1003 token-ring-default               act/unsup\n';
    output += '1004 fddinet-default                  act/unsup\n';
    output += '1005 trnet-default                    act/unsup\n';

    return output;
  }

  private getVLANBriefOutput(): string {
    let output = 'VLAN Name                             Status    Ports\n';
    output += '---- -------------------------------- --------- -------------------------------\n';

    for (const [vlanId, vlan] of this.vlans) {
      let ports = '';
      if (vlanId === 1) {
        ports = this.getPorts().slice(0, 4).join(', ');
      }

      // Check which interfaces are assigned to this VLAN
      for (const [ifaceName, config] of this.switchportConfigs) {
        if (config.mode === 'access' && config.accessVlan === vlanId) {
          if (ports) ports += ', ';
          ports += ifaceName;
        }
      }

      output += `${vlanId.toString().padEnd(5)}${vlan.name.padEnd(33)}${vlan.status.padEnd(10)}${ports}\n`;
    }

    output += '1002 fddi-default                     act/unsup\n';
    output += '1003 token-ring-default               act/unsup\n';
    output += '1004 fddinet-default                  act/unsup\n';
    output += '1005 trnet-default                    act/unsup\n';

    return output;
  }

  private getInterfaceStatusOutput(): string {
    let output = '\nPort      Name               Status       Vlan       Duplex  Speed Type\n';

    const ports = this.getPorts().slice(0, 24);

    for (const port of ports) {
      const status = 'notconnect';
      const config = this.switchportConfigs.get(port);
      const vlan = config?.mode === 'access' ? config.accessVlan.toString() : (config?.mode === 'trunk' ? 'trunk' : '1');
      const duplex = 'auto';
      const speed = 'auto';
      const type = port.includes('Gi') ? '10/100/1000BaseTX' : '10/100BaseTX';

      output += `${port.padEnd(10)}${' '.padEnd(19)}${status.padEnd(13)}${vlan.padEnd(11)}${duplex.padEnd(8)}${speed.padEnd(6)}${type}\n`;
    }

    return output;
  }

  private getRunningConfigOutput(): string {
    let output = 'Building configuration...\n\nCurrent configuration : 1024 bytes\n!\nversion 15.0\n';
    output += 'no service pad\n';
    output += 'service timestamps debug datetime msec\n';
    output += 'service timestamps log datetime msec\n';
    output += '!\n';
    output += `hostname ${this.getHostname()}\n`;
    output += '!\n';

    if (this.enableSecret) {
      output += `enable secret 5 $1$hash\n`;
    }

    output += `spanning-tree mode ${this.spanningTreeMode}\n`;
    output += '!\n';

    // Show VLAN configs
    for (const [vlanId, vlan] of this.vlans) {
      if (vlanId !== 1 && vlanId < 1002) {
        output += `vlan ${vlanId}\n`;
        output += ` name ${vlan.name}\n`;
        output += '!\n';
      }
    }

    // Show interface configs
    for (const [ifaceName, config] of this.switchportConfigs) {
      output += `interface ${ifaceName}\n`;
      output += ` switchport mode ${config.mode}\n`;
      if (config.mode === 'access') {
        output += ` switchport access vlan ${config.accessVlan}\n`;
      }
      if (config.mode === 'trunk' && config.trunkAllowedVlans.length > 0) {
        output += ` switchport trunk allowed vlan ${config.trunkAllowedVlans.join(',')}\n`;
      }
      if (config.portSecurity) {
        output += ' switchport port-security\n';
        output += ` switchport port-security maximum ${config.portSecurityMaximum}\n`;
      }
      output += '!\n';
    }

    output += 'end\n';

    return output;
  }

  private getSpanningTreeOutput(): string {
    let output = '';

    for (const [vlanId, vlan] of this.vlans) {
      if (vlanId < 1002) {
        output += `\nVLAN${vlanId.toString().padStart(4, '0')}\n`;
        output += `  Spanning tree enabled protocol ${this.spanningTreeMode}\n`;
        output += `  Root ID    Priority    32769\n`;
        output += `             Address     001e.1452.0000\n`;
        output += `             This bridge is the root\n`;
        output += `             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec\n\n`;
        output += `  Bridge ID  Priority    32769  (priority 32768 sys-id-ext ${vlanId})\n`;
        output += `             Address     001e.1452.0000\n`;
        output += `             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec\n\n`;
        output += `Interface           Role Sts Cost      Prio.Nbr Type\n`;
        output += `------------------- ---- --- --------- -------- --------------------------------\n`;
        output += `Fa0/1               Desg FWD 19        128.1    P2p\n`;
        output += `Fa0/2               Desg FWD 19        128.2    P2p\n`;
      }
    }

    return output;
  }

  private getUserModeHelp(): string {
    return `Exec commands:
  enable         Turn on privileged commands
  exit           Exit from the EXEC
  logout         Exit from the EXEC
  show           Show running system information
`;
  }

  private getPrivilegedModeHelp(): string {
    return `Exec commands:
  configure      Enter configuration mode
  copy           Copy from one file to another
  disable        Turn off privileged commands
  exit           Exit from the EXEC
  show           Show running system information
  write          Write running configuration to memory
`;
  }

  private getShowHelp(): string {
    return `  interfaces        Interface status and configuration
  mac address-table MAC forwarding table
  running-config    Current operating configuration
  spanning-tree     Spanning tree topology
  version           System hardware and software status
  vlan              VTP VLAN status
`;
  }

  /**
   * Returns command prompt
   */
  public getPrompt(): string {
    const hostname = this.getHostname();

    if (this.awaitingPassword) {
      return 'Password: ';
    }

    switch (this.configMode) {
      case 'user':
        return `${hostname}>`;
      case 'privileged':
        return `${hostname}#`;
      case 'config':
        return `${hostname}(config)#`;
      case 'interface':
        return `${hostname}(config-if)#`;
      case 'vlan':
        return `${hostname}(config-vlan)#`;
      case 'line':
        return `${hostname}(config-line)#`;
      default:
        return `${hostname}>`;
    }
  }

  /**
   * Returns command history
   */
  public getCommandHistory(): string[] {
    return [...this.commandHistory];
  }
}
