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
import { IPv4Packet } from '../network/entities/IPv4Packet';
import { EthernetFrame, EtherType } from '../network/entities/EthernetFrame';

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

    // ifconfig with arguments for IP configuration
    if (cmd.startsWith('ifconfig ')) {
      return this.executeIfconfigCommand(cmd);
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

    if (cmd.startsWith('traceroute ') || cmd.startsWith('tracert ')) {
      const target = cmd.startsWith('traceroute ')
        ? cmd.substring(11).trim()
        : cmd.substring(8).trim();
      return this.executeTraceroute(target);
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
   * Executes ifconfig command with arguments
   * Supports: ifconfig <interface> <ip> netmask <mask> [up|down]
   *           ifconfig <interface> up|down
   */
  private executeIfconfigCommand(cmd: string): string {
    const parts = cmd.split(/\s+/);
    // parts[0] = 'ifconfig', parts[1] = interface name

    if (parts.length < 2) {
      return this.getIfconfigOutput();
    }

    const ifaceName = parts[1];
    const iface = this.getInterface(ifaceName);

    if (!iface) {
      return `ifconfig: error: interface '${ifaceName}' not found`;
    }

    // ifconfig eth0 up/down
    if (parts.length === 3 && (parts[2] === 'up' || parts[2] === 'down')) {
      if (parts[2] === 'up') {
        iface.up();
      } else {
        iface.down();
      }
      return '';
    }

    // ifconfig eth0 <ip> netmask <mask> [up]
    if (parts.length >= 2) {
      // Check if just "ifconfig eth0" - show interface info
      if (parts.length === 2) {
        return this.getIfconfigOutput();
      }

      // Get IP address
      const ipStr = parts[2];
      let ip: IPAddress;
      try {
        ip = new IPAddress(ipStr);
      } catch (e) {
        return `ifconfig: error: invalid IP address '${ipStr}'`;
      }

      // Look for netmask
      let mask: SubnetMask = new SubnetMask('/24'); // Default mask
      const netmaskIndex = parts.indexOf('netmask');
      if (netmaskIndex !== -1 && parts[netmaskIndex + 1]) {
        try {
          mask = new SubnetMask(parts[netmaskIndex + 1]);
        } catch (e) {
          return `ifconfig: error: invalid netmask '${parts[netmaskIndex + 1]}'`;
        }
      }

      // Configure the interface
      this.setIPAddress(ifaceName, ip, mask);

      // Check for up/down flag at the end
      const lastArg = parts[parts.length - 1];
      if (lastArg === 'up') {
        iface.up();
      } else if (lastArg === 'down') {
        iface.down();
      } else {
        // By default, bringing up the interface when configuring IP
        iface.up();
      }

      return '';
    }

    return `ifconfig: error: invalid arguments`;
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
   * Executes ping command
   */
  private executePing(target: string): string {
    // Validate and parse target IP
    try {
      const targetIP = new IPAddress(target);

      // Check if device is powered on
      if (!this.isOnline()) {
        return 'Network is unreachable';
      }

      // Get our IP and check configuration
      const nic = this.getInterface('eth0');
      if (!nic || !nic.getIPAddress()) {
        return 'Network interface not configured';
      }

      // Send ping asynchronously (simulate with promise)
      const result = this.sendPing(targetIP);
      return result;
    } catch (error) {
      return `ping: ${target}: Name or service not known`;
    }
  }

  /**
   * Sends ping to target
   * Simplified synchronous version for terminal simulation
   */
  private sendPing(targetIP: IPAddress): string {
    const nic = this.getInterface('eth0');
    if (!nic) {
      return 'Network interface error';
    }

    const icmpService = this.getICMPService();
    let output = `PING ${targetIP.toString()} (${targetIP.toString()}) 56(84) bytes of data.\n`;

    // Send 4 packets (standard ping count)
    let successCount = 0;
    let failCount = 0;
    const rtts: number[] = [];

    for (let i = 0; i < 4; i++) {
      // Create Echo Request
      const data = Buffer.alloc(56); // Standard ping data size
      data.write(`Ping data ${i}`, 0);

      const request = icmpService.createEchoRequest(targetIP, data, 1000); // 1 second timeout

      // Send the ICMP packet
      try {
        this.sendICMPRequest(targetIP, request);

        // Simulate reply (in real implementation would wait for actual reply)
        // For now, indicate packet was sent
        output += `64 bytes from ${targetIP.toString()}: icmp_seq=${i + 1} (sent)\n`;
        successCount++;
      } catch (error) {
        output += `Request timeout for icmp_seq ${i + 1}\n`;
        failCount++;
      }
    }

    // Statistics
    output += `\n--- ${targetIP.toString()} ping statistics ---\n`;
    output += `4 packets transmitted, ${successCount} sent, ${failCount} failed\n`;

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
      protocol: 1, // ICMP
      ttl: 64,
      payload: icmpBytes
    });

    // Determine next hop (use gateway if destination is not on local network)
    const gateway = this.getGateway();
    let nextHop = destination;

    if (gateway) {
      // Simple check: if destination is not in our subnet, use gateway
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
   * Executes traceroute command
   */
  private executeTraceroute(target: string): string {
    // Validate IP address
    let targetIP: IPAddress;
    try {
      targetIP = new IPAddress(target);
    } catch (error) {
      return `traceroute: unknown host ${target}`;
    }

    // Check if interface is configured
    const nic = this.getInterface('eth0');
    if (!nic || !nic.getIPAddress()) {
      return `traceroute: network interface not configured`;
    }

    let output = `traceroute to ${targetIP.toString()}, 30 hops max, 60 byte packets\n`;

    // Send packets with incrementing TTL
    const maxHops = 30;
    let hopNumber = 1;

    for (let ttl = 1; ttl <= maxHops; ttl++) {
      // Create ICMP Echo Request
      const data = Buffer.alloc(32);
      data.write(`Traceroute hop ${ttl}`, 0);

      const icmpService = this.getICMPService();
      const request = icmpService.createEchoRequest(targetIP, data, 2000);

      // Send packet with specific TTL
      try {
        this.sendTraceroutePacket(targetIP, request, ttl);

        // In a real implementation, we would wait for Time Exceeded or Echo Reply
        // For now, indicate the packet was sent
        output += ` ${hopNumber}  * * * (hop sent with TTL=${ttl})\n`;

        hopNumber++;

        // Stop at max hops or when we would reach destination
        if (ttl >= 10) {
          output += `\n(Note: Traceroute packets are being sent with incrementing TTL.\n`;
          output += `Full traceroute requires network simulation to capture Time Exceeded responses.\n`;
          output += `Use integration tests to see complete traceroute functionality.)\n`;
          break;
        }
      } catch (error) {
        output += ` ${hopNumber}  * * * Request timeout\n`;
        hopNumber++;
      }
    }

    return output;
  }

  /**
   * Sends traceroute packet with specific TTL
   */
  private sendTraceroutePacket(destination: IPAddress, icmpPacket: any, ttl: number): void {
    const nic = this.getInterface('eth0');
    if (!nic || !nic.getIPAddress()) {
      throw new Error('Network interface not configured');
    }

    // Encapsulate ICMP in IP packet with specific TTL
    const icmpBytes = icmpPacket.toBytes();
    const ipPacket = new IPv4Packet({
      sourceIP: nic.getIPAddress()!,
      destinationIP: destination,
      protocol: 1, // ICMP
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
  ping <ip>     - Ping an IP address
  traceroute <ip> - Trace route to an IP address
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
