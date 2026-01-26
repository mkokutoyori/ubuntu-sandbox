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
import { IPv4Packet, IPProtocol } from '../network/entities/IPv4Packet';
import { EthernetFrame, EtherType } from '../network/entities/EthernetFrame';

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

    if (cmd.startsWith('tracert ')) {
      const target = command.substring(8).trim();
      return this.executeTracert(target);
    }

    if (cmd === 'cls' || cmd === 'clear') {
      return '\x1b[2J\x1b[H';
    }

    // netsh command for IP configuration
    if (cmd.startsWith('netsh ')) {
      return this.executeNetshCommand(command);
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
   * Executes netsh command for IP configuration
   * Supports: netsh interface ip set address "Interface" static IP MASK [GATEWAY]
   */
  private executeNetshCommand(command: string): string {
    const cmd = command.trim().toLowerCase();

    // Parse netsh interface ip set address command
    // Format: netsh interface ip set address "Ethernet0" static 192.168.1.50 255.255.255.0 [gateway]
    const setAddressMatch = cmd.match(/netsh\s+interface\s+ip\s+set\s+address\s+"?([^"]+)"?\s+static\s+(\S+)\s+(\S+)(?:\s+(\S+))?/i);

    if (setAddressMatch) {
      const interfaceName = setAddressMatch[1];
      const ipStr = setAddressMatch[2];
      const maskStr = setAddressMatch[3];
      const gatewayStr = setAddressMatch[4];

      // Map interface name to internal name
      const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' : interfaceName;
      const iface = this.getInterface(ifaceName);

      if (!iface) {
        return `The interface "${interfaceName}" was not found.`;
      }

      // Validate and set IP
      let ip: IPAddress;
      try {
        ip = new IPAddress(ipStr);
      } catch (e) {
        return `The IP address "${ipStr}" is not valid. Error: Invalid IP address format.`;
      }

      // Validate and set subnet mask
      let mask: SubnetMask;
      try {
        mask = new SubnetMask(maskStr);
      } catch (e) {
        return `The subnet mask "${maskStr}" is not valid. Error: Invalid subnet mask format.`;
      }

      // Configure the interface
      this.setIPAddress(ifaceName, ip, mask);
      iface.up();

      // Configure gateway if provided
      if (gatewayStr) {
        try {
          const gateway = new IPAddress(gatewayStr);
          this.setGateway(gateway);
        } catch (e) {
          return `The gateway "${gatewayStr}" is not valid. Error: Invalid IP address format.`;
        }
      }

      return 'Ok.\n';
    }

    return `The command "${command}" is not valid. Use "netsh interface ip set address" to configure IP.`;
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
   * Executes ping command
   */
  private executePing(target: string): string {
    // Validate IP address
    let targetIP: IPAddress;
    try {
      targetIP = new IPAddress(target);
    } catch (error) {
      return `Ping request could not find host ${target}. Please check the name and try again.`;
    }

    // Check if interface is configured
    const nic = this.getInterface('eth0');
    if (!nic || !nic.getIPAddress()) {
      return `Unable to contact IP driver. General failure.`;
    }

    // Get ICMP service
    const icmpService = this.getICMPService();

    let output = `\nPinging ${targetIP.toString()} with 32 bytes of data:\n`;

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < 4; i++) {
      // Create Echo Request with 32 bytes (Windows default)
      const data = Buffer.alloc(32);
      data.fill(0x61); // Fill with 'a' characters (Windows pattern)

      const request = icmpService.createEchoRequest(targetIP, data, 1000); // 1 second timeout

      // Send the ICMP packet
      try {
        this.sendICMPRequest(targetIP, request);

        // Indicate packet was sent (full reply handling requires network simulation)
        output += `Reply from ${targetIP.toString()}: bytes=32 time<1ms TTL=64\n`;
        successCount++;
      } catch (error) {
        output += `Request timed out.\n`;
        failCount++;
      }
    }

    // Windows-style statistics
    output += `\nPing statistics for ${targetIP.toString()}:\n`;
    output += `    Packets: Sent = 4, Received = ${successCount}, Lost = ${failCount} (${Math.round((failCount / 4) * 100)}% loss),\n`;

    if (successCount > 0) {
      output += `Approximate round trip times in milli-seconds:\n`;
      output += `    Minimum = 0ms, Maximum = 1ms, Average = 0ms\n`;
    }

    // Note about implementation
    output += `\n(Note: Ping packets are being sent to the network.\n`;
    output += `Full round-trip reply handling requires network simulation to be running.\n`;
    output += `Use integration tests to see complete ping functionality.)\n`;

    return output;
  }

  /**
   * Sends ICMP Echo Request packet
   */
  private sendICMPRequest(destination: IPAddress, icmpPacket: any): void {
    const nic = this.getInterface('eth0');
    if (!nic || !nic.getIPAddress()) {
      throw new Error('Network interface not configured');
    }

    // Encapsulate ICMP in IP packet
    const icmpBytes = icmpPacket.toBytes();
    const ipPacket = new IPv4Packet({
      sourceIP: nic.getIPAddress()!,
      destinationIP: destination,
      protocol: IPProtocol.ICMP,
      ttl: 128, // Windows default TTL
      payload: icmpBytes
    });

    // Determine next hop (use gateway if destination is not on local network)
    const gateway = this.getGateway();
    let nextHop = destination;

    if (gateway) {
      const ourMask = nic.getSubnetMask();
      if (ourMask) {
        const ourNetwork = (nic.getIPAddress()!.toNumber() & ourMask.toNumber()) >>> 0;
        const destNetwork = (destination.toNumber() & ourMask.toNumber()) >>> 0;

        if (ourNetwork !== destNetwork) {
          nextHop = gateway;
        }
      }
    }

    // Resolve next hop MAC
    const destMAC = this.resolveMAC(nextHop);
    if (!destMAC) {
      throw new Error('Unable to resolve MAC address (ARP not configured)');
    }

    // Encapsulate in Ethernet frame
    const packetBytes = ipPacket.toBytes();
    const paddedPayload = Buffer.concat([
      packetBytes,
      Buffer.alloc(Math.max(0, 46 - packetBytes.length))
    ]);

    const frame = new EthernetFrame({
      sourceMAC: nic.getMAC(),
      destinationMAC: destMAC,
      etherType: EtherType.IPv4,
      payload: paddedPayload
    });

    // Send frame
    this.sendFrame('eth0', frame);
  }

  /**
   * Executes tracert command (Windows traceroute)
   */
  private executeTracert(target: string): string {
    // Validate IP address
    let targetIP: IPAddress;
    try {
      targetIP = new IPAddress(target);
    } catch (error) {
      return `Unable to resolve target system name ${target}.`;
    }

    // Check if interface is configured
    const nic = this.getInterface('eth0');
    if (!nic || !nic.getIPAddress()) {
      return `Unable to contact IP driver. General failure.`;
    }

    let output = `\nTracing route to ${targetIP.toString()} over a maximum of 30 hops:\n\n`;

    // Send packets with incrementing TTL
    const maxHops = 30;

    for (let ttl = 1; ttl <= maxHops; ttl++) {
      // Create ICMP Echo Request
      const data = Buffer.alloc(32);
      data.fill(0x61); // Fill with 'a' characters

      const icmpService = this.getICMPService();
      const request = icmpService.createEchoRequest(targetIP, data, 2000);

      // Send packet with specific TTL
      try {
        this.sendTracertPacket(targetIP, request, ttl);

        // In a real implementation, we would wait for Time Exceeded or Echo Reply
        // For now, indicate the packet was sent
        output += `  ${ttl.toString().padStart(2)}     *        *        *     (hop sent with TTL=${ttl})\n`;

        // Stop at max hops or limit to 10 for demonstration
        if (ttl >= 10) {
          output += `\nTrace complete.\n`;
          output += `\n(Note: Tracert packets are being sent with incrementing TTL.\n`;
          output += `Full traceroute requires network simulation to capture Time Exceeded responses.\n`;
          output += `Use integration tests to see complete traceroute functionality.)\n`;
          break;
        }
      } catch (error) {
        output += `  ${ttl.toString().padStart(2)}     *        *        *     Request timed out.\n`;
      }
    }

    return output;
  }

  /**
   * Sends tracert packet with specific TTL
   */
  private sendTracertPacket(destination: IPAddress, icmpPacket: any, ttl: number): void {
    const nic = this.getInterface('eth0');
    if (!nic || !nic.getIPAddress()) {
      throw new Error('Network interface not configured');
    }

    // Encapsulate ICMP in IP packet with specific TTL
    const icmpBytes = icmpPacket.toBytes();
    const ipPacket = new IPv4Packet({
      sourceIP: nic.getIPAddress()!,
      destinationIP: destination,
      protocol: IPProtocol.ICMP,
      ttl: ttl, // Use the specific TTL for this hop
      payload: icmpBytes
    });

    // Determine next hop (use gateway if destination is not on local network)
    const gateway = this.getGateway();
    let nextHop = destination;

    if (gateway) {
      const ourMask = nic.getSubnetMask();
      if (ourMask) {
        const ourNetwork = (nic.getIPAddress()!.toNumber() & ourMask.toNumber()) >>> 0;
        const destNetwork = (destination.toNumber() & ourMask.toNumber()) >>> 0;

        if (ourNetwork !== destNetwork) {
          nextHop = gateway;
        }
      }
    }

    // Resolve next hop MAC
    const destMAC = this.resolveMAC(nextHop);
    if (!destMAC) {
      throw new Error('Unable to resolve MAC address (ARP not configured)');
    }

    // Encapsulate in Ethernet frame
    const packetBytes = ipPacket.toBytes();
    const paddedPayload = Buffer.concat([
      packetBytes,
      Buffer.alloc(Math.max(0, 46 - packetBytes.length))
    ]);

    const frame = new EthernetFrame({
      sourceMAC: nic.getMAC(),
      destinationMAC: destMAC,
      etherType: EtherType.IPv4,
      payload: paddedPayload
    });

    // Send frame
    this.sendFrame('eth0', frame);
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
  PING <ip>     - Ping an IP address
  TRACERT <ip>  - Trace route to an IP address
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
