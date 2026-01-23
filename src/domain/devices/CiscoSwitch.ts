/**
 * CiscoSwitch - Cisco IOS switch with terminal emulation
 *
 * Extends Switch with Cisco IOS terminal capabilities:
 * - IOS command execution
 * - Configuration modes (user EXEC, privileged EXEC, config)
 * - Cisco-specific commands
 * - VLAN management
 *
 * @example
 * ```typescript
 * const sw = new CiscoSwitch({ id: 's1', name: 'Switch 1' });
 * sw.powerOn();
 *
 * const result = await sw.executeCommand('show mac address-table');
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
 * CiscoSwitch - Cisco IOS switch device
 */
export class CiscoSwitch extends Switch {
  private commandHistory: string[];
  private configMode: ConfigMode;
  private enablePassword: string;
  private isEnabled: boolean;

  constructor(config: DeviceConfig) {
    // Create Switch with cisco-switch type
    const id = config.id || `cisco-switch-${Date.now()}`;
    const name = config.name || id;

    // Cisco switches typically have 24 ports
    super(id, name, 24);

    // Override type to cisco-switch
    (this as any).type = 'cisco-switch';

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

    if (cmd === 'show interfaces status' || cmd === 'sh int status') {
      return this.getInterfaceStatusOutput();
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

    return '';
  }

  /**
   * Returns version output
   */
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

cisco WS-C2960-24TT-L (PowerPC405) processor (revision B0) with 65536K bytes of memory.
Processor board ID FOC1010X104
Last reset from power-on
1 Virtual Ethernet interface
24 FastEthernet interfaces
2 Gigabit Ethernet interfaces
The password-recovery mechanism is enabled.

64K bytes of flash-simulated non-volatile configuration memory.
Base ethernet MAC Address       : 00:1E:14:52:00:00
Motherboard assembly number     : 73-10390-03
Power supply part number        : 341-0097-02
Motherboard serial number       : FOC10093R12
Power supply serial number      : AZS1007032H
Model revision number           : B0
Motherboard revision number     : B0
Model number                    : WS-C2960-24TT-L
System serial number            : FOC1010X104
Top Assembly Part Number        : 800-27221-02
Top Assembly Revision Number    : A0
Version ID                      : V02
CLEI Code Number                : COM3L00BRA
Hardware Board Revision Number  : 0x01

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
    let output = 'VLAN Name                             Status    Ports\n';
    output += '---- -------------------------------- --------- -------------------------------\n';
    output += '1    default                          active    ';

    // List all ports in VLAN 1
    const ports = this.getPorts();
    const vlan1Ports = ports.slice(0, 8).join(', ');
    output += vlan1Ports + '\n';

    if (ports.length > 8) {
      output += '                                                ';
      output += ports.slice(8, 16).join(', ') + '\n';
    }

    if (ports.length > 16) {
      output += '                                                ';
      output += ports.slice(16).join(', ') + '\n';
    }

    output += '\n1002 fddi-default                     act/unsup\n';
    output += '1003 token-ring-default               act/unsup\n';
    output += '1004 fddinet-default                  act/unsup\n';
    output += '1005 trnet-default                    act/unsup\n';

    return output;
  }

  /**
   * Returns interface status output
   */
  private getInterfaceStatusOutput(): string {
    let output = '\nPort      Name               Status       Vlan       Duplex  Speed Type\n';

    const ports = this.getPorts().slice(0, 24); // Show first 24 ports

    for (const port of ports) {
      const status = 'notconnect';
      const vlan = '1';
      const duplex = 'auto';
      const speed = 'auto';
      const type = port.includes('Gi') ? '10/100/1000BaseTX' : '10/100BaseTX';

      output += `${port.padEnd(10)}${' '.padEnd(19)}${status.padEnd(13)}${vlan.padEnd(11)}${duplex.padEnd(8)}${speed.padEnd(6)}${type}\n`;
    }

    return output;
  }

  /**
   * Returns running config output
   */
  private getRunningConfigOutput(): string {
    let output = 'Building configuration...\n\nCurrent configuration : 1024 bytes\n!\nversion 15.0\n';
    output += 'no service pad\n';
    output += 'service timestamps debug datetime msec\n';
    output += 'service timestamps log datetime msec\n';
    output += '!\n';
    output += `hostname ${this.getHostname()}\n`;
    output += '!\n!\n';

    // Show interface configs
    const ports = this.getPorts().slice(0, 5); // Show first few
    for (const port of ports) {
      output += `interface ${port}\n`;
      output += ' switchport mode access\n';
      output += ' switchport access vlan 1\n';
      output += '!\n';
    }

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
  show interfaces status      - Interface status
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
