/**
 * WindowsPC - Windows workstation with terminal emulation
 *
 * Extends PC with Windows terminal capabilities:
 * - Command execution (cmd/PowerShell-like)
 * - Windows-specific networking commands
 * - File system simulation
 * - Full netsh command support
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
 * Firewall rule configuration
 */
interface FirewallRule {
  name: string;
  dir: 'in' | 'out';
  action: 'allow' | 'block';
  protocol?: string;
  localport?: string;
  program?: string;
  enabled: boolean;
}

/**
 * WindowsPC - Windows workstation device
 */
export class WindowsPC extends PC {
  private commandHistory: string[];
  private dnsServers: Map<string, string[]>;
  private firewallEnabled: boolean;
  private firewallRules: FirewallRule[];
  private proxyServer: string | null;
  private proxyBypass: string | null;
  private wifiProfiles: string[];
  private dhcpEnabled: Map<string, boolean>;

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
    this.dnsServers = new Map();
    this.dnsServers.set('eth0', []);
    this.firewallEnabled = true;
    this.firewallRules = this.getDefaultFirewallRules();
    this.proxyServer = null;
    this.proxyBypass = null;
    this.wifiProfiles = ['HomeNetwork', 'OfficeWiFi'];
    this.dhcpEnabled = new Map();
    this.dhcpEnabled.set('eth0', false);

