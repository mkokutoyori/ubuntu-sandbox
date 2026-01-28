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

    if (cmd.startsWith('ipconfig /')) {
      const validSwitches = ['/all', '/release', '/renew', '/flushdns', '/displaydns', '/registerdns'];
      const switchArg = cmd.substring(8).trim().toLowerCase();
      if (!validSwitches.includes(switchArg)) {
        return `Error: unrecognized or incomplete command line.

USAGE:
    ipconfig [/allcompartments] [/? | /all |
                                 /renew [adapter] | /release [adapter] |
                                 /renew6 [adapter] | /release6 [adapter] |
                                 /flushdns | /displaydns | /registerdns |
                                 /showclassid adapter |
                                 /setclassid adapter [classid] |
                                 /showclassid6 adapter |
                                 /setclassid6 adapter [classid] ]`;
      }
    }

    if (cmd === 'route' || cmd === 'route help' || cmd === 'route /?') {
      return `
Manipulates network routing tables.

ROUTE [-f] [-p] [-4|-6] command [destination]
                  [MASK netmask]  [gateway] [METRIC metric]  [IF interface]

  command      One of these:
                 PRINT     Prints  a route
                 ADD       Adds    a route
                 DELETE    Deletes a route
                 CHANGE    Modifies an existing route
  destination  Specifies the host.
  MASK         Specifies that the next parameter is the 'netmask' value.
  netmask      Specifies a subnet mask value for this route entry.
  gateway      Specifies gateway.`;
    }

    if (cmd === 'route print') {
      return this.getRouteOutput();
    }

    if (cmd === 'arp' || cmd === 'arp -a') {
      return this.getArpOutput();
    }

    if (cmd.startsWith('arp -') && !cmd.startsWith('arp -a') && !cmd.startsWith('arp -s') && !cmd.startsWith('arp -d')) {
      const opt = cmd.substring(5, 6);
      return `
ARP: bad argument: -${opt}
The ARP command failed: The parameter is incorrect.`;
    }

    if (cmd === 'ping') {
      return `\nUsage: ping [-n count] [-l size] [-w timeout] target_name\n\nOptions:\n    -n count       Number of echo requests to send.\n    -l size        Send buffer size.\n    -w timeout     Timeout in milliseconds to wait for each reply.`;
    }

    if (cmd.startsWith('ping ')) {
      const args = command.substring(5).trim();
      return this.executePing(args);
    }

    if (cmd === 'tracert') {
      return `\nUsage: tracert [-d] [-h maximum_hops] target_name\n\nOptions:\n    -d                 Do not resolve addresses to hostnames.\n    -h maximum_hops    Maximum number of hops to search for target.`;
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

    // Just netsh alone
    if (cmdLower === 'netsh') {
      return this.getNetshHelp();
    }

    // netsh help
    if (cmdLower === 'netsh /?' || cmdLower === 'netsh help' || cmdLower === 'netsh -?' || cmdLower === 'netsh ?') {
      return this.getNetshHelp();
    }

    // Route to appropriate handler
    if (cmdLower.startsWith('netsh interface ipv4 ')) {
      return this.executeNetshInterfaceIp(cmd.replace(/interface\s+ipv4/i, 'interface ip'));
    }

    if (cmdLower.startsWith('netsh interface ip ')) {
      return this.executeNetshInterfaceIp(cmd);
    }

    if (cmdLower.startsWith('netsh interface ') || cmdLower === 'netsh interface') {
      return this.executeNetshInterface(cmd);
    }

    if (cmdLower.startsWith('netsh wlan ') || cmdLower === 'netsh wlan') {
      return this.executeNetshWlan(cmd);
    }

    if (cmdLower.startsWith('netsh advfirewall ') || cmdLower === 'netsh advfirewall') {
      return this.executeNetshAdvfirewall(cmd);
    }

    if (cmdLower.startsWith('netsh winhttp ') || cmdLower === 'netsh winhttp') {
      return this.executeNetshWinhttp(cmd);
    }

    if (cmdLower === 'netsh dump') {
      return this.executeNetshDump();
    }

    // Unknown subcontext
    const context = args[1] || '';
    return `The following command was not found: ${context}.\n`;
  }

  /**
   * Returns netsh help
   */
  private getNetshHelp(): string {
    return `
Usage: netsh [-a AliasFile] [-c Context] [-r RemoteMachine] [-u [DomainName\\]UserName] [-p Password | *]
             [Command | -f ScriptFile]

The following commands are available:

Commands in this context:
?              - Displays a list of commands.
add            - Adds a configuration entry to a list of entries.
advfirewall    - Changes to the \`netsh advfirewall' context.
bridge         - Changes to the \`netsh bridge' context.
delete         - Deletes a configuration entry from a list of entries.
dhcpclient     - Changes to the \`netsh dhcpclient' context.
dnsclient      - Changes to the \`netsh dnsclient' context.
dump           - Displays a configuration script.
exec           - Runs a script file.
firewall       - Changes to the \`netsh firewall' context.
help           - Displays a list of commands.
http           - Changes to the \`netsh http' context.
interface      - Changes to the \`netsh interface' context.
ipsec          - Changes to the \`netsh ipsec' context.
lan            - Changes to the \`netsh lan' context.
mbn            - Changes to the \`netsh mbn' context.
namespace      - Changes to the \`netsh namespace' context.
netio          - Changes to the \`netsh netio' context.
p2p            - Changes to the \`netsh p2p' context.
ras            - Changes to the \`netsh ras' context.
rpc            - Changes to the \`netsh rpc' context.
set            - Updates configuration settings.
show           - Displays information.
trace          - Changes to the \`netsh trace' context.
wfp            - Changes to the \`netsh wfp' context.
winhttp        - Changes to the \`netsh winhttp' context.
winsock        - Changes to the \`netsh winsock' context.
wlan           - Changes to the \`netsh wlan' context.

The following sub-contexts are available:
 advfirewall bridge dhcpclient dnsclient firewall http interface ipsec lan mbn
 namespace netio p2p ras rpc trace wfp winhttp winsock wlan

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

    // netsh interface help or ?
    if (cmdLower === 'netsh interface' || cmdLower === 'netsh interface ?' || cmdLower === 'netsh interface help') {
      return `
The following commands are available:

Commands in this context:
?              - Displays a list of commands.
6to4           - Changes to the \`netsh interface 6to4' context.
dump           - Displays a configuration script.
help           - Displays a list of commands.
httpstunnel    - Changes to the \`netsh interface httpstunnel' context.
ip             - Changes to the \`netsh interface ip' context.
ipv4           - Changes to the \`netsh interface ipv4' context.
ipv6           - Changes to the \`netsh interface ipv6' context.
isatap         - Changes to the \`netsh interface isatap' context.
portproxy      - Changes to the \`netsh interface portproxy' context.
set            - Sets configuration information.
show           - Displays information.
tcp            - Changes to the \`netsh interface tcp' context.
teredo         - Changes to the \`netsh interface teredo' context.
udp            - Changes to the \`netsh interface udp' context.

The following sub-contexts are available:
 6to4 httpstunnel ip ipv4 ipv6 isatap portproxy tcp teredo udp

To view help for a command, type the command, followed by a space, and then
 type ?.
`;
    }

    return `The following command was not found: ${command.replace(/^netsh\s+interface\s+/i, '')}.`;
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

    // Extract interface name using various patterns
    const nameMatch = command.match(/name="([^"]+)"/i) ||
                      command.match(/"([^"]+)"/i) ||
                      command.match(/name=(\S+)/i);

    if (!nameMatch) {
      return `
The syntax supplied for this command is not valid. Check help for the correct syntax.

Usage: set interface [name=]<string>
             [[admin=]enabled|disabled]
             [[connect=]connected|disconnected]
             [[newname=]<string>]

Parameters:

       Tag            Value
       name         - Interface name.
       admin        - Enable or disable the interface.
       connect      - Connect or disconnect the interface.
       newname      - New name for the interface.

Remarks: This command is used to change the state of an interface.

Examples:

       set interface name="Local Area Connection" admin=disabled
       set interface name="Local Area Connection" newname="Connection 1"
`;
    }

    const interfaceName = nameMatch[1];
    const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' :
                      interfaceName.toLowerCase() === 'local area connection' ? 'eth0' : interfaceName;
    const iface = this.getInterface(ifaceName);

    if (!iface) {
      return `The interface with the specified name was not found.\n\nThe filename, directory name, or volume label syntax is incorrect.`;
    }

    // Check for enable/disable
    if (cmdLower.includes('admin=enabled') || cmdLower.includes('enabled')) {
      iface.up();
      return '';
    }

    if (cmdLower.includes('admin=disabled') || cmdLower.includes('disabled')) {
      iface.down();
      return '';
    }

    // Check for connect/disconnect
    if (cmdLower.includes('connect=connected')) {
      iface.up();
      return '';
    }

    if (cmdLower.includes('connect=disconnected')) {
      iface.down();
      return '';
    }

    return `
The syntax supplied for this command is not valid. Check help for the correct syntax.

Usage: set interface [name=]<string>
             [[admin=]enabled|disabled]
             [[connect=]connected|disconnected]
             [[newname=]<string>]
`;
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
      return `
The syntax supplied for this command is not valid. Check help for the correct syntax.

Usage: set address [name=]<string>
             [[source=]dhcp|static]
             [[address=]<IPv4 address>[/<integer>] [[mask=]<IPv4 mask>]
               [[gateway=]<IPv4 address>|none [gwmetric=]<integer>]]
             [[type=]unicast|anycast]
             [[subinterface=]<string>]
             [[store=]active|persistent]

Parameters:

       Tag            Value
       name         - Interface name or index.
       source       - One of the following values:
                      dhcp: Enables DHCP for configuring IP addresses for
                            the specified interface.
                      static: Disables DHCP for configuring IP addresses
                              for the specified interface.
       address      - IPv4 address optionally followed by the subnet prefix
                      length.
       mask         - IP subnet mask for the specified IP address.
       gateway      - One of the following values:
                      <IPv4 address>: A specific default gateway for the
                              static IP address you are setting.
                      none: No default gateways are set.
       gwmetric     - Metric for the default gateway.  This field should
                      only be set when a gateway is specified.
       type         - One of the following values:
                      unicast: The address being added is a unicast address.
                               This is the default value.
                      anycast: The address being added is an anycast address.
       subinterface - LUID of subinterface on which to set the address.
       store        - One of the following values:
                      active: Set only lasts until next boot.
                      persistent: Set is persistent.  This is the default.

Remarks: Changes the IP address configuration to either DHCP mode or static
         mode.  If static mode is enabled, then the IP address and, optionally,
         the IP subnet mask can be supplied.  If gateway is supplied, then
         gateway metric should also be supplied.

Examples:

       set address name="Local Area Connection" source=dhcp
       set address "Local Area Connection" static 10.0.0.9 255.0.0.0 10.0.0.1 1
`;
    }

    const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' :
                      interfaceName.toLowerCase() === 'local area connection' ? 'eth0' : interfaceName;
    const iface = this.getInterface(ifaceName);

    if (!iface) {
      return `Interface ${interfaceName} was not found.\n\nThe system cannot find the file specified.`;
    }

    // DHCP mode
    if (cmdLower.includes('dhcp') || cmdLower.includes('source=dhcp')) {
      this.dhcpEnabled.set(ifaceName, true);
      return '';
    }

    // Static mode - try different patterns
    // Pattern 1: netsh interface ip set address "Ethernet0" static IP MASK [GATEWAY]
    const staticMatch = command.match(/static\s+(\S+)\s+(\S+)(?:\s+(\S+))?/i);

    // Pattern 2: netsh interface ip set address name="Ethernet0" source=static addr=IP mask=MASK
    const altMatch = command.match(/addr(?:ess)?=([^\s=]+)\s+mask=([^\s=]+)/i);

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
      return `
The syntax supplied for this command is not valid. Check help for the correct syntax.

Usage: set address [name=]<string> [[source=]dhcp|static]
             [[address=]<IPv4 address> [[mask=]<IPv4 mask>]
               [[gateway=]<IPv4 address>|none]]
`;
    }

    // Validate IP
    let ip: IPAddress;
    try {
      ip = new IPAddress(ipStr);
    } catch (e) {
      return `The IPv4 address ${ipStr} is not valid.\n\nThe parameter is incorrect.`;
    }

    // Validate mask
    let mask: SubnetMask;
    try {
      mask = new SubnetMask(maskStr);
    } catch (e) {
      return `The IPv4 netmask ${maskStr} is not valid.\n\nThe parameter is incorrect.`;
    }

    // Configure interface
    this.setIPAddress(ifaceName, ip, mask);
    this.dhcpEnabled.set(ifaceName, false);
    iface.up();

    // Configure gateway if provided
    if (gatewayStr && gatewayStr.toLowerCase() !== 'none') {
      try {
        const gateway = new IPAddress(gatewayStr);
        this.setGateway(gateway);
      } catch (e) {
        return `The default gateway ${gatewayStr} is not valid.\n\nThe parameter is incorrect.`;
      }
    }

    return '';
  }

  /**
   * Sets DNS server
   */
  private netshSetDns(command: string): string {
    const cmdLower = command.toLowerCase();

    // Extract interface name
    const nameMatch = command.match(/"([^"]+)"/i);
    const interfaceName = nameMatch?.[1] || 'Ethernet0';
    const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' :
                      interfaceName.toLowerCase() === 'local area connection' ? 'eth0' : interfaceName;

    const iface = this.getInterface(ifaceName);
    if (!iface) {
      return `Interface ${interfaceName} was not found.\n\nThe system cannot find the file specified.`;
    }

    // DHCP mode
    if (cmdLower.includes('dhcp') || cmdLower.includes('source=dhcp')) {
      this.dnsServers.set(ifaceName, []);
      return '';
    }

    // Static DNS - try different patterns
    const dnsMatch = command.match(/static\s+(\S+)/i) ||
                     command.match(/address=(\S+)/i) ||
                     command.match(/addr=(\S+)/i);

    if (!dnsMatch) {
      return `
The syntax supplied for this command is not valid. Check help for the correct syntax.

Usage: set dnsservers [name=]<string> [source=]dhcp|static
             [[address=]<IP address>|none]
             [[register=]none|primary|both]
             [[validate=]yes|no]

Parameters:

       Tag            Value
       name         - Interface name or index.
       source       - One of the following values:
                      dhcp: Sets DHCP as the source for configuring DNS
                            servers for the specified interface.
                      static: Sets the source for configuring DNS servers
                              to local static configuration.
       address      - One of the following values:
                      <IP address>: An IP address for a DNS server.
                      none: Clears the list of DNS servers.
       register     - One of the following values:
                      none: Disables Dynamic DNS registration.
                      primary: Register under the primary DNS suffix only.
                      both: Register under both the primary DNS suffix, as
                            well as under the connection-specific suffix.
       validate     - Specifies whether validation of the DNS server
                      setting will be performed. The value is yes by
                      default.

Remarks: Sets DNS server configuration to either DHCP or static mode.  Only
         when source is "static", is the "address" option also available for
         configuring a static list of DNS server IP addresses for the
         specified interface.

Examples:

       set dnsservers name="Local Area Connection" source=dhcp
       set dnsservers "Local Area Connection" static 10.0.0.1 primary
`;
    }

    const dnsStr = dnsMatch[1];

    // Handle 'none' to clear DNS
    if (dnsStr.toLowerCase() === 'none') {
      this.dnsServers.set(ifaceName, []);
      return '';
    }

    // Validate DNS IP
    try {
      new IPAddress(dnsStr);
    } catch (e) {
      return `The DNS server address ${dnsStr} is not valid.\n\nThe parameter is incorrect.`;
    }

    this.dnsServers.set(ifaceName, [dnsStr]);
    return '';
  }

  /**
   * Adds DNS server
   */
  private netshAddDns(command: string): string {
    // Extract interface name
    const nameMatch = command.match(/"([^"]+)"/i);
    const interfaceName = nameMatch?.[1] || 'Ethernet0';
    const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' :
                      interfaceName.toLowerCase() === 'local area connection' ? 'eth0' : interfaceName;

    const iface = this.getInterface(ifaceName);
    if (!iface) {
      return `Interface ${interfaceName} was not found.\n\nThe system cannot find the file specified.`;
    }

    // Extract DNS IP - try address= pattern first, then fall back to finding IP
    const addrMatch = command.match(/address=(\S+)/i) || command.match(/addr=(\S+)/i);
    let dnsIp: string | undefined;

    if (addrMatch) {
      dnsIp = addrMatch[1];
    } else {
      // Fall back to finding an IP address in the command
      const parts = command.split(/\s+/);
      dnsIp = parts.find(p => {
        try {
          new IPAddress(p);
          return true;
        } catch {
          return false;
        }
      });
    }

    if (!dnsIp) {
      return `
The syntax supplied for this command is not valid. Check help for the correct syntax.

Usage: add dnsservers [name=]<string> [address=]<IPv4 address>
             [[index=]<integer>] [[validate=]yes|no]

Parameters:

       Tag            Value
       name         - Interface name or index.
       address      - IPv4 address of the DNS server to be added.
       index        - Specifies the index (preference) for the specified
                      DNS server address.
       validate     - Specifies whether validation of the DNS server
                      setting will be performed. The value is yes by
                      default.

Remarks: Adds a new DNS server IP address to the statically-configured list.
         By default, the DNS server is added to the end of the list.  If an
         index is specified, the DNS server will be placed in that position
         in the list, with other servers being moved down to make room.
         If DNS servers were previously obtained through DHCP, the new
         address will replace the old list.

Examples:

       add dnsservers "Local Area Connection" 10.0.0.1
       add dnsservers "Local Area Connection" 10.0.0.3 index=2
`;
    }

    // Validate DNS IP
    try {
      new IPAddress(dnsIp);
    } catch {
      return `The DNS server address ${dnsIp} is not valid.\n\nThe parameter is incorrect.`;
    }

    const existing = this.dnsServers.get(ifaceName) || [];

    // Check for index parameter
    const indexMatch = command.match(/index=(\d+)/i);
    if (indexMatch) {
      const index = parseInt(indexMatch[1], 10) - 1; // Convert to 0-based
      if (index >= 0 && index <= existing.length) {
        existing.splice(index, 0, dnsIp);
      } else {
        existing.push(dnsIp);
      }
    } else {
      existing.push(dnsIp);
    }

    this.dnsServers.set(ifaceName, existing);
    return '';
  }

  /**
   * Deletes DNS server
   */
  private netshDeleteDns(command: string): string {
    const cmdLower = command.toLowerCase();

    // Extract interface name
    const nameMatch = command.match(/"([^"]+)"/i);
    const interfaceName = nameMatch?.[1] || 'Ethernet0';
    const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' :
                      interfaceName.toLowerCase() === 'local area connection' ? 'eth0' : interfaceName;

    const iface = this.getInterface(ifaceName);
    if (!iface) {
      return `Interface ${interfaceName} was not found.\n\nThe system cannot find the file specified.`;
    }

    // Delete all
    if (cmdLower.includes('all') || cmdLower.includes('address=all')) {
      this.dnsServers.set(ifaceName, []);
      return '';
    }

    // Delete specific - try address= pattern first
    const addrMatch = command.match(/address=(\S+)/i) || command.match(/addr=(\S+)/i);
    let dnsIp: string | undefined;

    if (addrMatch) {
      dnsIp = addrMatch[1];
    } else {
      const parts = command.split(/\s+/);
      dnsIp = parts.find(p => {
        try {
          new IPAddress(p);
          return true;
        } catch {
          return false;
        }
      });
    }

    if (!dnsIp) {
      return `
The syntax supplied for this command is not valid. Check help for the correct syntax.

Usage: delete dnsservers [name=]<string> [[address=]<IP address>|all]

Parameters:

       Tag            Value
       name         - Interface name or index.
       address      - One of the following values:
                      <IP address>: A specific IP address of a DNS server
                              you are deleting.
                      all: Deletes all configured IP addresses for DNS
                           servers.

Remarks: Deletes statically-configured DNS server IP addresses for a
         specified interface.

Examples:

       delete dnsservers "Local Area Connection" all
       delete dnsservers "Local Area Connection" 10.0.0.1
`;
    }

    const existing = this.dnsServers.get(ifaceName) || [];
    const filtered = existing.filter(d => d !== dnsIp);

    if (filtered.length === existing.length) {
      return `DNS server ${dnsIp} was not found on interface ${interfaceName}.\n\nElement not found.`;
    }

    this.dnsServers.set(ifaceName, filtered);
    return '';
  }

  /**
   * Adds secondary IP address
   */
  private netshAddAddress(command: string): string {
    // Extract interface name
    const nameMatch = command.match(/"([^"]+)"/i);
    const interfaceName = nameMatch?.[1] || 'Ethernet0';
    const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' :
                      interfaceName.toLowerCase() === 'local area connection' ? 'eth0' : interfaceName;

    const iface = this.getInterface(ifaceName);
    if (!iface) {
      return `Interface ${interfaceName} was not found.\n\nThe system cannot find the file specified.`;
    }

    // Extract address
    const addrMatch = command.match(/address=(\S+)/i) || command.match(/addr=(\S+)/i);
    if (!addrMatch) {
      return `
The syntax supplied for this command is not valid. Check help for the correct syntax.

Usage: add address [name=]<string> [[address=]<IPv4 address>[/<integer>]
             [[mask=]<IPv4 mask>]  [gateway=]<IPv4 address>|none
             [gwmetric=]<integer>] [[type=]unicast|anycast]
             [[subinterface=]<string>]
             [[validlifetime=]<integer>|infinite]
             [[preferredlifetime=]<integer>|infinite]
             [[store=]active|persistent]

Parameters:

       Tag              Value
       name           - Interface name or index.
       address        - IPv4 address to add.
       mask           - Subnet mask for the IPv4 address being added.
       gateway        - One of the following values:
                        <IPv4 address>: A specific gateway for the
                                address being added.
                        none: No gateway is set.
       gwmetric       - Gateway metric.  Should only be specified when
                        gateway is specified.
       type           - One of the following values:
                        unicast: The address being added is a unicast
                                 address.  This is the default value.
                        anycast: The address being added is an anycast
                                 address.
       subinterface   - Subinterface LUID for the address.
       validlifetime  - Lifetime over which the address is valid.
                        The default value is infinite.
       preferredlifetime - Lifetime over which the address is preferred.
                        The default value is infinite.
       store          - One of the following values:
                        active: Set only lasts until next boot.
                        persistent: Set is persistent. This is the default.

Examples:

       add address "Local Area Connection" 10.0.0.2 255.0.0.0
       add address "Local Area Connection" gateway=10.0.0.1 gwmetric=0
`;
    }

    // Validate IP address
    const ipStr = addrMatch[1].split('/')[0]; // Handle CIDR notation
    try {
      new IPAddress(ipStr);
    } catch {
      return `The IPv4 address ${ipStr} is not valid.\n\nThe parameter is incorrect.`;
    }

    // For now, just acknowledge (multi-IP support would require more infrastructure)
    return '';
  }

  /**
   * Deletes IP address
   */
  private netshDeleteAddress(command: string): string {
    // Extract interface name
    const nameMatch = command.match(/"([^"]+)"/i);
    const interfaceName = nameMatch?.[1] || 'Ethernet0';
    const ifaceName = interfaceName.toLowerCase() === 'ethernet0' ? 'eth0' :
                      interfaceName.toLowerCase() === 'local area connection' ? 'eth0' : interfaceName;

    const iface = this.getInterface(ifaceName);
    if (!iface) {
      return `Interface ${interfaceName} was not found.\n\nThe system cannot find the file specified.`;
    }

    // Extract address
    const addrMatch = command.match(/address=(\S+)/i) || command.match(/addr=(\S+)/i);
    if (!addrMatch) {
      return `
The syntax supplied for this command is not valid. Check help for the correct syntax.

Usage: delete address [name=]<string> [[address=]<IPv4 address>]
             [[gateway=]<IPv4 address>|all]
             [[store=]active|persistent]

Parameters:

       Tag            Value
       name         - Interface name or index.
       address      - IPv4 address to delete.
       gateway      - One of the following values:
                      <IPv4 address>: A specific gateway to delete.
                      all: Deletes all gateways.
       store        - One of the following values:
                      active: Deletion only lasts until next boot.
                      persistent: Deletion is persistent.  This is the
                              default.

Remarks: Deletes an IP address from an interface.

Examples:

       delete address "Local Area Connection" 10.0.0.1
       delete address "Local Area Connection" gateway=all
`;
    }

    // Acknowledge the delete
    return '';
  }

  /**
   * Executes netsh wlan commands
   */
  private executeNetshWlan(command: string): string {
    const cmdLower = command.toLowerCase();

    // Help for wlan context
    if (cmdLower === 'netsh wlan' || cmdLower === 'netsh wlan ?' || cmdLower === 'netsh wlan help') {
      return `
The following commands are available:

Commands in this context:
?              - Displays a list of commands.
add            - Adds a configuration entry to a table.
connect        - Connects to a wireless network.
delete         - Deletes a configuration entry from a table.
disconnect     - Disconnects from a wireless network.
dump           - Displays a configuration script.
export         - Saves WLAN profiles to XML files.
help           - Displays a list of commands.
IHV            - Commands for IHV logging.
refresh        - Refresh hosted network settings.
reportissues   - Generate WLAN smart trace report.
set            - Sets configuration information.
show           - Displays information.
start          - Start hosted network.
stop           - Stop hosted network.

To view help for a command, type the command, followed by a space, and then
 type ?.
`;
    }

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

    if (cmdLower.includes('delete profile')) {
      const nameMatch = command.match(/name="?([^"\s]+)"?/i);
      if (!nameMatch) {
        return `
The syntax supplied for this command is not valid. Check help for the correct syntax.

Usage: delete profile [name=]<string> [[interface=]<string>]

Parameters:

       Tag            Value
       name         - Name of the WLAN profile to delete.
       interface    - Name of the interface on which the profile is to be
                      deleted. If the interface name is not specified,
                      the profile will be deleted on all interfaces.

Examples:

       delete profile name="SimpleProfile"
       delete profile name="SimpleProfile" interface="Wireless Network Connection"
`;
      }
      const profileName = nameMatch[1];
      const idx = this.wifiProfiles.indexOf(profileName);
      if (idx === -1) {
        return `Profile "${profileName}" is not found on any interface.\n`;
      }
      this.wifiProfiles.splice(idx, 1);
      return `Profile "${profileName}" is deleted from interface "Wi-Fi".\n`;
    }

    return `The following command was not found: ${command.replace(/^netsh\s+wlan\s+/i, '')}.`;
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
      return 'Resetting to the default firewall policy might result in loss of\nremote connectivity to this machine. Continue? (Y/N)\nOk.\n';
    }

    // Help for advfirewall context
    if (cmdLower === 'netsh advfirewall' || cmdLower === 'netsh advfirewall ?' || cmdLower === 'netsh advfirewall help') {
      return `
The following commands are available:

Commands in this context:
?              - Displays a list of commands.
consec         - Changes to the \`netsh advfirewall consec' context.
dump           - Displays a configuration script.
export         - Exports the current policy to a file.
firewall       - Changes to the \`netsh advfirewall firewall' context.
help           - Displays a list of commands.
import         - Imports a policy file into the current policy store.
mainmode       - Changes to the \`netsh advfirewall mainmode' context.
monitor        - Changes to the \`netsh advfirewall monitor' context.
reset          - Resets the policy to the default out-of-box policy.
set            - Sets the per-profile or global settings.
show           - Displays profile or global properties.

The following sub-contexts are available:
 consec firewall mainmode monitor

To view help for a command, type the command, followed by a space, and then
 type ?.
`;
    }

    return `The following command was not found: ${command.replace(/^netsh\s+advfirewall\s+/i, '')}.`;
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
    const remotePortMatch = command.match(/remoteport=(\w+)/i);
    const programMatch = command.match(/program="([^"]+)"/i);
    const profileMatch = command.match(/profile=(\w+)/i);
    const enableMatch = command.match(/enable=(\w+)/i);
    const localipMatch = command.match(/localip=(\S+)/i);
    const remoteipMatch = command.match(/remoteip=(\S+)/i);

    if (!nameMatch) {
      return `
The syntax supplied for this command is not valid. Check help for the correct syntax.

Usage: add rule name=<string>
      dir=in|out
      action=allow|block|bypass
      [program=<program path>]
      [service=<service short name>|any]
      [description=<string>]
      [enable=yes|no (default=yes)]
      [profile=public|private|domain|any[,...]]
      [localip=any|<IPv4 address>|<IPv6 address>|<subnet>|<range>|<list>]
      [remoteip=any|localsubnet|dns|dhcp|wins|defaultgateway|
         <IPv4 address>|<IPv6 address>|<subnet>|<range>|<list>]
      [localport=0-65535|<port range>[,...]|RPC|RPC-EPMap|IPHTTPS|any (default=any)]
      [remoteport=0-65535|<port range>[,...]|any (default=any)]
      [protocol=0-255|icmpv4|icmpv6|icmpv4:type,code|icmpv6:type,code|
         tcp|udp|any (default=any)]
      [interfacetype=wireless|lan|ras|any]
      [rmtcomputergrp=<SDDL string>]
      [rmtusrgrp=<SDDL string>]
      [edge=yes|deferapp|deferuser|no (default=no)]
      [security=authenticate|authenc|authdynenc|authnoencap|notrequired
         (default=notrequired)]

Remarks:

      - Add a new inbound or outbound rule to the firewall policy.
      - Rule name should be unique and cannot be "all".
      - If a remote computer or user group is specified, security must be
        authenticate, authenc, authdynenc, or authnoencap.
      - Setting security to authdynenc allows systems to dynamically
        negotiate the use of encryption for traffic that matches
        a given Windows Firewall rule. Encryption is negotiated based on
        existing connection security rule properties. This option
        enables the ability of a machine to accept the first TCP
        or UDP packet of an inbound IPsec connection as long as
        it is secured, but not encrypted, using IPsec.
        Once the first packet is processed, the server will
        re-negotiate the connection and upgrade it so that
        all subsequent communications are fully encrypted.
      - If action=bypass, the remote computer group must be specified when dir=in.
      - If service=any, the rule applies to services only.
      - ICMP type or code can be "any".
      - Edge can only be specified for inbound rules.

Examples:

      Add an inbound rule with no encapsulation for messenger.exe:
      netsh advfirewall firewall add rule name="allow messenger"
      dir=in program="c:\\programfiles\\messenger\\msmsgs.exe"
      action=allow

      Add an outbound rule for port 80:
      netsh advfirewall firewall add rule name="allow80"
      protocol=TCP dir=out localport=80 action=block

      Add an inbound rule requiring security and encryption
      for TCP port 80 traffic:
      netsh advfirewall firewall add rule name="Require Encryption for Inbound TCP/80"
      protocol=TCP dir=in localport=80 security=authdynenc action=allow

      Add an inbound rule for messenger.exe and require security
      netsh advfirewall firewall add rule name="allow messenger"
      dir=in program="c:\\program files\\messenger\\msmsgs.exe"
      security=authenticate action=allow

      Add an authenticated firewall bypass rule for group
      acmedomain\\scanners identified by a SDDL string:
      netsh advfirewall firewall add rule name="allow scanners"
      dir=in rmtcomputergrp=<SDDL string> action=bypass
      security=authenticate

      Add an outbound allow rule for local ports 5000-5010 for udp-
      Add rule name="Allow port range" dir=out protocol=udp localport=5000-5010 action=allow
`;
    }

    if (!dirMatch) {
      return `Required option 'dir' is missing.\n`;
    }

    if (!actionMatch) {
      return `Required option 'action' is missing.\n`;
    }

    // Validate direction
    const dir = dirMatch[1].toLowerCase();
    if (dir !== 'in' && dir !== 'out') {
      return `The value specified for 'dir' is invalid. It must be either in or out.\n`;
    }

    // Validate action
    const action = actionMatch[1].toLowerCase();
    if (action !== 'allow' && action !== 'block' && action !== 'bypass') {
      return `The value specified for 'action' is invalid. It must be allow, block, or bypass.\n`;
    }

    // Validate protocol if specified
    if (protocolMatch) {
      const protocol = protocolMatch[1].toLowerCase();
      const validProtocols = ['tcp', 'udp', 'icmpv4', 'icmpv6', 'any'];
      if (!validProtocols.includes(protocol) && !/^\d+$/.test(protocol)) {
        return `The value specified for 'protocol' is invalid. Specify a valid protocol.\n`;
      }
    }

    const rule: FirewallRule = {
      name: nameMatch[1],
      dir: dir as 'in' | 'out',
      action: action as 'allow' | 'block',
      protocol: protocolMatch?.[1]?.toUpperCase(),
      localport: portMatch?.[1],
      program: programMatch?.[1],
      enabled: enableMatch ? enableMatch[1].toLowerCase() !== 'no' : true,
    };

    this.firewallRules.push(rule);
    return 'Ok.\n';
  }

  /**
   * Deletes firewall rule
   */
  private netshFirewallDeleteRule(command: string): string {
    const nameMatch = command.match(/name="([^"]+)"/i);
    const dirMatch = command.match(/dir=(\w+)/i);
    const protocolMatch = command.match(/protocol=(\w+)/i);

    if (!nameMatch) {
      return `
The syntax supplied for this command is not valid. Check help for the correct syntax.

Usage: delete rule name=<string>
      [dir=in|out]
      [profile=public|private|domain|any[,...]]
      [program=<program path>]
      [service=<service short name>|any]
      [localip=any|<IPv4 address>|<IPv6 address>|<subnet>|<range>|<list>]
      [remoteip=any|localsubnet|dns|dhcp|wins|defaultgateway|
         <IPv4 address>|<IPv6 address>|<subnet>|<range>|<list>]
      [localport=0-65535|<port range>[,...]|RPC|RPC-EPMap|any]
      [remoteport=0-65535|<port range>[,...]|any]
      [protocol=0-255|icmpv4|icmpv6|icmpv4:type,code|icmpv6:type,code|
         tcp|udp|any]

Remarks:

      - Deletes a rule identified by rule name and optionally by endpoint,
        port, and protocol.
      - If multiple matches are found, all matching rules are deleted.
      - If name=all is specified, all rules are deleted from the
        specified type and profile.

Examples:

      Delete all rules for local port 80:
      netsh advfirewall firewall delete rule name=all protocol=tcp localport=80

      Delete a rule named "allow80":
      netsh advfirewall firewall delete rule name="allow80"
`;
    }

    const ruleName = nameMatch[1];
    let rulesToDelete = this.firewallRules;

    // Handle name=all case
    if (ruleName.toLowerCase() === 'all') {
      // Filter by additional criteria if provided
      if (dirMatch) {
        rulesToDelete = rulesToDelete.filter(r => r.dir === dirMatch[1].toLowerCase());
      }
      if (protocolMatch) {
        rulesToDelete = rulesToDelete.filter(r => r.protocol?.toLowerCase() === protocolMatch[1].toLowerCase());
      }

      const count = rulesToDelete.length;
      this.firewallRules = this.firewallRules.filter(r => !rulesToDelete.includes(r));

      if (count === 0) {
        return 'No rules match the specified criteria.\n';
      }
      return `Deleted ${count} rule(s).\nOk.\n`;
    }

    // Find rules by name
    const matchingRules = this.firewallRules.filter(r => r.name === ruleName);

    if (matchingRules.length === 0) {
      return 'No rules match the specified criteria.\n';
    }

    this.firewallRules = this.firewallRules.filter(r => r.name !== ruleName);
    return `Deleted ${matchingRules.length} rule(s).\nOk.\n`;
  }

  /**
   * Sets/modifies firewall rule
   */
  private netshFirewallSetRule(command: string): string {
    const nameMatch = command.match(/name="([^"]+)"/i);
    const cmdLower = command.toLowerCase();

    if (!nameMatch) {
      return `
The syntax supplied for this command is not valid. Check help for the correct syntax.

Usage: set rule
      group=<string> | name=<string>
      [dir=in|out]
      [profile=public|private|domain|any[,...]]
      [program=<program path>]
      [service=<service short name>|any]
      [localip=any|<IPv4 address>|<IPv6 address>|<subnet>|<range>|<list>]
      [remoteip=any|localsubnet|dns|dhcp|wins|defaultgateway|
         <IPv4 address>|<IPv6 address>|<subnet>|<range>|<list>]
      [localport=0-65535|RPC|RPC-EPMap|any[,...]]
      [remoteport=0-65535|any[,...]]
      [protocol=0-255|icmpv4|icmpv6|icmpv4:type,code|icmpv6:type,code|
         tcp|udp|any]
      new
      [name=<string>]
      [dir=in|out]
      [program=<program path>
      [service=<service short name>|any]
      [action=allow|block|bypass]
      [description=<string>]
      [enable=yes|no]
      [profile=public|private|domain|any[,...]]
      [localip=any|<IPv4 address>|<IPv6 address>|<subnet>|<range>|<list>]
      [remoteip=any|localsubnet|dns|dhcp|wins|defaultgateway|
         <IPv4 address>|<IPv6 address>|<subnet>|<range>|<list>]
      [localport=0-65535|RPC|RPC-EPMap|any[,...]]
      [remoteport=0-65535|any[,...]]
      [protocol=0-255|icmpv4|icmpv6|icmpv4:type,code|icmpv6:type,code|
         tcp|udp|any]
      [interfacetype=wireless|lan|ras|any]
      [rmtcomputergrp=<SDDL string>]
      [rmtusrgrp=<SDDL string>]
      [edge=yes|deferapp|deferuser|no (default=no)]
      [security=authenticate|authenc|authdynenc|authnoencap|notrequired]

Remarks:

      - Sets a new value for a given property on an identified rule.
        Fails if the rule does not exist. To create a rule, use the add
        command.
      - Values after the new keyword are updated in the rule.  If there
        are no values, or keyword new is missing, no changes are made.
      - A group of rules can only be enabled or disabled.
      - If multiple rules match the criteria, all matching rules will
        be updated.
      - Rule name should be unique and cannot be "all".
      - If a remote computer or user group is specified, security must be
        authenticate, authenc, authdynenc, or authnoencap.
      - Setting security to authdynenc allows systems to dynamically
        negotiate the use of encryption for traffic that matches
        a given Windows Firewall rule.

Examples:

      Change the remote IP address on a rule named "allow80":
      netsh advfirewall firewall set rule name="allow80" new
      remoteip=192.168.0.2

      Enable a group with grouping string "Remote Desktop":
      netsh advfirewall firewall set rule group="Remote Desktop" new
      enable=yes

      Change the local ports on the rule "Allow port range" for udp:
      Set rule name="Allow port range" dir=out protocol=udp localport=5000-5020
      new localport=5000-5050
`;
    }

    const ruleName = nameMatch[1];

    // Check if 'new' keyword is present
    if (!cmdLower.includes(' new ') && !cmdLower.includes(' new\n') && !cmdLower.endsWith(' new')) {
      return `The syntax supplied for this command is not valid. The 'new' keyword is required.\n`;
    }

    const rule = this.firewallRules.find(r => r.name === ruleName);

    if (!rule) {
      return 'No rules match the specified criteria.\n';
    }

    // Extract new values after 'new' keyword
    const newMatch = cmdLower.indexOf(' new');
    const newPart = command.substring(newMatch);

    // Update enable status
    if (newPart.toLowerCase().includes('enable=yes')) {
      rule.enabled = true;
    } else if (newPart.toLowerCase().includes('enable=no')) {
      rule.enabled = false;
    }

    // Update action
    const actionMatch = newPart.match(/action=(\w+)/i);
    if (actionMatch) {
      rule.action = actionMatch[1].toLowerCase() as 'allow' | 'block';
    }

    // Update protocol
    const protocolMatch = newPart.match(/protocol=(\w+)/i);
    if (protocolMatch) {
      rule.protocol = protocolMatch[1].toUpperCase();
    }

    // Update local port
    const portMatch = newPart.match(/localport=(\S+)/i);
    if (portMatch) {
      rule.localport = portMatch[1];
    }

    // Update program
    const programMatch = newPart.match(/program="([^"]+)"/i);
    if (programMatch) {
      rule.program = programMatch[1];
    }

    return 'Updated 1 rule(s).\nOk.\n';
  }

  /**
   * Executes netsh winhttp commands
   */
  private executeNetshWinhttp(command: string): string {
    const cmdLower = command.toLowerCase();

    // Help for winhttp context
    if (cmdLower === 'netsh winhttp' || cmdLower === 'netsh winhttp ?' || cmdLower === 'netsh winhttp help') {
      return `
The following commands are available:

Commands in this context:
?              - Displays a list of commands.
dump           - Displays a configuration script.
help           - Displays a list of commands.
import         - Import WinHTTP proxy settings.
reset          - Resets WinHTTP settings.
set            - Configures WinHTTP settings.
show           - Displays current settings.

To view help for a command, type the command, followed by a space, and then
 type ?.
`;
    }

    if (cmdLower.includes('show proxy')) {
      return this.netshWinhttpShowProxy();
    }

    // Check reset proxy BEFORE set proxy because "reset proxy" contains "set proxy"
    if (cmdLower.includes('reset proxy')) {
      this.proxyServer = null;
      this.proxyBypass = null;
      return '\nCurrent WinHTTP proxy settings:\n\n    Direct access (no proxy server).\n';
    }

    if (cmdLower.includes('set proxy')) {
      return this.netshWinhttpSetProxy(command);
    }

    if (cmdLower.includes('import proxy')) {
      // Simulates importing IE proxy settings
      return '\nCurrent WinHTTP proxy settings:\n\n    Direct access (no proxy server).\n';
    }

    return `The following command was not found: ${command.replace(/^netsh\s+winhttp\s+/i, '')}.`;
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
    // Try different patterns
    const proxyMatch = command.match(/proxy-server="?([^"\s]+)"?/i) ||
                       command.match(/proxy\s+(?:proxy-server=)?"?([^"\s]+)"?/i);
    const bypassMatch = command.match(/bypass-list="?([^"\s]+)"?/i);

    if (!proxyMatch) {
      return `
The syntax supplied for this command is not valid. Check help for the correct syntax.

Usage: set proxy [proxy-server=]<server name> [bypass-list=]<hosts list>

Parameters:

      Tag             Value
      proxy-server  - proxy server for use for http and/or https protocol
      bypass-list   - a list of sites that should be visited bypassing the
                     proxy (use "<local>" to bypass all short name hosts)

Examples:

      set proxy myproxy.corp.com:80 "<local>;*.ms.com"
      set proxy proxy-server="myproxy.corp.com:80" bypass-list="<local>;*.ms.com"
`;
    }

    this.proxyServer = proxyMatch[1];

    if (bypassMatch) {
      this.proxyBypass = bypassMatch[1];
    }

    let output = '\nCurrent WinHTTP proxy settings:\n\n';
    output += `    Proxy Server(s) :  ${this.proxyServer}\n`;
    if (this.proxyBypass) {
      output += `    Bypass List     :  ${this.proxyBypass}\n`;
    }

    return output;
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
   * Supports: ping [-n count] [-l size] [-w timeout] target
   */
  private executePing(args: string): string {
    // Parse ping arguments
    const parts = args.split(/\s+/).filter(p => p);
    let count = 4; // Default count
    let targetStr = '';

    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '-n' && i + 1 < parts.length) {
        count = parseInt(parts[i + 1], 10) || 4;
        i++; // Skip the count value
      } else if (parts[i] === '-l' && i + 1 < parts.length) {
        i++; // Skip size value (not used in simulation)
      } else if (parts[i] === '-w' && i + 1 < parts.length) {
        i++; // Skip timeout value (not used in simulation)
      } else if (!parts[i].startsWith('-')) {
        targetStr = parts[i];
      }
    }

    if (!targetStr) {
      return `\nUsage: ping [-n count] [-l size] [-w timeout] target_name`;
    }

    // Validate IP address
    let targetIP: IPAddress;
    try {
      targetIP = new IPAddress(targetStr);
    } catch (error) {
      return `Ping request could not find host ${targetStr}. Please check the name and try again.`;
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

    for (let i = 0; i < count; i++) {
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
    output += `    Packets: Sent = ${count}, Received = ${successCount}, Lost = ${failCount} (${Math.round((failCount / count) * 100)}% loss),\n`;

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
    let destMAC = this.resolveMAC(nextHop);
    if (!destMAC) {
      // MAC not in cache - send ARP request
      this.sendARPRequest(nextHop);
      destMAC = this.resolveMAC(nextHop);
      if (!destMAC) {
        throw new Error('Destination host unreachable (ARP timeout)');
      }
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
    let destMAC = this.resolveMAC(nextHop);
    if (!destMAC) {
      // MAC not in cache - send ARP request
      this.sendARPRequest(nextHop);
      destMAC = this.resolveMAC(nextHop);
      if (!destMAC) {
        throw new Error('Destination host unreachable (ARP timeout)');
      }
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
   * Sends an ARP request for the given IP address
   */
  private sendARPRequest(targetIP: IPAddress): void {
    const nic = this.getInterface('eth0');
    if (!nic || !nic.getIPAddress()) {
      return;
    }

    const arpService = this.getARPService();
    const arpRequest = arpService.createRequest(
      nic.getIPAddress()!,
      nic.getMAC(),
      targetIP
    );

    // Serialize ARP packet
    const arpBytes = arpService.serializePacket(arpRequest);
    const paddedPayload = Buffer.concat([
      arpBytes,
      Buffer.alloc(Math.max(0, 46 - arpBytes.length))
    ]);

    // Create broadcast Ethernet frame for ARP request
    const frame = new EthernetFrame({
      sourceMAC: nic.getMAC(),
      destinationMAC: MACAddress.BROADCAST,
      etherType: EtherType.ARP,
      payload: paddedPayload
    });

    // Send frame (broadcast)
    this.sendFrame('eth0', frame);
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
