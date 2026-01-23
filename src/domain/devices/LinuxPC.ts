/**
 * LinuxPC - Linux workstation with terminal emulation
 *
 * Extends PC with Linux terminal capabilities:
 * - Command execution (bash-like)
 * - Linux-specific networking commands
 * - File system simulation
 *
 * @example
 * ```typescript
 * const linux = new LinuxPC({ id: 'pc1', name: 'Ubuntu PC' });
 * linux.powerOn();
 *
 * const result = await linux.executeCommand('ifconfig');
 * console.log(result);
 * ```
 */

import { PC } from './PC';
import { DeviceConfig, OSType } from './types';
import { IPAddress } from '../network/value-objects/IPAddress';
import { SubnetMask } from '../network/value-objects/SubnetMask';

/**
 * LinuxPC - Linux workstation device
 */
export class LinuxPC extends PC {
  private commandHistory: string[];

  constructor(config: DeviceConfig) {
    // Create PC with linux-pc type
    const id = config.id || `linux-pc-${Date.now()}`;
    const name = config.name || id;

    super(id, name);

    // Override type to linux-pc
    (this as any).type = 'linux-pc';

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
    return 'linux';
  }

  /**
   * Executes a Linux command
   *
   * @param command - Command to execute
   * @returns Command output
   */
  public async executeCommand(command: string): Promise<string> {
    if (!this.isOnline()) {
      return 'Device is offline';
    }

    this.commandHistory.push(command);

    // Parse and execute command
    const cmd = command.trim();

    // Basic Linux commands
    if (cmd === 'pwd') {
      return '/home/user';
    }

    if (cmd.startsWith('echo ')) {
      return cmd.substring(5);
    }

    if (cmd === 'whoami') {
      return 'user';
    }

    if (cmd === 'hostname') {
      return this.getHostname();
    }

    if (cmd === 'uname' || cmd === 'uname -a') {
      return 'Linux ubuntu 5.15.0-generic #1 SMP x86_64 GNU/Linux';
    }

    // Networking commands
    if (cmd === 'ifconfig' || cmd === 'ip addr' || cmd === 'ip a') {
      return this.getIfconfigOutput();
    }

    if (cmd === 'route' || cmd === 'ip route') {
      return this.getRouteOutput();
    }

    if (cmd === 'arp' || cmd === 'arp -a') {
      return this.getArpOutput();
    }

    if (cmd.startsWith('ping ')) {
      const target = cmd.substring(5).trim();
      return this.executePing(target);
    }

    if (cmd === 'clear') {
      return '\x1b[2J\x1b[H';
    }

    if (cmd === 'history') {
      return this.commandHistory
        .map((c, i) => `  ${i + 1}  ${c}`)
        .join('\n');
    }

    if (cmd === 'help' || cmd === '--help') {
      return this.getHelpOutput();
    }

    // Unknown command
    return `bash: ${cmd.split(' ')[0]}: command not found`;
  }

  /**
   * Returns ifconfig output
   */
  private getIfconfigOutput(): string {
    const iface = this.getInterface('eth0');

    if (!iface) {
      return 'No network interfaces configured';
    }

    const ip = iface.getIPAddress();
    const mask = iface.getSubnetMask();
    const mac = iface.getMAC();
    const isUp = iface.isUp();

    let output = `eth0: flags=${isUp ? '4163<UP,BROADCAST,RUNNING,MULTICAST>' : '4098<BROADCAST,MULTICAST>'}  mtu 1500\n`;

    if (ip) {
      output += `        inet ${ip.toString()}  netmask ${mask ? mask.toString() : '255.255.255.0'}  broadcast ${this.getBroadcast(ip, mask)}\n`;
    }

    output += `        ether ${mac.toString()}  txqueuelen 1000  (Ethernet)\n`;
    output += `        RX packets 0  bytes 0 (0.0 B)\n`;
    output += `        TX packets 0  bytes 0 (0.0 B)\n`;

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

    let output = 'Kernel IP routing table\n';
    output += 'Destination     Gateway         Genmask         Flags Metric Ref    Use Iface\n';

    if (ip && mask) {
      const network = this.getNetwork(ip, mask);
      output += `${network}    0.0.0.0         ${mask.toString()}   U     0      0        0 eth0\n`;
    }

    if (gateway) {
      output += `0.0.0.0         ${gateway.toString()}     0.0.0.0         UG    0      0        0 eth0\n`;
    }

    return output;
  }

  /**
   * Returns ARP output
   */
  private getArpOutput(): string {
    const entries = this.getARPTable();

    if (entries.length === 0) {
      return 'No ARP entries';
    }

    let output = 'Address                  HWtype  HWaddress           Flags Mask            Iface\n';

    for (const entry of entries) {
      output += `${entry.ip.toString().padEnd(24)} ether   ${entry.mac.toString().padEnd(20)} C                     eth0\n`;
    }

    return output;
  }

  /**
   * Executes ping command (stub)
   */
  private executePing(target: string): string {
    return `PING ${target} (${target}) 56(84) bytes of data.\nPing functionality will be implemented in future sprint.`;
  }

  /**
   * Returns help output
   */
  private getHelpOutput(): string {
    return `Available commands:
  pwd           - Print working directory
  echo <text>   - Print text
  whoami        - Print current user
  hostname      - Print hostname
  uname         - Print system information
  ifconfig      - Display network interfaces
  ip addr       - Display network interfaces
  route         - Display routing table
  ip route      - Display routing table
  arp           - Display ARP table
  ping <ip>     - Ping an IP address (stub)
  clear         - Clear screen
  history       - Show command history
  help          - Show this help message
`;
  }

  /**
   * Calculates broadcast address
   */
  private getBroadcast(ip: IPAddress, mask: SubnetMask | null): string {
    if (!mask) {
      return '0.0.0.0';
    }

    const ipNum = ip.toNumber();
    const maskNum = mask.toNumber();
    const broadcast = (ipNum | (~maskNum >>> 0)) >>> 0;

    return IPAddress.fromNumber(broadcast).toString();
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