    // Power on if requested
    if (config.isPoweredOn !== false) {
      this.powerOn();
    }
  }

  /**
   * Returns default firewall rules
   */
  private getDefaultFirewallRules(): FirewallRule[] {
    return [
      { name: 'Remote Desktop', dir: 'in', action: 'allow', protocol: 'TCP', localport: '3389', enabled: true },
      { name: 'File and Printer Sharing', dir: 'in', action: 'allow', protocol: 'TCP', localport: '445', enabled: true },
      { name: 'Windows Remote Management', dir: 'in', action: 'allow', protocol: 'TCP', localport: '5985', enabled: true },
      { name: 'ICMP Echo Request', dir: 'in', action: 'allow', protocol: 'ICMPv4', enabled: true },
      { name: 'Core Networking - DNS', dir: 'out', action: 'allow', protocol: 'UDP', localport: '53', enabled: true },
    ];
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
   * Executes netsh command - comprehensive Windows network configuration utility
   */
  private executeNetshCommand(command: string): string {
    const cmd = command.trim();
    const cmdLower = cmd.toLowerCase();
    const args = cmd.split(/\s+/);

    // netsh help
    if (cmdLower === 'netsh /?' || cmdLower === 'netsh help' || cmdLower === 'netsh -?') {
      return this.getNetshHelp();
    }

    // Route to appropriate handler
    if (cmdLower.startsWith('netsh interface ipv4 ')) {
      return this.executeNetshInterfaceIp(cmd.replace(/interface\s+ipv4/i, 'interface ip'));
    }

    if (cmdLower.startsWith('netsh interface ip ')) {
      return this.executeNetshInterfaceIp(cmd);
    }

    if (cmdLower.startsWith('netsh interface ')) {
      return this.executeNetshInterface(cmd);
    }

    if (cmdLower.startsWith('netsh wlan ')) {
      return this.executeNetshWlan(cmd);
    }

    if (cmdLower.startsWith('netsh advfirewall ')) {
      return this.executeNetshAdvfirewall(cmd);
    }

    if (cmdLower.startsWith('netsh winhttp ')) {
      return this.executeNetshWinhttp(cmd);
    }

    if (cmdLower === 'netsh dump') {
      return this.executeNetshDump();
    }

    return `The following command was not found: ${args.slice(1).join(' ')}`;
  }

  /**
   * Returns netsh help
   */
  private getNetshHelp(): string {
    return `
Usage: netsh [Context] [Command]

The following commands are available:

Commands in this context:
?              - Displays a list of commands.
dump           - Displays a configuration script.
help           - Displays a list of commands.

The following sub-contexts are available:
 advfirewall   - Changes to the 'netsh advfirewall' context.
 interface     - Changes to the 'netsh interface' context.
 wlan          - Changes to the 'netsh wlan' context.
 winhttp       - Changes to the 'netsh winhttp' context.

To view help for a command, type the command, followed by a space, and then
 type ?.
`;
  }

  /**
   * Executes netsh interface commands
   */
  private executeNetshInterface(command: string): string {
    const cmdLower = command.toLowerCase();

    // netsh interface show interface
    if (cmdLower.includes('show interface')) {
      return this.netshShowInterface();
    }

    // netsh interface set interface
    if (cmdLower.includes('set interface')) {
      return this.netshSetInterface(command);
    }

    return `The following command was not found: ${command.replace(/^netsh\s+/i, '')}`;
  }

  /**
   * Shows all network interfaces
   */
  private netshShowInterface(): string {
    const interfaces = this.getInterfaces();

    let output = '\nAdmin State    State          Type             Interface Name\n';
    output += '-------------------------------------------------------------------------\n';

    const sortedInterfaces = interfaces.sort((a, b) => a.getName().localeCompare(b.getName()));
    let adapterNum = 0;
    for (const iface of sortedInterfaces) {
      const isUp = iface.isUp();
      const adminState = isUp ? 'Enabled' : 'Disabled';
      const state = isUp ? 'Connected' : 'Disconnected';
      output += `${adminState.padEnd(15)}${state.padEnd(15)}${'Dedicated'.padEnd(17)}Ethernet${adapterNum}\n`;
      adapterNum++;
    }

    return output;
  }

  /**
   * Sets interface state
   */
  private netshSetInterface(command: string): string {
    const cmdLower = command.toLowerCase();

    // Extract interface name
    const nameMatch = command.match(/"([^"]+)"/i);
    if (!nameMatch) {
      return 'The interface was not found.';
    }

    const interfaceName = nameMatch[1];
    const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' : interfaceName;
    const iface = this.getInterface(ifaceName);

    if (!iface) {
      return `The interface "${interfaceName}" was not found.`;
    }

    // Check for enable/disable
    if (cmdLower.includes('enable') || cmdLower.includes('admin=enabled')) {
      iface.up();
      return 'Ok.\n';
    }

    if (cmdLower.includes('disable') || cmdLower.includes('admin=disabled')) {
      iface.down();
      return 'Ok.\n';
    }

    return 'Invalid command. Use enable or disable.';
  }

  /**
   * Executes netsh interface ip commands
   */
  private executeNetshInterfaceIp(command: string): string {
    const cmdLower = command.toLowerCase();

    // netsh interface ip show config
    if (cmdLower.includes('show config')) {
      return this.netshShowConfig(command);
    }

    // netsh interface ip show addresses
    if (cmdLower.includes('show addresses')) {
      return this.netshShowAddresses();
    }

    // netsh interface ip show dns
    if (cmdLower.includes('show dns')) {
      return this.netshShowDns();
    }

    // netsh interface ip show route
    if (cmdLower.includes('show route')) {
      return this.netshShowRoute();
    }

    // netsh interface ip set address
    if (cmdLower.includes('set address')) {
      return this.netshSetAddress(command);
    }

    // netsh interface ip set dns
    if (cmdLower.includes('set dns')) {
      return this.netshSetDns(command);
    }

    // netsh interface ip set dnsservers
    if (cmdLower.includes('set dnsservers')) {
      return this.netshSetDns(command);
    }

    // netsh interface ip add dns
    if (cmdLower.includes('add dns')) {
      return this.netshAddDns(command);
    }

    // netsh interface ip delete dns
    if (cmdLower.includes('delete dns')) {
      return this.netshDeleteDns(command);
    }

    // netsh interface ip add address
    if (cmdLower.includes('add address')) {
      return this.netshAddAddress(command);
    }

    // netsh interface ip delete address
    if (cmdLower.includes('delete address')) {
      return this.netshDeleteAddress(command);
    }

    return `Usage: netsh interface ip [command]\n\nCommands: show config, show addresses, show dns, show route,\n         set address, set dns, add dns, delete dns`;
  }

  /**
   * Shows IP configuration
   */
  private netshShowConfig(command: string): string {
    const cmdLower = command.toLowerCase();

    // Check for specific interface
    const nameMatch = command.match(/name="([^"]+)"/i);
    if (nameMatch) {
      const interfaceName = nameMatch[1];
      const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' : interfaceName;
      const iface = this.getInterface(ifaceName);

      if (!iface) {
        return `The interface "${interfaceName}" was not found.`;
      }

      return this.formatInterfaceConfig(interfaceName, iface);
    }

    // Show all interfaces
    const iface = this.getInterface('eth0');
    if (!iface) {
      return 'No interfaces configured.';
    }

    return this.formatInterfaceConfig('Ethernet0', iface);
  }

  /**
   * Formats interface configuration output
   */
  private formatInterfaceConfig(name: string, iface: any): string {
    const ip = iface.getIPAddress();
    const mask = iface.getSubnetMask();
    const gateway = this.getGateway();
    const dns = this.dnsServers.get('eth0') || [];
    const dhcp = this.dhcpEnabled.get('eth0') || false;

    let output = `\nConfiguration for interface "${name}"\n`;
    output += `    DHCP enabled:                         ${dhcp ? 'Yes' : 'No'}\n`;

    if (ip) {
      output += `    IP Address:                           ${ip.toString()}\n`;
      output += `    Subnet Prefix:                        ${mask ? mask.toString() : '255.255.255.0'} (mask /${mask ? mask.getCIDR() : '24'})\n`;
    }

    if (gateway) {
      output += `    Default Gateway:                      ${gateway.toString()}\n`;
    }

    output += `    Gateway Metric:                       0\n`;
    output += `    InterfaceMetric:                      25\n`;

    if (dns.length > 0) {
      output += `    Statically Configured DNS Servers:    ${dns[0]}\n`;
      for (let i = 1; i < dns.length; i++) {
        output += `                                          ${dns[i]}\n`;
      }
    } else {
      output += `    Statically Configured DNS Servers:    None\n`;
    }

    return output;
  }

  /**
   * Shows IP addresses
   */
  private netshShowAddresses(): string {
    const interfaces = this.getInterfaces();
    if (interfaces.length === 0) {
      return 'No interfaces configured.';
    }

    let output = '';
    const sortedInterfaces = interfaces.sort((a, b) => a.getName().localeCompare(b.getName()));
    let adapterNum = 0;

    for (const iface of sortedInterfaces) {
      const ip = iface.getIPAddress();
      const mask = iface.getSubnetMask();

      output += `\nConfiguration for interface "Ethernet${adapterNum}"\n`;
      if (ip) {
        output += `    IP Address:                           ${ip.toString()}\n`;
        output += `    Subnet Prefix:                        ${mask ? `/${mask.getCIDR()}` : '/24'}\n`;
      } else {
        output += '    No IP addresses configured.\n';
      }
      adapterNum++;
    }

    return output;
  }

  /**
   * Shows DNS configuration
   */
  private netshShowDns(): string {
    const dns = this.dnsServers.get('eth0') || [];

    let output = '\nConfiguration for interface "Ethernet0"\n';
    output += '    DNS servers configured through DHCP:  None\n';

    if (dns.length > 0) {
      output += `    Statically Configured DNS Servers:    ${dns[0]}\n`;
      for (let i = 1; i < dns.length; i++) {
        output += `                                          ${dns[i]}\n`;
      }
    } else {
      output += '    Statically Configured DNS Servers:    None\n';
    }

    return output;
  }

  /**
   * Shows routing table
   */
  private netshShowRoute(): string {
    const iface = this.getInterface('eth0');
    const ip = iface?.getIPAddress();
    const mask = iface?.getSubnetMask();
    const gateway = this.getGateway();

    let output = '\nPublish  Type      Met  Prefix                    Idx  Gateway/Interface Name\n';
    output += '-------  --------  ---  ------------------------  ---  ------------------------\n';

    if (ip && mask) {
      const network = this.getNetwork(ip, mask);
      output += `No       Manual    256  ${network}${`/${mask.getCIDR()}`.padEnd(10)}        1    Ethernet0\n`;
    }

    if (gateway) {
      output += `No       Manual    1    0.0.0.0/0                 1    ${gateway.toString()}\n`;
    }

    return output;
  }

  /**
   * Sets IP address via netsh
   */
  private netshSetAddress(command: string): string {
    const cmdLower = command.toLowerCase();

    // Extract interface name
    const nameMatch = command.match(/"([^"]+)"/i);
    const altNameMatch = command.match(/name="?([^"\s]+)"?/i);
    const interfaceName = nameMatch?.[1] || altNameMatch?.[1];

    if (!interfaceName) {
      return 'Usage: netsh interface ip set address "Interface" static IP MASK [GATEWAY]\n       netsh interface ip set address "Interface" dhcp';
    }

    const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' : interfaceName;
    const iface = this.getInterface(ifaceName);

    if (!iface) {
      return `The interface "${interfaceName}" was not found.`;
    }

    // DHCP mode
    if (cmdLower.includes('dhcp') || cmdLower.includes('source=dhcp')) {
      this.dhcpEnabled.set(ifaceName, true);
      return 'Ok.\n';
    }

    // Static mode - try different patterns
    // Pattern 1: netsh interface ip set address "Ethernet0" static IP MASK [GATEWAY]
    const staticMatch = command.match(/static\s+(\S+)\s+(\S+)(?:\s+(\S+))?/i);

    // Pattern 2: netsh interface ip set address name="Ethernet0" source=static addr=IP mask=MASK
    const altMatch = command.match(/addr=([^\s=]+)\s+mask=([^\s=]+)/i);

    let ipStr: string | undefined;
    let maskStr: string | undefined;
    let gatewayStr: string | undefined;

    if (altMatch) {
      // Use alternative syntax first (more specific)
      ipStr = altMatch[1];
      maskStr = altMatch[2];
      const gwMatch = command.match(/gateway=([^\s=]+)/i);
      gatewayStr = gwMatch?.[1];
    } else if (staticMatch) {
      ipStr = staticMatch[1];
      maskStr = staticMatch[2];
      gatewayStr = staticMatch[3];
    }

    if (!ipStr || !maskStr) {
      return 'Usage: netsh interface ip set address "Interface" static IP MASK [GATEWAY]';
    }

    // Validate IP
    let ip: IPAddress;
    try {
      ip = new IPAddress(ipStr);
    } catch (e) {
      return `The IP address "${ipStr}" is not valid. Error: Invalid IP address format.`;
    }

    // Validate mask
    let mask: SubnetMask;
    try {
      mask = new SubnetMask(maskStr);
    } catch (e) {
      return `The subnet mask "${maskStr}" is not valid. Error: Invalid subnet mask format.`;
    }

    // Configure interface
    this.setIPAddress(ifaceName, ip, mask);
    this.dhcpEnabled.set(ifaceName, false);
    iface.up();

    // Configure gateway if provided
    if (gatewayStr) {
      try {
        const gateway = new IPAddress(gatewayStr);
        this.setGateway(gateway);
      } catch (e) {
        return `The gateway "${gatewayStr}" is not valid.`;
      }
    }

    return 'Ok.\n';
  }

  /**
   * Sets DNS server
   */
  private netshSetDns(command: string): string {
    const cmdLower = command.toLowerCase();

    // Extract interface name
    const nameMatch = command.match(/"([^"]+)"/i);
    const interfaceName = nameMatch?.[1] || 'Ethernet0';
    const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' : interfaceName;

    const iface = this.getInterface(ifaceName);
    if (!iface) {
      return `The interface "${interfaceName}" was not found.`;
    }

    // DHCP mode
    if (cmdLower.includes('dhcp') || cmdLower.includes('source=dhcp')) {
      this.dnsServers.set(ifaceName, []);
      return 'Ok.\n';
    }

    // Static DNS
    const dnsMatch = command.match(/static\s+(\S+)/i);
    if (!dnsMatch) {
      return 'Usage: netsh interface ip set dns "Interface" static DNS_IP';
    }

    const dnsStr = dnsMatch[1];

    // Validate DNS IP
    try {
      new IPAddress(dnsStr);
    } catch (e) {
      return `The DNS server address "${dnsStr}" is not valid.`;
    }

    this.dnsServers.set(ifaceName, [dnsStr]);
    return 'Ok.\n';
  }

  /**
   * Adds DNS server
   */
  private netshAddDns(command: string): string {
    // Extract interface name
    const nameMatch = command.match(/"([^"]+)"/i);
    const interfaceName = nameMatch?.[1] || 'Ethernet0';
    const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' : interfaceName;

    const iface = this.getInterface(ifaceName);
    if (!iface) {
      return `The interface "${interfaceName}" was not found.`;
    }

    // Extract DNS IP
    const parts = command.split(/\s+/);
    const dnsIp = parts.find(p => {
      try {
        new IPAddress(p);
        return true;
      } catch {
        return false;
      }
    });

    if (!dnsIp) {
      return 'Usage: netsh interface ip add dns "Interface" DNS_IP';
    }

    const existing = this.dnsServers.get(ifaceName) || [];
    existing.push(dnsIp);
    this.dnsServers.set(ifaceName, existing);

    return 'Ok.\n';
  }

  /**
   * Deletes DNS server
   */
  private netshDeleteDns(command: string): string {
    const cmdLower = command.toLowerCase();

    // Extract interface name
    const nameMatch = command.match(/"([^"]+)"/i);
    const interfaceName = nameMatch?.[1] || 'Ethernet0';
    const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' : interfaceName;

    const iface = this.getInterface(ifaceName);
    if (!iface) {
      return `The interface "${interfaceName}" was not found.`;
    }

    // Delete all
    if (cmdLower.includes('all')) {
      this.dnsServers.set(ifaceName, []);
      return 'Ok.\n';
    }

    // Delete specific
    const parts = command.split(/\s+/);
    const dnsIp = parts.find(p => {
      try {
        new IPAddress(p);
        return true;
      } catch {
        return false;
      }
    });

    if (dnsIp) {
      const existing = this.dnsServers.get(ifaceName) || [];
      const filtered = existing.filter(d => d !== dnsIp);
      this.dnsServers.set(ifaceName, filtered);
    }

    return 'Ok.\n';
  }

  /**
   * Adds secondary IP address
   */
  private netshAddAddress(command: string): string {
    // Extract interface name
    const nameMatch = command.match(/"([^"]+)"/i);
    const interfaceName = nameMatch?.[1] || 'Ethernet0';
    const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' : interfaceName;

    const iface = this.getInterface(ifaceName);
    if (!iface) {
      return `The interface "${interfaceName}" was not found.`;
    }

    // For now, just acknowledge (multi-IP support would require more infrastructure)
    return 'Ok.\n';
  }

  /**
   * Deletes IP address
   */
  private netshDeleteAddress(command: string): string {
    // Extract interface name
    const nameMatch = command.match(/"([^"]+)"/i);
    const interfaceName = nameMatch?.[1] || 'Ethernet0';
    const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' : interfaceName;

    const iface = this.getInterface(ifaceName);
    if (!iface) {
      return `The interface "${interfaceName}" was not found.`;
    }

    // Acknowledge the delete
    return 'Ok.\n';
  }

  /**
   * Executes netsh wlan commands
   */
  private executeNetshWlan(command: string): string {
    const cmdLower = command.toLowerCase();

    if (cmdLower.includes('show profiles')) {
      return this.netshWlanShowProfiles();
    }

    if (cmdLower.includes('show profile name=') || cmdLower.includes('show profile "')) {
      return this.netshWlanShowProfile(command);
    }

    if (cmdLower.includes('show interfaces')) {
      return this.netshWlanShowInterfaces();
    }

    if (cmdLower.includes('show networks')) {
      return this.netshWlanShowNetworks(command);
    }

    if (cmdLower.includes('connect')) {
      return this.netshWlanConnect(command);
    }

    if (cmdLower.includes('disconnect')) {
      return 'Disconnection request was completed successfully for interface "Wi-Fi".\n';
    }

    if (cmdLower.includes('show drivers')) {
      return this.netshWlanShowDrivers();
    }

    return 'Usage: netsh wlan [show profiles|show interfaces|show networks|connect|disconnect]';
  }

  /**
   * Shows WLAN profiles
   */
  private netshWlanShowProfiles(): string {
    let output = '\nProfiles on interface Wi-Fi:\n\n';
    output += 'Group policy profiles (read only)\n';
    output += '---------------------------------\n';
    output += '    <None>\n\n';
    output += 'User profiles\n';
    output += '-------------\n';

    for (const profile of this.wifiProfiles) {
      output += `    All User Profile     : ${profile}\n`;
    }

    return output;
  }

  /**
   * Shows specific WLAN profile
   */
  private netshWlanShowProfile(command: string): string {
    const nameMatch = command.match(/name="?([^"\s]+)"?/i);
    const profileName = nameMatch?.[1] || 'Unknown';

    let output = `\nProfile ${profileName} on interface Wi-Fi:\n`;
    output += '=======================================================================\n\n';
    output += 'Applied: All User Profile\n\n';
    output += 'Profile information\n';
    output += '-------------------\n';
    output += `    Version                : 1\n`;
    output += `    Type                   : Wireless LAN\n`;
    output += `    Name                   : ${profileName}\n`;
    output += '    Control options        :\n';
    output += '        Connection mode    : Connect automatically\n';
    output += '        Network broadcast  : Connect even if not broadcasting\n\n';
    output += 'Connectivity settings\n';
    output += '---------------------\n';
    output += '    Number of SSIDs        : 1\n';
    output += `    SSID name              : "${profileName}"\n`;
    output += '    Network type           : Infrastructure\n';
    output += '    Radio type             : [ Any Radio Type ]\n\n';
    output += 'Security settings\n';
    output += '-----------------\n';
    output += '    Authentication         : WPA2-Personal\n';
    output += '    Cipher                 : CCMP\n';
    output += '    Security key           : Present\n';

    if (command.toLowerCase().includes('key=clear')) {
      output += '    Key Content            : MyWiFiPassword123\n';
    }

    return output;
  }

  /**
   * Shows WLAN interfaces
   */
  private netshWlanShowInterfaces(): string {
    let output = '\nThere is 1 interface on the system:\n\n';
    output += '    Name                   : Wi-Fi\n';
    output += '    Description            : Intel(R) Dual Band Wireless-AC 8265\n';
    output += '    GUID                   : 12345678-1234-1234-1234-123456789abc\n';
    output += '    Physical address       : 00:11:22:33:44:55\n';
    output += '    State                  : connected\n';
    output += `    SSID                   : ${this.wifiProfiles[0] || 'Not Connected'}\n`;
    output += '    BSSID                  : aa:bb:cc:dd:ee:ff\n';
    output += '    Network type           : Infrastructure\n';
    output += '    Radio type             : 802.11ac\n';
    output += '    Authentication         : WPA2-Personal\n';
    output += '    Cipher                 : CCMP\n';
    output += '    Connection mode        : Profile\n';
    output += '    Channel                : 36\n';
    output += '    Receive rate (Mbps)    : 866.7\n';
    output += '    Transmit rate (Mbps)   : 866.7\n';
    output += '    Signal                 : 95%\n';
    output += '    Profile                : ' + (this.wifiProfiles[0] || 'None') + '\n';

    return output;
  }

  /**
   * Shows available networks
   */
  private netshWlanShowNetworks(command: string): string {
    const showBssid = command.toLowerCase().includes('mode=bssid');

    let output = '\nInterface name : Wi-Fi\n';
    output += 'There are 3 networks currently visible.\n\n';

    const networks = [
      { ssid: 'HomeNetwork', type: 'Infrastructure', auth: 'WPA2-Personal', bssid: 'aa:bb:cc:dd:ee:ff', signal: 95, channel: 36 },
      { ssid: 'OfficeWiFi', type: 'Infrastructure', auth: 'WPA2-Enterprise', bssid: '11:22:33:44:55:66', signal: 78, channel: 6 },
      { ssid: 'GuestNetwork', type: 'Infrastructure', auth: 'Open', bssid: 'ff:ee:dd:cc:bb:aa', signal: 45, channel: 11 },
    ];

    for (const net of networks) {
      output += `SSID ${networks.indexOf(net) + 1} : ${net.ssid}\n`;
      output += `    Network type            : ${net.type}\n`;
      output += `    Authentication          : ${net.auth}\n`;
      output += `    Encryption              : ${net.auth === 'Open' ? 'None' : 'CCMP'}\n`;

      if (showBssid) {
        output += `    BSSID 1                 : ${net.bssid}\n`;
        output += `         Signal             : ${net.signal}%\n`;
        output += `         Radio type         : 802.11ac\n`;
        output += `         Channel            : ${net.channel}\n`;
      }

      output += '\n';
    }

    return output;
  }

  /**
   * Connects to WLAN
   */
  private netshWlanConnect(command: string): string {
    const nameMatch = command.match(/name="?([^"\s]+)"?/i);
    const profileName = nameMatch?.[1] || 'Unknown';

    return `Connection request was completed successfully.\nConnected to ${profileName}.\n`;
  }

  /**
   * Shows WLAN drivers
   */
  private netshWlanShowDrivers(): string {
    let output = '\nInterface name: Wi-Fi\n\n';
    output += '    Driver                    : Intel(R) Dual Band Wireless-AC 8265\n';
    output += '    Vendor                    : Intel Corporation\n';
    output += '    Provider                  : Intel\n';
    output += '    Date                      : 12/15/2023\n';
    output += '    Version                   : 22.200.0.5\n';
    output += '    INF file                  : oem45.inf\n';
    output += '    Type                      : Native Wi-Fi Driver\n';
    output += '    Radio types supported     : 802.11b 802.11g 802.11n 802.11a 802.11ac\n';
    output += '    FIPS 140-2 mode supported : Yes\n';
    output += '    802.11w Management Frame Protection supported : Yes\n';
    output += '    Hosted network supported  : Yes\n';
    output += '    Authentication and cipher supported in infrastructure mode:\n';
    output += '                                Open            None\n';
    output += '                                WPA2-Personal   CCMP\n';
    output += '                                WPA2-Enterprise CCMP\n';
    output += '                                WPA3-Personal   CCMP\n';

    return output;
  }

  /**
   * Executes netsh advfirewall commands
   */
  private executeNetshAdvfirewall(command: string): string {
    const cmdLower = command.toLowerCase();

    if (cmdLower.includes('show currentprofile')) {
      return this.netshFirewallShowProfile('current');
    }

    if (cmdLower.includes('show allprofiles')) {
      return this.netshFirewallShowAllProfiles();
    }

    if (cmdLower.includes('set currentprofile')) {
      return this.netshFirewallSetProfile(command, 'current');
    }

    if (cmdLower.includes('set allprofiles')) {
      return this.netshFirewallSetProfile(command, 'all');
    }

    if (cmdLower.includes('firewall show rule')) {
      return this.netshFirewallShowRule(command);
    }

    if (cmdLower.includes('firewall add rule')) {
      return this.netshFirewallAddRule(command);
    }

    if (cmdLower.includes('firewall delete rule')) {
      return this.netshFirewallDeleteRule(command);
    }

    if (cmdLower.includes('firewall set rule')) {
      return this.netshFirewallSetRule(command);
    }

    if (cmdLower.includes('reset')) {
      this.firewallRules = this.getDefaultFirewallRules();
      this.firewallEnabled = true;
      return 'Ok.\n';
    }

    return 'Usage: netsh advfirewall [show currentprofile|show allprofiles|set|firewall|reset]';
  }

  /**
   * Shows firewall profile
   */
  private netshFirewallShowProfile(profile: string): string {
    let output = `\n${profile === 'current' ? 'Domain' : profile} Profile Settings:\n`;
    output += '----------------------------------------------------------------------\n';
    output += `State                                 ${this.firewallEnabled ? 'ON' : 'OFF'}\n`;
    output += 'Firewall Policy                       BlockInbound,AllowOutbound\n';
    output += 'LocalFirewallRules                    N/A (GPO-store only)\n';
    output += 'LocalConSecRules                      N/A (GPO-store only)\n';
    output += 'InboundUserNotification               Disable\n';
    output += 'RemoteManagement                      Disable\n';
    output += 'UnicastResponseToMulticast            Enable\n\n';
    output += 'Logging:\n';
    output += 'LogAllowedConnections                 Disable\n';
    output += 'LogDroppedConnections                 Disable\n';
    output += 'FileName                              %systemroot%\\system32\\LogFiles\\Firewall\\pfirewall.log\n';
    output += 'MaxFileSize                           4096\n\n';

    return output;
  }

  /**
   * Shows all firewall profiles
   */
  private netshFirewallShowAllProfiles(): string {
    let output = '';

    for (const profile of ['Domain', 'Private', 'Public']) {
      output += `\n${profile} Profile Settings:\n`;
      output += '----------------------------------------------------------------------\n';
      output += `State                                 ${this.firewallEnabled ? 'ON' : 'OFF'}\n`;
      output += 'Firewall Policy                       BlockInbound,AllowOutbound\n';
      output += 'LocalFirewallRules                    N/A (GPO-store only)\n';
      output += 'LocalConSecRules                      N/A (GPO-store only)\n';
      output += 'InboundUserNotification               Disable\n';
      output += 'RemoteManagement                      Disable\n';
      output += 'UnicastResponseToMulticast            Enable\n\n';
    }

    return output;
  }

  /**
   * Sets firewall profile state
   */
  private netshFirewallSetProfile(command: string, profile: string): string {
    const cmdLower = command.toLowerCase();

    if (cmdLower.includes('state on')) {
      this.firewallEnabled = true;
      return 'Ok.\n';
    }

    if (cmdLower.includes('state off')) {
      this.firewallEnabled = false;
      return 'Ok.\n';
    }

    return 'Usage: netsh advfirewall set currentprofile state [on|off]';
  }

  /**
   * Shows firewall rules
   */
  private netshFirewallShowRule(command: string): string {
    const cmdLower = command.toLowerCase();
    const nameMatch = command.match(/name="?([^"\s]+)"?/i);
    const showAll = cmdLower.includes('name=all');
    const dirIn = cmdLower.includes('dir=in');
    const dirOut = cmdLower.includes('dir=out');

    let rules = this.firewallRules;

    if (!showAll && nameMatch) {
      const ruleName = nameMatch[1];
      rules = rules.filter(r => r.name.toLowerCase().includes(ruleName.toLowerCase()));
    }

    if (dirIn) {
      rules = rules.filter(r => r.dir === 'in');
    } else if (dirOut) {
      rules = rules.filter(r => r.dir === 'out');
    }

    if (rules.length === 0) {
      return 'No rules match the specified criteria.\n';
    }

    let output = '';
    for (const rule of rules) {
      output += `\nRule Name:                            ${rule.name}\n`;
      output += '----------------------------------------------------------------------\n';
      output += `Enabled:                              ${rule.enabled ? 'Yes' : 'No'}\n`;
      output += `Direction:                            ${rule.dir === 'in' ? 'In' : 'Out'}\n`;
      output += 'Profiles:                             Domain,Private,Public\n';
      output += 'Grouping:                             \n';
      output += 'LocalIP:                              Any\n';
      output += 'RemoteIP:                             Any\n';
      output += `Protocol:                             ${rule.protocol || 'Any'}\n`;

      if (rule.localport) {
        output += `LocalPort:                            ${rule.localport}\n`;
      }

      output += `Action:                               ${rule.action === 'allow' ? 'Allow' : 'Block'}\n`;

      if (rule.program) {
        output += `Program:                              ${rule.program}\n`;
      }

      output += '\n';
    }

    return output;
  }

  /**
   * Adds firewall rule
   */
  private netshFirewallAddRule(command: string): string {
    const nameMatch = command.match(/name="([^"]+)"/i);
    const dirMatch = command.match(/dir=(\w+)/i);
    const actionMatch = command.match(/action=(\w+)/i);
    const protocolMatch = command.match(/protocol=(\w+)/i);
    const portMatch = command.match(/localport=(\w+)/i);
    const programMatch = command.match(/program="([^"]+)"/i);

    if (!nameMatch || !dirMatch || !actionMatch) {
      return 'Usage: netsh advfirewall firewall add rule name="NAME" dir=in|out action=allow|block [protocol=TCP|UDP] [localport=PORT]';
    }

    const rule: FirewallRule = {
      name: nameMatch[1],
      dir: dirMatch[1].toLowerCase() as 'in' | 'out',
      action: actionMatch[1].toLowerCase() as 'allow' | 'block',
      protocol: protocolMatch?.[1],
      localport: portMatch?.[1],
      program: programMatch?.[1],
      enabled: true,
    };

    this.firewallRules.push(rule);
    return 'Ok.\n';
  }

  /**
   * Deletes firewall rule
   */
  private netshFirewallDeleteRule(command: string): string {
    const nameMatch = command.match(/name="([^"]+)"/i);

    if (!nameMatch) {
      return 'Usage: netsh advfirewall firewall delete rule name="RULE_NAME"';
    }

    const ruleName = nameMatch[1];
    const initialLength = this.firewallRules.length;
    this.firewallRules = this.firewallRules.filter(r => r.name !== ruleName);

    if (this.firewallRules.length === initialLength) {
      return `Rule not found. No rules match the specified criteria.\n`;
    }

    return 'Deleted 1 rule(s).\nOk.\n';
  }

  /**
   * Sets/modifies firewall rule
   */
  private netshFirewallSetRule(command: string): string {
    const nameMatch = command.match(/name="([^"]+)"/i);

    if (!nameMatch) {
      return 'Usage: netsh advfirewall firewall set rule name="RULE_NAME" new [enable=yes|no]';
    }

    const ruleName = nameMatch[1];
    const rule = this.firewallRules.find(r => r.name === ruleName);

    if (!rule) {
      return `Rule not found. No rules match the specified criteria.\n`;
    }

    if (command.toLowerCase().includes('enable=yes')) {
      rule.enabled = true;
    } else if (command.toLowerCase().includes('enable=no')) {
      rule.enabled = false;
    }

    return 'Updated 1 rule(s).\nOk.\n';
  }

  /**
   * Executes netsh winhttp commands
   */
  private executeNetshWinhttp(command: string): string {
    const cmdLower = command.toLowerCase();

    if (cmdLower.includes('show proxy')) {
      return this.netshWinhttpShowProxy();
    }

    if (cmdLower.includes('set proxy')) {
      return this.netshWinhttpSetProxy(command);
    }

    if (cmdLower.includes('reset proxy')) {
      this.proxyServer = null;
      this.proxyBypass = null;
      return 'Current WinHTTP proxy settings:\n\n    Direct access (no proxy server).\n\nOk.\n';
    }

    return 'Usage: netsh winhttp [show proxy|set proxy|reset proxy]';
  }

  /**
   * Shows proxy settings
   */
  private netshWinhttpShowProxy(): string {
    let output = '\nCurrent WinHTTP proxy settings:\n\n';

    if (this.proxyServer) {
      output += `    Proxy Server(s) :  ${this.proxyServer}\n`;
      if (this.proxyBypass) {
        output += `    Bypass List     :  ${this.proxyBypass}\n`;
      }
    } else {
      output += '    Direct access (no proxy server).\n';
    }

    return output;
  }

  /**
   * Sets proxy settings
   */
  private netshWinhttpSetProxy(command: string): string {
    const proxyMatch = command.match(/proxy-server="?([^"\s]+)"?/i);
    const bypassMatch = command.match(/bypass-list="?([^"\s]+)"?/i);

    if (proxyMatch) {
      this.proxyServer = proxyMatch[1];
    }

    if (bypassMatch) {
      this.proxyBypass = bypassMatch[1];
    }

    return 'Current WinHTTP proxy settings:\n\n' +
           `    Proxy Server(s) :  ${this.proxyServer || 'None'}\n` +
           (this.proxyBypass ? `    Bypass List     :  ${this.proxyBypass}\n` : '') +
           '\nOk.\n';
  }

  /**
   * Dumps configuration script
   */
  private executeNetshDump(): string {
    const iface = this.getInterface('eth0');
    const ip = iface?.getIPAddress();
    const mask = iface?.getSubnetMask();
    const gateway = this.getGateway();
    const dns = this.dnsServers.get('eth0') || [];

    let output = '#========================\n';
    output += '# netsh Configuration Script\n';
    output += '# Interface IP Configuration\n';
    output += '#========================\n';
    output += 'pushd interface ip\n\n';

    if (ip && mask) {
      output += `# netsh interface ip set address\n`;
      output += `set address name="Ethernet0" source=static addr=${ip.toString()} mask=${mask.toString()}`;
      if (gateway) {
        output += ` gateway=${gateway.toString()} gwmetric=0`;
      }
      output += '\n';
    }

    if (dns.length > 0) {
      output += `# netsh interface ip set dns\n`;
      output += `set dns name="Ethernet0" source=static addr=${dns[0]} register=PRIMARY\n`;
      for (let i = 1; i < dns.length; i++) {
        output += `add dns name="Ethernet0" addr=${dns[i]} index=${i + 1}\n`;
      }
    }

    output += '\npopd\n';
    output += '#========================\n';

    return output;
  }

  /**
   * Returns ipconfig output
   */
  private getIpconfigOutput(all: boolean): string {
    const interfaces = this.getInterfaces();

    if (interfaces.length === 0) {
      return 'No network adapters configured';
    }

    const gateway = this.getGateway();
    let output = 'Windows IP Configuration\n\n';

    // Sort interfaces by name
    const sortedInterfaces = interfaces.sort((a, b) => a.getName().localeCompare(b.getName()));

    let adapterNum = 0;
    for (const iface of sortedInterfaces) {
      const ip = iface.getIPAddress();
      const mask = iface.getSubnetMask();
      const mac = iface.getMAC();
      const ifaceName = iface.getName();

      output += `Ethernet adapter Ethernet${adapterNum}:\n\n`;

      output += `   Connection-specific DNS Suffix  . : \n`;

      if (all) {
        output += `   Description . . . . . . . . . . . : Intel(R) 82574L Gigabit Network Connection #${adapterNum + 1}\n`;
        output += `   Physical Address. . . . . . . . . : ${mac.toString()}\n`;
        const isDhcp = this.dhcpEnabled.get(ifaceName) ?? false;
        output += `   DHCP Enabled. . . . . . . . . . . : ${isDhcp ? 'Yes' : 'No'}\n`;
        output += `   Autoconfiguration Enabled . . . . : Yes\n`;
      }

      if (ip) {
        output += `   IPv4 Address. . . . . . . . . . . : ${ip.toString()}\n`;
        output += `   Subnet Mask . . . . . . . . . . . : ${mask ? mask.toString() : '255.255.255.0'}\n`;
      } else {
        output += `   Media State . . . . . . . . . . . : Media disconnected\n`;
      }

      // Only show gateway on first interface with an IP
      if (gateway && adapterNum === 0 && ip) {
        output += `   Default Gateway . . . . . . . . . : ${gateway.toString()}\n`;
      }

      // Show DNS servers if all flag is set
      if (all) {
        const dns = this.dnsServers.get(ifaceName) || [];
        if (dns.length > 0) {
          output += `   DNS Servers . . . . . . . . . . . : ${dns[0]}\n`;
          for (let i = 1; i < dns.length; i++) {
            output += `                                       ${dns[i]}\n`;
          }
        }
      }

      output += '\n';
      adapterNum++;
    }

    return output;
  }

  /**
   * Returns route output
   */
  private getRouteOutput(): string {
    const interfaces = this.getInterfaces();

    if (interfaces.length === 0) {
      return 'No network interfaces configured';
    }

    const gateway = this.getGateway();

    let output = '===========================================================================\n';
    output += 'Interface List\n';
    output += '  1...........................Software Loopback Interface 1\n';

    // List all interfaces
    const sortedInterfaces = interfaces.sort((a, b) => a.getName().localeCompare(b.getName()));
    let ifaceIdx = 2;
    for (const iface of sortedInterfaces) {
      output += `  ${ifaceIdx}...${iface.getMAC().toString().replace(/:/g, ' ')} ......Intel(R) 82574L Gigabit Network Connection #${ifaceIdx - 1}\n`;
      ifaceIdx++;
    }

    output += '===========================================================================\n\n';
    output += 'IPv4 Route Table\n';
    output += '===========================================================================\n';
    output += 'Active Routes:\n';
    output += 'Network Destination        Netmask          Gateway       Interface  Metric\n';

    // Add routes for each interface with an IP
    let primaryIp: string | null = null;
    for (const iface of sortedInterfaces) {
      const ip = iface.getIPAddress();
      const mask = iface.getSubnetMask();
      if (ip && mask) {
        if (!primaryIp) primaryIp = ip.toString();
        const network = this.getNetwork(ip, mask);
        output += `${network.padEnd(27)}${mask.toString().padEnd(17)}${ip.toString().padEnd(14)}${ip.toString().padEnd(11)}281\n`;
      }
    }

    if (gateway && primaryIp) {
      output += `${'0.0.0.0'.padEnd(27)}${'0.0.0.0'.padEnd(17)}${gateway.toString().padEnd(14)}${primaryIp.padEnd(11)}281\n`;
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

  NETSH Commands:
  NETSH INTERFACE SHOW INTERFACE     - Show network interfaces
  NETSH INTERFACE SET INTERFACE      - Enable/disable interface
  NETSH INTERFACE IP SHOW CONFIG     - Show IP configuration
  NETSH INTERFACE IP SET ADDRESS     - Configure IP address
  NETSH INTERFACE IP SET DNS         - Configure DNS servers
  NETSH WLAN SHOW PROFILES           - Show WiFi profiles
  NETSH WLAN SHOW NETWORKS           - Show available networks
  NETSH ADVFIREWALL SHOW CURRENTPROFILE - Show firewall status
  NETSH ADVFIREWALL FIREWALL SHOW RULE  - Show firewall rules
  NETSH WINHTTP SHOW PROXY           - Show proxy settings
  NETSH DUMP                         - Dump configuration script

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
