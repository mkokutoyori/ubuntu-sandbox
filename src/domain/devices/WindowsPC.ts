/**
 * WindowsPC - Windows workstation with terminal emulation
 *
 * Extends PC with Windows terminal capabilities:
 * - Command execution (cmd/PowerShell-like)
 * - Windows-specific networking commands
 * - File system simulation
 *
 * @example
 * ```typescript
 * const windows = new WindowsPC({ id: 'pc1', name: 'Windows PC' });
 * windows.powerOn();
 *
 * const result = await windows.executeCommand('ipconfig');
 * console.log(result);
 * ```
 */

import { PC } from './PC';
import { DeviceConfig, OSType } from './types';
import { IPAddress } from '../network/value-objects/IPAddress';
import { SubnetMask } from '../network/value-objects/SubnetMask';

/**
 * WindowsPC - Windows workstation device
 */
export class WindowsPC extends PC {
  private commandHistory: string[];

  constructor(config: DeviceConfig) {
    // Create PC with windows-pc type
    const id = config.id || `windows-pc-${Date.now()}`;
    const name = config.name || id;

    super(id, name);

    // Override type to windows-pc
    (this as any).type = 'windows-pc';

    // Set UI properties if provided
    if (config.hostname) {
      this.setHostname(config.hostname);
    }
    if (config.x !== undefined && config.y !== undefined) {
      this.setPosition(config.x, config.y);
    }

    this.commandHistory = [];

    // Power on if requested
    if (config.isPoweredOn !== false) {
      this.powerOn();
    }
  }

  /**
   * Returns OS type for terminal emulation
   */
  public getOSType(): OSType {
    return 'windows';
  }

  /**
   * Executes a Windows command
   *
   * @param command - Command to execute
   * @returns Command output
   */
  public async executeCommand(command: string): Promise<string> {
    if (!this.isOnline()) {
      return 'Device is offline';
    }

    this.commandHistory.push(command);

    // Parse and execute command (case-insensitive)
    const cmd = command.trim().toLowerCase();

    // Basic Windows commands
    if (cmd === 'cd' || cmd === 'pwd') {
      return 'C:\\Users\\User';
    }

    if (cmd.startsWith('echo ')) {
      return command.substring(5);
    }

    if (cmd === 'whoami') {
      return `${this.getHostname()}\\User`;
    }

    if (cmd === 'hostname') {
      return this.getHostname();
    }

    if (cmd === 'ver') {
      return 'Microsoft Windows [Version 10.0.19045.3803]';
    }

    if (cmd === 'systeminfo' || cmd === 'systeminfo | findstr os') {
      return this.getSystemInfo();
    }

    // Networking commands
    if (cmd === 'ipconfig' || cmd === 'ipconfig /all') {
      return this.getIpconfigOutput(cmd.includes('/all'));
    }

    if (cmd === 'route print') {
      return this.getRouteOutput();
    }

    if (cmd === 'arp' || cmd === 'arp -a') {
      return this.getArpOutput();
    }

    if (cmd.startsWith('ping ')) {
      const target = command.substring(5).trim();
      return this.executePing(target);
    }

    if (cmd === 'cls' || cmd === 'clear') {
      return '\x1b[2J\x1b[H';
    }

    if (cmd === 'doskey /history' || cmd === 'history') {
      return this.commandHistory.join('\n');
    }

    if (cmd === 'help' || cmd === '/?') {
      return this.getHelpOutput();
    }

    // Unknown command
    return `'${command.split(' ')[0]}' is not recognized as an internal or external command,\noperable program or batch file.`;
  }

  /**
   * Returns system info output
   */
  private getSystemInfo(): string {
    return `Host Name:                 ${this.getHostname()}
OS Name:                   Microsoft Windows 10 Pro
OS Version:                10.0.19045 N/A Build 19045
OS Manufacturer:           Microsoft Corporation
System Type:               x64-based PC`;
  }

