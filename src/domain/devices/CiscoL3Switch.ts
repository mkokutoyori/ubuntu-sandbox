/**
 * CiscoL3Switch - Cisco IOS Layer 3 switch with terminal emulation
 *
 * Extends Switch with routing capabilities and Cisco IOS terminal:
 * - IOS command execution
 * - Layer 3 switching (routing)
 * - VLAN and inter-VLAN routing
 * - Cisco-specific commands
 *
 * @example
 * ```typescript
 * const sw = new CiscoL3Switch({ id: 's1', name: 'Core Switch' });
 * sw.powerOn();
 *
 * const result = await sw.executeCommand('show ip route');
 * console.log(result);
 * ```
 */

import { Switch } from './Switch';
import { DeviceConfig, OSType } from './types';

/**
 * Configuration mode
 */
type ConfigMode = 'user' | 'privileged' | 'config' | 'interface' | 'vlan';

/**
 * CiscoL3Switch - Cisco IOS Layer 3 switch device
 */
export class CiscoL3Switch extends Switch {
  private commandHistory: string[];
  private configMode: ConfigMode;
  private enablePassword: string;
  private isEnabled: boolean;

  constructor(config: DeviceConfig) {
    // Create Switch with cisco-l3-switch type
    const id = config.id || `cisco-l3-switch-${Date.now()}`;
    const name = config.name || id;

    // Cisco L3 switches typically have 24 ports
    super(id, name, 24);

    // Override type to cisco-l3-switch
    (this as any).type = 'cisco-l3-switch';

    // Set UI properties if provided
    if (config.hostname) {
      this.setHostname(config.hostname);
    }
    if (config.x !== undefined && config.y !== undefined) {
      this.setPosition(config.x, config.y);
    }

    this.commandHistory = [];
    this.configMode = 'user';
    this.enablePassword = 'cisco';
    this.isEnabled = false;

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
   * Executes a Cisco IOS command
   *
   * @param command - Command to execute
   * @returns Command output
   */
  public async executeCommand(command: string): Promise<string> {
    if (!this.isOnline()) {
      return 'Device is offline';
    }

    this.commandHistory.push(command);

    const cmd = command.trim();

    // Handle empty command
    if (!cmd) {
      return '';
    }

    // Configuration mode commands
    if (this.configMode === 'config' || this.configMode === 'vlan') {
      return this.executeConfigCommand(cmd);
    }

    // Privileged EXEC mode
    if (this.isEnabled || this.configMode === 'privileged') {
      if (cmd === 'configure terminal' || cmd === 'conf t') {
        this.configMode = 'config';
        return 'Enter configuration commands, one per line.  End with CNTL/Z.';
      }

      if (cmd.startsWith('show ')) {
        return this.executeShowCommand(cmd);
      }
    }

    // User EXEC mode
    if (cmd === 'enable') {
      this.isEnabled = true;
      this.configMode = 'privileged';
      return '';
    }

    if (cmd === 'disable' || cmd === 'exit') {
      this.isEnabled = false;
      this.configMode = 'user';
      return '';
    }

    if (cmd === '?') {
      return this.getHelpOutput();
    }

    if (cmd.startsWith('show ') && !this.isEnabled) {
      return '% Invalid input detected at \'^\'marker.';
    }

    // Unknown command
    return `% Invalid input detected at '^' marker.`;
  }

  /**
   * Executes show commands
   */
  private executeShowCommand(cmd: string): string {
    if (cmd === 'show version') {
      return this.getVersionOutput();
    }

    if (cmd === 'show mac address-table' || cmd === 'sh mac add') {
      return this.getMACTableOutput();
    }

    if (cmd === 'show vlan' || cmd === 'sh vlan') {
      return this.getVLANOutput();
    }

    if (cmd === 'show ip route') {
      return this.getRouteTableOutput();
    }

    if (cmd === 'show ip interface brief' || cmd === 'sh ip int br') {
      return this.getIPInterfaceOutput();
    }

    if (cmd === 'show running-config' || cmd === 'sh run') {
      return this.getRunningConfigOutput();
    }

    return `% Invalid input detected at '^' marker.`;
  }

  /**
   * Executes configuration commands
   */
  private executeConfigCommand(cmd: string): string {
    if (cmd === 'end' || cmd === 'exit') {
      this.configMode = 'privileged';
      return '';
    }

    if (cmd.startsWith('hostname ')) {
      const hostname = cmd.substring(9).trim();
      this.setHostname(hostname);
      return '';
    }

    if (cmd.startsWith('interface ')) {
      this.configMode = 'interface';
      return '';
    }

    if (cmd.startsWith('vlan ')) {
      this.configMode = 'vlan';
      return '';
    }

    if (cmd === 'ip routing') {
      // Enable IP routing (stub)
      return '';
    }

    return '';
  }

  /**
   * Returns version output
   */
  private getVersionOutput(): string {
    return `Cisco IOS Software, C3750 Software (C3750-IPSERVICESK9-M), Version 15.0(2)SE, RELEASE SOFTWARE (fc3)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2012 by Cisco Systems, Inc.
Compiled Sat 28-Jul-12 00:29 by prod_rel_team

ROM: Bootstrap program is C3750 boot loader
BOOTLDR: C3750 Boot Loader (C3750-HBOOT-M) Version 12.2(53r)SE2, RELEASE SOFTWARE (fc1)

${this.getHostname()} uptime is 0 minutes
System returned to ROM by power-on
System image file is "flash:/c3750-ipservicesk9-mz.150-2.SE.bin"

Cisco WS-C3750-24TS (PowerPC405) processor (revision C0) with 131072K bytes of memory.
Processor board ID FOC1031Z7MH
Last reset from power-on
1 Virtual Ethernet interface
24 Gigabit Ethernet interfaces
The password-recovery mechanism is enabled.

512K bytes of flash-simulated non-volatile configuration memory.
Base ethernet MAC Address       : 00:1D:45:3E:2F:00
Motherboard assembly number     : 73-9676-09
Power supply part number        : 341-0097-02
Motherboard serial number       : FOC10312L5D
Power supply serial number      : AZS1031722Q
Model revision number           : C0
Motherboard revision number     : C0
Model number                    : WS-C3750-24TS-S
System serial number            : FOC1031Z7MH
Top Assembly Part Number        : 800-26857-03
Top Assembly Revision Number    : C0
Version ID                      : V03
CLEI Code Number                : COM3K00ARB

Configuration register is 0xF`;
  }

  /**
   * Returns MAC address table output
   */
  private getMACTableOutput(): string {
    const macTable = this.getMACTable();

    let output = '          Mac Address Table\n';
    output += '-------------------------------------------\n\n';
    output += 'Vlan    Mac Address       Type        Ports\n';
    output += '----    -----------       --------    -----\n';

    if (macTable.size === 0) {
      return output + 'Total Mac Addresses for this criterion: 0\n';
    }

    for (const [mac, entry] of macTable.entries()) {
      const vlan = entry.vlanId || 1;
      output += `${vlan.toString().padEnd(8)}${mac.toString().padEnd(18)}DYNAMIC     ${entry.port}\n`;
    }

    output += `Total Mac Addresses for this criterion: ${macTable.size}\n`;

    return output;
  }

  /**
   * Returns VLAN output
   */
  private getVLANOutput(): string {
    return 'VLAN Name                             Status    Ports\n' +
      '---- -------------------------------- --------- -------------------------------\n' +
      '1    default                          active    All Ports\n' +
      '\n' +
      '1002 fddi-default                     act/unsup\n' +
      '1003 token-ring-default               act/unsup\n' +
      '1004 fddinet-default                  act/unsup\n' +
      '1005 trnet-default                    act/unsup\n';
  }

  /**
   * Returns routing table output (stub)
   */
  private getRouteTableOutput(): string {
    return `Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2
       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2
       ia - IS-IS inter area, * - candidate default, U - per-user static route
       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP
       + - replicated route, % - next hop override

Gateway of last resort is not set

(Routing table will be implemented in future sprint)
`;
  }

  /**
   * Returns IP interface brief output
   */
  private getIPInterfaceOutput(): string {
    return 'Interface              IP-Address      OK? Method Status                Protocol\n' +
      'Vlan1                  unassigned      YES NVRAM  administratively down down\n';
  }

  /**
   * Returns running config output
   */
  private getRunningConfigOutput(): string {
    let output = 'Building configuration...\n\nCurrent configuration : 2048 bytes\n!\nversion 15.0\n';
    output += 'no service pad\n';
    output += 'service timestamps debug datetime msec\n';
    output += 'service timestamps log datetime msec\n';
    output += '!\n';
    output += `hostname ${this.getHostname()}\n`;
    output += '!\n';
    output += 'ip routing\n';
    output += '!\n!\n';
    output += 'interface Vlan1\n';
    output += ' no ip address\n';
    output += ' shutdown\n';
    output += '!\n';
    output += 'end\n';

    return output;
  }

  /**
   * Returns help output
   */
  private getHelpOutput(): string {
    if (!this.isEnabled) {
      return `User Access Verification

Available commands:
  enable      - Enter privileged EXEC mode
  ?           - Show available commands
`;
    }

    return `Exec commands:
  configure   - Enter configuration mode
  disable     - Exit privileged mode
  exit        - Exit from the EXEC
  show        - Show running system information
  ?           - Show available commands

Show commands:
  show version                - System hardware and software status
  show mac address-table      - MAC forwarding table
  show vlan                   - VLAN status and configuration
  show ip route               - IP routing table (L3 feature)
  show ip interface brief     - IP interface summary
  show running-config         - Current operating configuration
`;
  }

  /**
   * Returns command prompt
   */
  public getPrompt(): string {
    const hostname = this.getHostname();

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