  /**
   * Returns ipconfig output
   */
  private getIpconfigOutput(all: boolean): string {
    const iface = this.getInterface('eth0');

    if (!iface) {
      return 'No network adapters configured';
    }

    const ip = iface.getIPAddress();
    const mask = iface.getSubnetMask();
    const mac = iface.getMAC();
    const gateway = this.getGateway();

    let output = 'Windows IP Configuration\n\n';
    output += 'Ethernet adapter Ethernet0:\n\n';

    const status = iface.isUp() ? 'Up' : 'Down';
    output += `   Connection-specific DNS Suffix  . : \n`;

    if (all) {
      output += `   Description . . . . . . . . . . . : Intel(R) 82574L Gigabit Network Connection\n`;
      output += `   Physical Address. . . . . . . . . : ${mac.toString()}\n`;
      output += `   DHCP Enabled. . . . . . . . . . . : No\n`;
      output += `   Autoconfiguration Enabled . . . . : Yes\n`;
    }

    if (ip) {
      output += `   IPv4 Address. . . . . . . . . . . : ${ip.toString()}\n`;
      output += `   Subnet Mask . . . . . . . . . . . : ${mask ? mask.toString() : '255.255.255.0'}\n`;
    }

    if (gateway) {
      output += `   Default Gateway . . . . . . . . . : ${gateway.toString()}\n`;
    }

    return output;
  }

  /**
   * Returns route output
   */
  private getRouteOutput(): string {
    const gateway = this.getGateway();
    const iface = this.getInterface('eth0');

    if (!iface) {
      return 'No network interfaces configured';
    }

    const ip = iface.getIPAddress();
    const mask = iface.getSubnetMask();

    let output = '===========================================================================\n';
    output += 'Interface List\n';
    output += '  1...........................Software Loopback Interface 1\n';
    output += `  2...${iface.getMAC().toString().replace(/:/g, ' ')} ......Intel(R) 82574L Gigabit Network Connection\n`;
    output += '===========================================================================\n\n';
    output += 'IPv4 Route Table\n';
    output += '===========================================================================\n';
    output += 'Active Routes:\n';
    output += 'Network Destination        Netmask          Gateway       Interface  Metric\n';

    if (ip && mask) {
      const network = this.getNetwork(ip, mask);
      output += `${network.padEnd(27)}${mask.toString().padEnd(17)}${ip.toString().padEnd(14)}${ip.toString().padEnd(11)}281\n`;
    }

    if (gateway) {
      output += `${'0.0.0.0'.padEnd(27)}${'0.0.0.0'.padEnd(17)}${gateway.toString().padEnd(14)}${ip ? ip.toString().padEnd(11) : ''.padEnd(11)}281\n`;
    }

    output += '===========================================================================\n';

    return output;
  }

  /**
   * Returns ARP output
   */
  private getArpOutput(): string {
    const entries = this.getARPTable();
    const iface = this.getInterface('eth0');

    if (!iface) {
      return 'No network interfaces configured';
    }

    const ip = iface.getIPAddress();

    let output = `\nInterface: ${ip ? ip.toString() : '0.0.0.0'} --- 0x2\n`;
    output += '  Internet Address      Physical Address      Type\n';

    if (entries.length === 0) {
      return output + '  No ARP Entries Found\n';
    }

    for (const entry of entries) {
      output += `  ${entry.ip.toString().padEnd(22)}${entry.mac.toString().replace(/:/g, '-').padEnd(22)}dynamic\n`;
    }

    return output;
  }

  /**
   * Executes ping command (stub)
   */
  private executePing(target: string): string {
    return `Pinging ${target} with 32 bytes of data:\nPing functionality will be implemented in future sprint.`;
  }

  /**
   * Returns help output
   */
  private getHelpOutput(): string {
    return `Available commands:
  CD            - Print current directory
  ECHO <text>   - Print text
  WHOAMI        - Print current user
  HOSTNAME      - Print hostname
  VER           - Print Windows version
  SYSTEMINFO    - Print system information
  IPCONFIG      - Display network configuration
  IPCONFIG /ALL - Display detailed network configuration
  ROUTE PRINT   - Display routing table
  ARP -A        - Display ARP table
  PING <ip>     - Ping an IP address (stub)
  CLS           - Clear screen
  HELP          - Show this help message

For more information on a specific command, type HELP command-name
`;
  }

  /**
   * Calculates network address
   */
  private getNetwork(ip: IPAddress, mask: SubnetMask): string {
    const ipNum = ip.toNumber();
    const maskNum = mask.toNumber();
    const network = (ipNum & maskNum) >>> 0;

    return IPAddress.fromNumber(network).toString();
  }

  /**
   * Returns command history
   */
  public getCommandHistory(): string[] {
    return [...this.commandHistory];
  }

  /**
   * Clears command history
   */
  public clearHistory(): void {
    this.commandHistory = [];
  }
}
