/**
 * LinuxPC - Linux workstation with terminal emulation
 *
 * Extends PC with Linux terminal capabilities:
 * - Command execution (bash-like)
 * - Linux-specific networking commands (ip, nmcli, ss, iptables, ufw)
 * - Service management (systemctl)
 * - File system simulation
 *
 * @example
 * ```typescript
 * const linux = new LinuxPC({ id: 'pc1', name: 'Ubuntu PC' });
 * linux.powerOn();
 *
 * const result = await linux.executeCommand('ip addr');
 * console.log(result);
 * ```
 */

import { PC } from './PC';
import { DeviceConfig, OSType } from './types';
import { IPAddress } from '../network/value-objects/IPAddress';
import { SubnetMask } from '../network/value-objects/SubnetMask';
import { MACAddress } from '../network/value-objects/MACAddress';
import { IPv4Packet } from '../network/entities/IPv4Packet';
import { EthernetFrame, EtherType } from '../network/entities/EthernetFrame';

/**
 * IPTables rule configuration
 */
interface IptablesRule {
  chain: string;
  table: string;
  protocol?: string;
  source?: string;
  destination?: string;
  dport?: string;
  sport?: string;
  target: string;
  lineNum: number;
}

/**
 * UFW rule configuration
 */
interface UfwRule {
  action: 'allow' | 'deny' | 'reject';
  direction: 'in' | 'out';
  port?: string;
  protocol?: string;
  from?: string;
  to?: string;
}

/**
 * Service configuration
 */
interface ServiceInfo {
  name: string;
  active: boolean;
  enabled: boolean;
  masked: boolean;
  failed: boolean;
  pid: number;
  memory: number; // in bytes
  startTime: Date | null;
  restarts: number;
  description: string;
  execStart: string;
  dependencies: string[];
}

/**
 * Journal log entry
 */
interface JournalEntry {
  timestamp: Date;
  priority: number; // 0-7 (emerg to debug)
  unit: string;
  message: string;
  pid?: number;
  hostname: string;
}

/**
 * Neighbor entry
 */
interface NeighborEntry {
  ip: string;
  mac: string;
  dev: string;
  state: 'REACHABLE' | 'STALE' | 'DELAY' | 'PERMANENT';
}

/**
 * Custom route entry
 */
interface RouteEntry {
  destination: string;
  via?: string;
  dev: string;
  metric?: number;
}

/**
 * LinuxPC - Linux workstation device
 */
export class LinuxPC extends PC {
  private commandHistory: string[];
  private ufwEnabled: boolean;
  private ufwRules: UfwRule[];
  private iptablesRules: IptablesRule[];
  private iptablesPolicy: Map<string, string>;
  private dnsServers: string[];
  private services: Map<string, ServiceInfo>;
  private customRoutes: RouteEntry[];
  private neighborEntries: NeighborEntry[];
  private nmConnections: Map<string, any>;
  private journalLogs: JournalEntry[];
  private bootId: number;

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

    // Initialize state variables
    this.ufwEnabled = false;
    this.ufwRules = [];
    this.iptablesRules = [];
    this.iptablesPolicy = new Map([
      ['INPUT', 'ACCEPT'],
      ['FORWARD', 'ACCEPT'],
      ['OUTPUT', 'ACCEPT']
    ]);
    this.dnsServers = ['8.8.8.8', '8.8.4.4'];
    this.services = new Map([
      ['NetworkManager', this.createService('NetworkManager', 'Network Manager', '/usr/sbin/NetworkManager --no-daemon', ['dbus.service'])],
      ['ssh', this.createService('ssh', 'OpenBSD Secure Shell server', '/usr/sbin/sshd -D', ['network.target'])],
      ['systemd-resolved', this.createService('systemd-resolved', 'Network Name Resolution', '/lib/systemd/systemd-resolved', ['systemd-networkd.service'])],
      ['nginx', this.createService('nginx', 'A high performance web server', '/usr/sbin/nginx -g "daemon off;"', ['network.target'], false)],
      ['apache2', this.createService('apache2', 'The Apache HTTP Server', '/usr/sbin/apache2ctl start', ['network.target'], false)],
      ['mysql', this.createService('mysql', 'MySQL Community Server', '/usr/sbin/mysqld', ['network.target'], false)],
      ['docker', this.createService('docker', 'Docker Application Container Engine', '/usr/bin/dockerd', ['network.target'], false)],
      ['cron', this.createService('cron', 'Regular background program processing daemon', '/usr/sbin/cron -f', [])],
    ]);
    this.customRoutes = [];
    this.neighborEntries = [];
    this.journalLogs = this.initializeJournalLogs();
    this.bootId = 0;
    this.nmConnections = new Map([
      ['Wired connection 1', {
        name: 'Wired connection 1',
        type: 'ethernet',
        device: 'eth0',
        active: true,
        ipv4: { method: 'auto', addresses: [], dns: [] }
      }]
    ]);

    // Power on if requested
    if (config.isPoweredOn !== false) {
      this.powerOn();
    }
  }

  /**
   * Creates a service with default values
   */
  private createService(name: string, description: string, execStart: string, dependencies: string[], active: boolean = true): ServiceInfo {
    return {
      name,
      active,
      enabled: active,
      masked: false,
      failed: false,
      pid: active ? Math.floor(Math.random() * 10000) + 1000 : 0,
      memory: active ? Math.floor(Math.random() * 50000000) + 1000000 : 0,
      startTime: active ? new Date() : null,
      restarts: 0,
      description,
      execStart,
      dependencies
    };
  }

  /**
   * Initializes journal logs with sample entries
   */
  private initializeJournalLogs(): JournalEntry[] {
    const now = new Date();
    const hostname = this.getHostname();
    const logs: JournalEntry[] = [];

    // Add some sample log entries
    const entries = [
      { offset: -3600000, priority: 6, unit: 'systemd', message: 'Started OpenBSD Secure Shell server.', pid: 1234 },
      { offset: -3500000, priority: 6, unit: 'ssh', message: 'Server listening on 0.0.0.0 port 22.', pid: 1234 },
      { offset: -3400000, priority: 6, unit: 'NetworkManager', message: 'NetworkManager state is now CONNECTED_GLOBAL', pid: 567 },
      { offset: -3300000, priority: 4, unit: 'kernel', message: 'Linux version 5.15.0-generic (buildd@lcy02-amd64-086) (gcc (Ubuntu 11.4.0-1ubuntu1) 11.4.0)' },
      { offset: -3200000, priority: 6, unit: 'systemd', message: 'Reached target Multi-User System.' },
      { offset: -3100000, priority: 6, unit: 'cron', message: 'Started Regular background program processing daemon.', pid: 890 },
      { offset: -3000000, priority: 5, unit: 'systemd-resolved', message: 'Using DNS server 8.8.8.8 for transaction', pid: 456 },
      { offset: -2900000, priority: 6, unit: 'systemd', message: 'boot sequence completed' },
    ];

    for (const entry of entries) {
      logs.push({
        timestamp: new Date(now.getTime() + entry.offset),
        priority: entry.priority,
        unit: entry.unit,
        message: entry.message,
        pid: entry.pid,
        hostname
      });
    }

    return logs;
  }

  /**
   * Adds a journal log entry
   */
  private addJournalLog(unit: string, message: string, priority: number = 6): void {
    this.journalLogs.push({
      timestamp: new Date(),
      priority,
      unit,
      message,
      hostname: this.getHostname()
    });
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
    const cmdLower = cmd.toLowerCase();

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

    // ip command
    if (cmdLower.startsWith('ip ') || cmdLower === 'ip') {
      return this.executeIpCommand(cmd);
    }

    // nmcli command
    if (cmdLower.startsWith('nmcli')) {
      return this.executeNmcliCommand(cmd);
    }

    // ss command
    if (cmdLower.startsWith('ss')) {
      return this.executeSsCommand(cmd);
    }

    // iptables command
    if (cmdLower.startsWith('iptables')) {
      return this.executeIptablesCommand(cmd);
    }

    // ufw command
    if (cmdLower.startsWith('ufw')) {
      return this.executeUfwCommand(cmd);
    }

    // systemctl command
    if (cmdLower.startsWith('systemctl')) {
      return this.executeSystemctlCommand(cmd);
    }

    // service command (legacy)
    if (cmdLower.startsWith('service ')) {
      return this.executeServiceCommand(cmd);
    }

    // journalctl command
    if (cmdLower.startsWith('journalctl')) {
      return this.executeJournalctlCommand(cmd);
    }

    // update-rc.d command
    if (cmdLower.startsWith('update-rc.d')) {
      return this.executeUpdateRcdCommand(cmd);
    }

    // chkconfig command (RHEL/CentOS)
    if (cmdLower.startsWith('chkconfig')) {
      return this.executeChkconfigCommand(cmd);
    }

    // hostnamectl command
    if (cmdLower.startsWith('hostnamectl')) {
      return this.executeHostnamectlCommand(cmd);
    }

    // netstat command
    if (cmdLower.startsWith('netstat')) {
      return this.executeNetstatCommand(cmd);
    }

    // resolvectl / systemd-resolve command
    if (cmdLower.startsWith('resolvectl') || cmdLower.startsWith('systemd-resolve')) {
      return this.executeResolvectlCommand(cmd);
    }

    // dig command
    if (cmdLower.startsWith('dig')) {
      return this.executeDigCommand(cmd);
    }

    // nslookup command
    if (cmdLower.startsWith('nslookup')) {
      return this.executeNslookupCommand(cmd);
    }

    // ethtool command
    if (cmdLower.startsWith('ethtool')) {
      return this.executeEthtoolCommand(cmd);
    }

    // Networking commands (legacy)
    if (cmd === 'ifconfig') {
      return this.getIfconfigOutput();
    }

    // ifconfig with arguments for IP configuration
    if (cmd.startsWith('ifconfig ')) {
      return this.executeIfconfigCommand(cmd);
    }

    if (cmd === 'route') {
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
   * Executes ip command
   */
  private executeIpCommand(cmd: string): string {
    const parts = cmd.split(/\s+/);
    const cmdLower = cmd.toLowerCase();

    // ip addr / ip a / ip address
    if (cmdLower === 'ip addr' || cmdLower === 'ip a' || cmdLower === 'ip address') {
      return this.getIpAddrOutput();
    }

    // ip addr show <interface>
    if (cmdLower.startsWith('ip addr show') || cmdLower.startsWith('ip address show')) {
      const iface = parts[parts.length - 1];
      if (iface === 'show' || iface === 'dev') {
        return this.getIpAddrOutput();
      }
      return this.getIpAddrOutput(iface !== 'dev' ? iface : undefined);
    }

    // ip addr add <ip>/<mask> dev <interface>
    if (cmdLower.startsWith('ip addr add')) {
      const ipMatch = cmd.match(/ip addr add\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)\s+dev\s+(\w+)/i);
      if (ipMatch) {
        try {
          const ip = new IPAddress(ipMatch[1]);
          const mask = new SubnetMask(`/${ipMatch[2]}`);
          const ifaceName = ipMatch[3];
          this.setIPAddress(ifaceName, ip, mask);
          return '';
        } catch (e) {
          return 'Error: Invalid IP address';
        }
      }
      return 'Error: Invalid arguments';
    }

    // ip addr del <ip>/<mask> dev <interface>
    if (cmdLower.startsWith('ip addr del')) {
      return '';
    }

    // ip link
    if (cmdLower === 'ip link') {
      return this.getIpLinkOutput();
    }

    // ip link show <interface>
    if (cmdLower.startsWith('ip link show')) {
      const iface = parts[parts.length - 1];
      if (iface === 'show') {
        return this.getIpLinkOutput();
      }
      return this.getIpLinkOutput(iface);
    }

    // ip link set <interface> up/down
    if (cmdLower.startsWith('ip link set')) {
      const ifaceMatch = cmd.match(/ip link set\s+(\w+)\s+(up|down)/i);
      if (ifaceMatch) {
        const iface = this.getInterface(ifaceMatch[1]);
        if (iface) {
          if (ifaceMatch[2].toLowerCase() === 'up') {
            iface.up();
          } else {
            iface.down();
          }
          return '';
        }
        return `Cannot find device "${ifaceMatch[1]}"`;
      }
      return 'Error: Invalid arguments';
    }

    // ip -s link
    if (cmdLower === 'ip -s link') {
      return this.getIpLinkStatsOutput();
    }

    // ip route / ip r / ip route show
    if (cmdLower === 'ip route' || cmdLower === 'ip r' || cmdLower === 'ip route show') {
      return this.getIpRouteOutput();
    }

    // ip route add
    if (cmdLower.startsWith('ip route add')) {
      const routeMatch = cmd.match(/ip route add\s+(\S+)\s+via\s+(\d+\.\d+\.\d+\.\d+)/i);
      if (routeMatch) {
        this.customRoutes.push({
          destination: routeMatch[1],
          via: routeMatch[2],
          dev: 'eth0'
        });
        return '';
      }
      return 'Error: Invalid arguments';
    }

    // ip route del
    if (cmdLower.startsWith('ip route del')) {
      return '';
    }

    // ip route get
    if (cmdLower.startsWith('ip route get')) {
      const destMatch = cmd.match(/ip route get\s+(\S+)/i);
      if (destMatch) {
        const gateway = this.getGateway();
        return `${destMatch[1]} via ${gateway?.toString() || '0.0.0.0'} dev eth0`;
      }
      return 'Error: Invalid arguments';
    }

    // ip neigh / ip neighbor / ip n
    if (cmdLower === 'ip neigh' || cmdLower === 'ip neighbor' || cmdLower === 'ip n') {
      return this.getIpNeighOutput();
    }

    // ip neigh add
    if (cmdLower.startsWith('ip neigh add')) {
      const neighMatch = cmd.match(/ip neigh add\s+(\d+\.\d+\.\d+\.\d+)\s+lladdr\s+(\S+)\s+dev\s+(\w+)/i);
      if (neighMatch) {
        this.neighborEntries.push({
          ip: neighMatch[1],
          mac: neighMatch[2],
          dev: neighMatch[3],
          state: 'PERMANENT'
        });
        return '';
      }
      return 'Error: Invalid arguments';
    }

    // ip neigh del
    if (cmdLower.startsWith('ip neigh del')) {
      return '';
    }

    // ip neigh flush
    if (cmdLower.startsWith('ip neigh flush')) {
      this.neighborEntries = [];
      return '';
    }

    // ip rule / ip rule show
    if (cmdLower === 'ip rule' || cmdLower === 'ip rule show') {
      return `0:      from all lookup local
32766:  from all lookup main
32767:  from all lookup default`;
    }

    return 'Error: Unknown ip subcommand. Usage: ip {addr|link|route|neigh|rule}';
  }

  /**
   * Returns ip addr output
   */
  private getIpAddrOutput(interfaceName?: string): string {
    let output = '';

    // Loopback interface
    if (!interfaceName || interfaceName === 'lo') {
      output += `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
    inet6 ::1/128 scope host
       valid_lft forever preferred_lft forever
`;
    }

    // Get all interfaces sorted by name
    const interfaces = this.getInterfaces().sort((a, b) => a.getName().localeCompare(b.getName()));

    let ifaceNum = 2;
    for (const iface of interfaces) {
      const ifaceName = iface.getName();
      if (!interfaceName || interfaceName === ifaceName) {
        const ip = iface.getIPAddress();
        const mask = iface.getSubnetMask();
        const mac = iface.getMAC();
        const isUp = iface.isUp();
        const state = isUp ? 'UP' : 'DOWN';
        const flags = isUp ? '<BROADCAST,MULTICAST,UP,LOWER_UP>' : '<BROADCAST,MULTICAST>';

        output += `${ifaceNum}: ${ifaceName}: ${flags} mtu 1500 qdisc fq_codel state ${state} group default qlen 1000
    link/ether ${mac.toString()} brd ff:ff:ff:ff:ff:ff`;

        if (ip && mask) {
          output += `
    inet ${ip.toString()}/${mask.getCIDR()} brd ${this.getBroadcast(ip, mask)} scope global ${ifaceName}
       valid_lft forever preferred_lft forever`;
        }
        output += '\n';
      }
      ifaceNum++;
    }

    // Check if requested interface exists
    if (interfaceName && interfaceName !== 'lo') {
      const exists = interfaces.some(i => i.getName() === interfaceName);
      if (!exists) {
        return `Device "${interfaceName}" does not exist.`;
      }
    }

    return output || 'No interfaces configured';
  }

  /**
   * Returns ip link output
   */
  private getIpLinkOutput(interfaceName?: string): string {
    let output = '';

    // Loopback interface
    if (!interfaceName || interfaceName === 'lo') {
      output += `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
`;
    }

    // Get all interfaces sorted by name
    const interfaces = this.getInterfaces().sort((a, b) => a.getName().localeCompare(b.getName()));

    let ifaceNum = 2;
    for (const iface of interfaces) {
      const ifaceName = iface.getName();
      if (!interfaceName || interfaceName === ifaceName) {
        const mac = iface.getMAC();
        const isUp = iface.isUp();
        const state = isUp ? 'UP' : 'DOWN';
        const flags = isUp ? '<BROADCAST,MULTICAST,UP,LOWER_UP>' : '<BROADCAST,MULTICAST>';

        output += `${ifaceNum}: ${ifaceName}: ${flags} mtu 1500 qdisc fq_codel state ${state} mode DEFAULT group default qlen 1000
    link/ether ${mac.toString()} brd ff:ff:ff:ff:ff:ff
`;
      }
      ifaceNum++;
    }

    return output || 'No interfaces configured';
  }

  /**
   * Returns ip link with statistics
   */
  private getIpLinkStatsOutput(): string {
    let output = '';

    // Loopback interface
    output += `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    RX: bytes  packets  errors  dropped overrun mcast
    0          0        0       0       0       0
    TX: bytes  packets  errors  dropped carrier collsns
    0          0        0       0       0       0
`;

    // Get all interfaces sorted by name
    const interfaces = this.getInterfaces().sort((a, b) => a.getName().localeCompare(b.getName()));

    let ifaceNum = 2;
    for (const iface of interfaces) {
      const ifaceName = iface.getName();
      const mac = iface.getMAC();
      const isUp = iface.isUp();
      const state = isUp ? 'UP' : 'DOWN';
      const flags = isUp ? '<BROADCAST,MULTICAST,UP,LOWER_UP>' : '<BROADCAST,MULTICAST>';
      const stats = iface.getStatistics();

      output += `${ifaceNum}: ${ifaceName}: ${flags} mtu 1500 qdisc fq_codel state ${state} mode DEFAULT group default qlen 1000
    link/ether ${mac.toString()} brd ff:ff:ff:ff:ff:ff
    RX: bytes  packets  errors  dropped overrun mcast
    ${stats.rxBytes}          ${stats.rxFrames}        ${stats.errors}       ${stats.droppedFrames}       0       0
    TX: bytes  packets  errors  dropped carrier collsns
    ${stats.txBytes}          ${stats.txFrames}        0       0       0       0
`;
      ifaceNum++;
    }

    return output;
  }

  /**
   * Returns ip route output
   */
  private getIpRouteOutput(): string {
    const gateway = this.getGateway();

    let output = '';

    if (gateway) {
      output += `default via ${gateway.toString()} dev eth0 proto static\n`;
    }

    // Show routes for all interfaces with IP addresses
    const interfaces = this.getInterfaces().sort((a, b) => a.getName().localeCompare(b.getName()));
    for (const iface of interfaces) {
      const ip = iface.getIPAddress();
      const mask = iface.getSubnetMask();
      if (ip && mask) {
        const network = this.getNetwork(ip, mask);
        output += `${network}/${mask.getCIDR()} dev ${iface.getName()} proto kernel scope link src ${ip.toString()}\n`;
      }
    }

    // Add custom routes
    for (const route of this.customRoutes) {
      output += `${route.destination} via ${route.via} dev ${route.dev}\n`;
    }

    return output || 'No routes configured';
  }

  /**
   * Returns ip neigh output
   */
  private getIpNeighOutput(): string {
    const entries = this.getARPTable();

    let output = '';

    for (const entry of entries) {
      output += `${entry.ip.toString()} dev eth0 lladdr ${entry.mac.toString()} REACHABLE\n`;
    }

    for (const entry of this.neighborEntries) {
      output += `${entry.ip} dev ${entry.dev} lladdr ${entry.mac} ${entry.state}\n`;
    }

    // If no entries, show a default gateway entry (simulated)
    if (!output) {
      const gateway = this.getGateway();
      if (gateway) {
        output = `${gateway.toString()} dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE\n`;
      } else {
        output = '192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff STALE\n';
      }
    }

    return output;
  }

  /**
   * Executes nmcli command
   */
  private executeNmcliCommand(cmd: string): string {
    const cmdLower = cmd.toLowerCase();
    const parts = cmd.split(/\s+/);

    // nmcli general / nmcli g
    if (cmdLower === 'nmcli general' || cmdLower === 'nmcli g') {
      return `STATE      CONNECTIVITY  WIFI-HW   WIFI      WWAN-HW   WWAN
connected  full          enabled   enabled   enabled   enabled`;
    }

    // nmcli general hostname
    if (cmdLower === 'nmcli general hostname') {
      return this.getHostname();
    }

    // nmcli device / nmcli d
    if (cmdLower === 'nmcli device' || cmdLower === 'nmcli d') {
      return `DEVICE  TYPE      STATE      CONNECTION
eth0    ethernet  connected  Wired connection 1
lo      loopback  unmanaged  --`;
    }

    // nmcli device status
    if (cmdLower === 'nmcli device status') {
      return `DEVICE  TYPE      STATE      CONNECTION
eth0    ethernet  connected  Wired connection 1
lo      loopback  unmanaged  --`;
    }

    // nmcli device show <interface>
    if (cmdLower.startsWith('nmcli device show')) {
      const iface = parts[parts.length - 1];
      if (iface === 'show') {
        return this.getNmcliDeviceShowOutput('eth0');
      }
      return this.getNmcliDeviceShowOutput(iface);
    }

    // nmcli device connect <interface>
    if (cmdLower.startsWith('nmcli device connect')) {
      const iface = parts[parts.length - 1];
      const netIface = this.getInterface(iface);
      if (netIface) {
        netIface.up();
        return `Device '${iface}' successfully activated.`;
      }
      return `Error: Device '${iface}' not found.`;
    }

    // nmcli device disconnect <interface>
    if (cmdLower.startsWith('nmcli device disconnect')) {
      const iface = parts[parts.length - 1];
      const netIface = this.getInterface(iface);
      if (netIface) {
        netIface.down();
        return `Device '${iface}' successfully disconnected.`;
      }
      return `Error: Device '${iface}' not found.`;
    }

    // nmcli device wifi list
    if (cmdLower === 'nmcli device wifi list') {
      return `IN-USE  BSSID              SSID         MODE   CHAN  RATE        SIGNAL  BARS  SECURITY
        00:11:22:33:44:55  Home-WiFi    Infra  6     54 Mbit/s  92      ▂▄▆█  WPA2
        AA:BB:CC:DD:EE:FF  Guest-WiFi   Infra  11    54 Mbit/s  65      ▂▄▆_  WPA2`;
    }

    // nmcli connection / nmcli c
    if (cmdLower === 'nmcli connection' || cmdLower === 'nmcli c') {
      return `NAME                UUID                                  TYPE      DEVICE
Wired connection 1  12345678-1234-1234-1234-123456789012  ethernet  eth0`;
    }

    // nmcli connection show "<name>"
    if (cmdLower.startsWith('nmcli connection show')) {
      return `connection.id:                          Wired connection 1
connection.uuid:                        12345678-1234-1234-1234-123456789012
connection.type:                        802-3-ethernet
connection.interface-name:              eth0`;
    }

    // nmcli connection modify
    if (cmdLower.startsWith('nmcli connection modify')) {
      return '';
    }

    // nmcli connection up
    if (cmdLower.startsWith('nmcli connection up')) {
      return 'Connection successfully activated.';
    }

    // nmcli connection down
    if (cmdLower.startsWith('nmcli connection down')) {
      return 'Connection successfully deactivated.';
    }

    return 'Error: Unknown nmcli subcommand';
  }

  /**
   * Returns nmcli device show output
   */
  private getNmcliDeviceShowOutput(ifaceName: string): string {
    const iface = this.getInterface(ifaceName);
    if (!iface) {
      return `Error: Device '${ifaceName}' not found.`;
    }

    const ip = iface.getIPAddress();
    const mask = iface.getSubnetMask();
    const mac = iface.getMAC();
    const gateway = this.getGateway();

    return `GENERAL.DEVICE:                         ${ifaceName}
GENERAL.TYPE:                           ethernet
GENERAL.HWADDR:                         ${mac.toString()}
GENERAL.MTU:                            1500
GENERAL.STATE:                          100 (connected)
GENERAL.CONNECTION:                     Wired connection 1
WIRED-PROPERTIES.CARRIER:               on
IP4.ADDRESS[1]:                         ${ip?.toString() || '(none)'}/${mask?.getCIDR() || '24'}
IP4.GATEWAY:                            ${gateway?.toString() || '(none)'}
IP4.DNS[1]:                             ${this.dnsServers[0] || '(none)'}`;
  }

  /**
   * Executes ss command
   */
  private executeSsCommand(cmd: string): string {
    const cmdLower = cmd.toLowerCase();

    // ss -s (summary)
    if (cmdLower === 'ss -s') {
      return `Total: 45
TCP:   10 (estab 2, closed 1, orphaned 0, timewait 0)

Transport Total     IP        IPv6
RAW       0         0         0
UDP       5         3         2
TCP       10        8         2
INET      15        11        4
FRAG      0         0         0`;
    }

    // Parse flags (handle combined flags like -tl, -tlnp, etc.)
    const flagStr = cmdLower.replace('ss', '').replace(/\s+/g, '');
    const flags = {
      listening: flagStr.includes('l'),
      tcp: flagStr.includes('t'),
      udp: flagStr.includes('u'),
      numeric: flagStr.includes('n'),
      all: flagStr.includes('a'),
      process: flagStr.includes('p')
    };

    let output = 'Netid  State      Recv-Q Send-Q Local Address:Port  Peer Address:Port\n';

    if (flags.tcp || !flags.udp) {
      if (flags.listening || flags.all) {
        output += 'tcp    LISTEN     0      128    0.0.0.0:22           0.0.0.0:*\n';
        output += 'tcp    LISTEN     0      128    0.0.0.0:80           0.0.0.0:*\n';
      }
      if (flags.all || (!flags.listening)) {
        output += 'tcp    ESTAB      0      0      192.168.1.10:22     192.168.1.100:54321\n';
      }
    }

    if (flags.udp || flags.all) {
      output += 'udp    UNCONN     0      0      0.0.0.0:68           0.0.0.0:*\n';
    }

    return output;
  }

  /**
   * Executes iptables command
   */
  private executeIptablesCommand(cmd: string): string {
    const cmdLower = cmd.toLowerCase();

    // iptables -t nat -L
    if (cmdLower.includes('-t nat') && cmdLower.includes('-l')) {
      return `Chain PREROUTING (policy ACCEPT)
target     prot opt source               destination

Chain INPUT (policy ACCEPT)
target     prot opt source               destination

Chain OUTPUT (policy ACCEPT)
target     prot opt source               destination

Chain POSTROUTING (policy ACCEPT)
target     prot opt source               destination`;
    }

    // iptables -L (with optional flags)
    if (cmdLower.includes('-l')) {
      const verbose = cmdLower.includes('-v');
      const lineNumbers = cmdLower.includes('--line-numbers');
      const chain = this.getIptablesChain(cmd);

      return this.getIptablesListOutput(chain, verbose, lineNumbers);
    }

    // iptables -A (append rule)
    if (cmdLower.includes('-a ')) {
      const ruleMatch = cmd.match(/-A\s+(\w+)\s+(.+)/i);
      if (ruleMatch) {
        const chain = ruleMatch[1];
        const ruleStr = ruleMatch[2];
        const rule = this.parseIptablesRule(chain, ruleStr);
        if (rule) {
          rule.lineNum = this.iptablesRules.filter(r => r.chain === chain).length + 1;
          this.iptablesRules.push(rule);
        }
      }
      return '';
    }

    // iptables -I (insert rule)
    if (cmdLower.includes('-i ')) {
      const ruleMatch = cmd.match(/-I\s+(\w+)\s+(\d+)\s+(.+)/i);
      if (ruleMatch) {
        const chain = ruleMatch[1];
        const ruleStr = ruleMatch[3];
        const rule = this.parseIptablesRule(chain, ruleStr);
        if (rule) {
          rule.lineNum = parseInt(ruleMatch[2]);
          this.iptablesRules.unshift(rule);
        }
      }
      return '';
    }

    // iptables -D (delete rule)
    if (cmdLower.includes('-d ')) {
      return '';
    }

    // iptables -F (flush)
    if (cmdLower.includes('-f')) {
      const chainMatch = cmd.match(/-F\s+(\w+)/i);
      if (chainMatch) {
        this.iptablesRules = this.iptablesRules.filter(r => r.chain !== chainMatch[1]);
      } else {
        this.iptablesRules = [];
      }
      return '';
    }

    // iptables -P (policy)
    if (cmdLower.includes('-p ')) {
      const policyMatch = cmd.match(/-P\s+(\w+)\s+(\w+)/i);
      if (policyMatch) {
        this.iptablesPolicy.set(policyMatch[1], policyMatch[2]);
      }
      return '';
    }

    return 'Error: Unknown iptables subcommand';
  }

  /**
   * Gets the chain from iptables command
   */
  private getIptablesChain(cmd: string): string | null {
    const chainMatch = cmd.match(/-L\s+(\w+)/i);
    return chainMatch ? chainMatch[1] : null;
  }

  /**
   * Returns iptables list output
   */
  private getIptablesListOutput(chain: string | null, verbose: boolean, lineNumbers: boolean): string {
    const chains = chain ? [chain] : ['INPUT', 'FORWARD', 'OUTPUT'];
    let output = '';

    for (const c of chains) {
      const policy = this.iptablesPolicy.get(c) || 'ACCEPT';
      output += `Chain ${c} (policy ${policy})\n`;

      if (verbose) {
        output += 'pkts bytes target     prot opt in     out     source               destination\n';
      } else if (lineNumbers) {
        output += 'num  target     prot opt source               destination\n';
      } else {
        output += 'target     prot opt source               destination\n';
      }

      const rules = this.iptablesRules.filter(r => r.chain === c);
      for (const rule of rules) {
        if (verbose) {
          output += `    0     0 ${rule.target.padEnd(10)} ${(rule.protocol || 'all').padEnd(4)} -- *      *       ${(rule.source || 'anywhere').padEnd(20)} ${rule.destination || 'anywhere'}`;
        } else if (lineNumbers) {
          output += `${rule.lineNum}    ${rule.target.padEnd(10)} ${(rule.protocol || 'all').padEnd(4)} -- ${(rule.source || 'anywhere').padEnd(20)} ${rule.destination || 'anywhere'}`;
        } else {
          output += `${rule.target.padEnd(10)} ${(rule.protocol || 'all').padEnd(4)} -- ${(rule.source || 'anywhere').padEnd(20)} ${rule.destination || 'anywhere'}`;
        }
        if (rule.dport) {
          output += ` dpt:${rule.dport}`;
        }
        output += '\n';
      }

      output += '\n';
    }

    return output;
  }

  /**
   * Parses iptables rule from command string
   */
  private parseIptablesRule(chain: string, ruleStr: string): IptablesRule | null {
    const rule: IptablesRule = {
      chain,
      table: 'filter',
      target: 'ACCEPT',
      lineNum: 0
    };

    // Parse protocol
    const protMatch = ruleStr.match(/-p\s+(\w+)/i);
    if (protMatch) {
      rule.protocol = protMatch[1];
    }

    // Parse source
    const srcMatch = ruleStr.match(/-s\s+(\S+)/i);
    if (srcMatch) {
      rule.source = srcMatch[1];
    }

    // Parse destination
    const dstMatch = ruleStr.match(/-d\s+(\S+)/i);
    if (dstMatch) {
      rule.destination = dstMatch[1];
    }

    // Parse destination port
    const dportMatch = ruleStr.match(/--dport\s+(\d+)/i);
    if (dportMatch) {
      rule.dport = dportMatch[1];
    }

    // Parse target
    const targetMatch = ruleStr.match(/-j\s+(\w+)/i);
    if (targetMatch) {
      rule.target = targetMatch[1];
    }

    return rule;
  }

  /**
   * Executes ufw command
   */
  private executeUfwCommand(cmd: string): string {
    const cmdLower = cmd.toLowerCase();
    const parts = cmd.split(/\s+/);

    // ufw status
    if (cmdLower === 'ufw status') {
      return this.ufwEnabled
        ? `Status: active\n\nTo                         Action      From\n--                         ------      ----\n` + this.getUfwRulesOutput()
        : 'Status: inactive';
    }

    // ufw status verbose
    if (cmdLower === 'ufw status verbose') {
      return `Status: ${this.ufwEnabled ? 'active' : 'inactive'}
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
` + this.getUfwRulesOutput();
    }

    // ufw status numbered
    if (cmdLower === 'ufw status numbered') {
      let output = `Status: ${this.ufwEnabled ? 'active' : 'inactive'}\n\n     To                         Action      From\n     --                         ------      ----\n`;
      if (this.ufwRules.length === 0) {
        output += '[ ] No rules configured\n';
      } else {
        this.ufwRules.forEach((rule, i) => {
          output += `[ ${i + 1}] ${this.formatUfwRule(rule)}\n`;
        });
      }
      return output;
    }

    // ufw enable
    if (cmdLower === 'ufw enable') {
      this.ufwEnabled = true;
      return 'Firewall is active and enabled on system startup';
    }

    // ufw disable
    if (cmdLower === 'ufw disable') {
      this.ufwEnabled = false;
      return 'Firewall stopped and disabled on system startup';
    }

    // ufw allow
    if (cmdLower.startsWith('ufw allow')) {
      const rule = this.parseUfwRule('allow', cmd);
      if (rule) {
        this.ufwRules.push(rule);
        return 'Rule added';
      }
      return 'Error: Invalid rule';
    }

    // ufw deny
    if (cmdLower.startsWith('ufw deny')) {
      const rule = this.parseUfwRule('deny', cmd);
      if (rule) {
        this.ufwRules.push(rule);
        return 'Rule added';
      }
      return 'Error: Invalid rule';
    }

    // ufw delete
    if (cmdLower.startsWith('ufw delete')) {
      const numMatch = cmd.match(/ufw delete\s+(\d+)/i);
      if (numMatch) {
        const index = parseInt(numMatch[1]) - 1;
        if (index >= 0 && index < this.ufwRules.length) {
          this.ufwRules.splice(index, 1);
          return 'Rule deleted';
        }
        return 'Rule not found';
      }
      // Delete by spec
      return 'Rule deleted';
    }

    // ufw reset
    if (cmdLower === 'ufw reset') {
      this.ufwEnabled = false;
      this.ufwRules = [];
      return 'Resetting all rules to installed defaults. Proceed with operation (y|n)? y\nFirewall reset to installation defaults';
    }

    // ufw default
    if (cmdLower.startsWith('ufw default')) {
      return 'Default incoming policy changed';
    }

    return 'Error: Unknown ufw subcommand';
  }

  /**
   * Gets ufw rules output
   */
  private getUfwRulesOutput(): string {
    let output = '';
    for (const rule of this.ufwRules) {
      output += this.formatUfwRule(rule) + '\n';
    }
    return output;
  }

  /**
   * Formats ufw rule for display
   */
  private formatUfwRule(rule: UfwRule): string {
    let to = rule.port || 'Anywhere';
    if (rule.protocol) {
      to += `/${rule.protocol}`;
    }
    const action = rule.action.toUpperCase();
    const from = rule.from || 'Anywhere';
    return `${to.padEnd(26)} ${action.padEnd(11)} ${from}`;
  }

  /**
   * Parses ufw rule from command
   */
  private parseUfwRule(action: 'allow' | 'deny' | 'reject', cmd: string): UfwRule | null {
    const rule: UfwRule = {
      action,
      direction: 'in'
    };

    // Parse "from" IP
    const fromMatch = cmd.match(/from\s+(\S+)/i);
    if (fromMatch) {
      rule.from = fromMatch[1];
    }

    // Parse "to" port
    const toPortMatch = cmd.match(/to any port\s+(\d+)/i);
    if (toPortMatch) {
      rule.port = toPortMatch[1];
    }

    // Parse direct port (e.g., "ufw allow 22")
    const portMatch = cmd.match(/ufw\s+\w+\s+(\d+)(\/(\w+))?/i);
    if (portMatch && !rule.port) {
      rule.port = portMatch[1];
      if (portMatch[3]) {
        rule.protocol = portMatch[3];
      }
    }

    // Parse service name
    const serviceMatch = cmd.match(/ufw\s+\w+\s+(ssh|http|https|ftp)/i);
    if (serviceMatch && !rule.port) {
      const serviceToPort: { [key: string]: string } = {
        ssh: '22',
        http: '80',
        https: '443',
        ftp: '21'
      };
      rule.port = serviceToPort[serviceMatch[1].toLowerCase()];
    }

    return rule;
  }

  /**
   * Executes systemctl command
   */
  private executeSystemctlCommand(cmd: string): string {
    const cmdLower = cmd.toLowerCase();
    const parts = cmd.split(/\s+/);

    // Get service name (handle --now flag and other options)
    const getServiceName = (): string => {
      const subcommands = ['status', 'start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask', 'is-active', 'is-enabled', 'is-failed', 'show', 'cat', 'kill', 'reload-or-restart', 'try-restart', 'reenable', 'edit', 'reset-failed', 'list-dependencies'];

      // Find the subcommand index
      let subcommandIndex = -1;
      for (let i = 0; i < parts.length; i++) {
        if (subcommands.includes(parts[i].toLowerCase())) {
          subcommandIndex = i;
          break;
        }
      }

      // Service name should be right after the subcommand, unless it's a flag
      if (subcommandIndex >= 0 && subcommandIndex < parts.length - 1) {
        for (let i = subcommandIndex + 1; i < parts.length; i++) {
          const part = parts[i];
          // Skip flags and their values
          if (part.startsWith('-')) {
            // Skip -p value as well
            if (part === '-p' && i + 1 < parts.length) {
              i++; // Skip the property value
            }
            continue;
          }
          // Skip property values (things like ActiveState, NRestarts etc when after -p)
          if (i > 0 && parts[i - 1] === '-p') {
            continue;
          }
          return part.toLowerCase().replace('.service', '');
        }
      }

      return '';
    };

    // systemctl status <service>
    if (cmdLower.startsWith('systemctl status')) {
      const service = getServiceName();
      if (!service) {
        return 'Error: Missing service name. Usage: systemctl status <service>';
      }
      // Case-insensitive service lookup
      const svc = this.getServiceByName(service);
      if (svc) {
        const activeState = svc.masked ? 'masked' : (svc.active ? 'active (running)' : 'inactive (dead)');
        const loadedState = svc.masked ? 'masked' : 'loaded';
        const sinceStr = svc.startTime ? `; ${this.formatTimeSince(svc.startTime)} ago` : '';
        return `● ${service}.service - ${svc.description}
     Loaded: ${loadedState} (/lib/systemd/system/${service}.service; ${svc.enabled ? 'enabled' : 'disabled'}; vendor preset: enabled)
     Active: ${activeState}${sinceStr}
   Main PID: ${svc.pid} (${service})
      Tasks: ${Math.floor(Math.random() * 10) + 1} (limit: 4915)
     Memory: ${this.formatBytes(svc.memory)}
        CPU: ${Math.floor(Math.random() * 100)}ms
     CGroup: /system.slice/${service}.service
             └─${svc.pid} ${svc.execStart}

systemd[1]: Started ${svc.description}.`;
      }
      return `● ${service}.service
     Loaded: not-found (Reason: No such file or directory)
     Active: inactive (dead)`;
    }

    // systemctl start <service>
    if (cmdLower.startsWith('systemctl start')) {
      const service = getServiceName();
      if (!service) {
        return 'Error: Missing service name. Usage: systemctl start <service>';
      }
      const svc = this.services.get(service);
      if (!svc) {
        return `Failed to start ${service}.service: Unit ${service}.service not found.`;
      }
      if (svc.masked) {
        return `Failed to start ${service}.service: Unit ${service}.service is masked.`;
      }
      svc.active = true;
      svc.pid = Math.floor(Math.random() * 10000) + 1000;
      svc.startTime = new Date();
      svc.memory = Math.floor(Math.random() * 50000000) + 1000000;
      this.addJournalLog(service, `Started ${svc.description}.`);
      return '';
    }

    // systemctl stop <service>
    if (cmdLower.startsWith('systemctl stop')) {
      const service = getServiceName();
      const svc = this.services.get(service);
      if (svc) {
        svc.active = false;
        svc.pid = 0;
        svc.startTime = null;
        svc.memory = 0;
        this.addJournalLog(service, `Stopped ${svc.description}.`);
      }
      return '';
    }

    // systemctl restart <service>
    if (cmdLower.startsWith('systemctl restart')) {
      const service = getServiceName();
      const svc = this.services.get(service);
      if (svc) {
        svc.active = true;
        svc.pid = Math.floor(Math.random() * 10000) + 1000;
        svc.startTime = new Date();
        svc.restarts++;
        this.addJournalLog(service, `Restarted ${svc.description}.`);
      }
      return '';
    }

    // systemctl reload <service>
    if (cmdLower.startsWith('systemctl reload ') && !cmdLower.includes('reload-or')) {
      const service = getServiceName();
      const svc = this.services.get(service);
      if (svc) {
        this.addJournalLog(service, `Reloading ${svc.description}...`);
      }
      return '';
    }

    // systemctl reload-or-restart <service>
    if (cmdLower.startsWith('systemctl reload-or-restart')) {
      const service = getServiceName();
      const svc = this.services.get(service);
      if (svc) {
        svc.active = true;
        svc.startTime = new Date();
        this.addJournalLog(service, `Reload-or-restart ${svc.description}.`);
      }
      return '';
    }

    // systemctl try-restart <service>
    if (cmdLower.startsWith('systemctl try-restart')) {
      const service = getServiceName();
      const svc = this.services.get(service);
      if (svc && svc.active) {
        svc.startTime = new Date();
        this.addJournalLog(service, `Try-restart ${svc.description}.`);
      }
      return '';
    }

    // systemctl enable <service>
    if (cmdLower.startsWith('systemctl enable')) {
      const service = getServiceName();
      if (!service) {
        return 'Error: Missing service name. Usage: systemctl enable <service>';
      }
      let svc = this.services.get(service);
      if (!svc) {
        svc = this.createService(service, service, `/usr/sbin/${service}`, []);
        this.services.set(service, svc);
      }
      svc.enabled = true;
      // Handle --now flag
      if (cmdLower.includes('--now')) {
        svc.active = true;
        svc.pid = Math.floor(Math.random() * 10000) + 1000;
        svc.startTime = new Date();
      }
      return `Service ${service} enabled. Created symlink /etc/systemd/system/multi-user.target.wants/${service}.service → /lib/systemd/system/${service}.service.`;
    }

    // systemctl disable <service>
    if (cmdLower.startsWith('systemctl disable')) {
      const service = getServiceName();
      const svc = this.services.get(service);
      if (svc) {
        svc.enabled = false;
        // Handle --now flag
        if (cmdLower.includes('--now')) {
          svc.active = false;
          svc.pid = 0;
          svc.startTime = null;
        }
      }
      return `Service ${service} disabled. Removed /etc/systemd/system/multi-user.target.wants/${service}.service.`;
    }

    // systemctl reenable <service>
    if (cmdLower.startsWith('systemctl reenable')) {
      const service = getServiceName();
      let svc = this.services.get(service);
      if (!svc) {
        svc = this.createService(service, service, `/usr/sbin/${service}`, []);
        this.services.set(service, svc);
      }
      svc.enabled = true;
      return `Service ${service} reenabled. Removed and recreated symlink.`;
    }

    // systemctl mask <service>
    if (cmdLower.startsWith('systemctl mask')) {
      const service = getServiceName();
      let svc = this.services.get(service);
      if (!svc) {
        svc = this.createService(service, service, `/usr/sbin/${service}`, []);
        this.services.set(service, svc);
      }
      svc.masked = true;
      svc.active = false;
      return `Created symlink /etc/systemd/system/${service}.service → /dev/null. Service ${service} masked.`;
    }

    // systemctl unmask <service>
    if (cmdLower.startsWith('systemctl unmask')) {
      const service = getServiceName();
      const svc = this.services.get(service);
      if (svc) {
        svc.masked = false;
      }
      return `Removed /etc/systemd/system/${service}.service. Service ${service} unmasked.`;
    }

    // systemctl is-active <service>
    if (cmdLower.startsWith('systemctl is-active')) {
      const service = getServiceName();
      const svc = this.services.get(service);
      return svc?.active ? 'active' : 'inactive';
    }

    // systemctl is-enabled <service>
    if (cmdLower.startsWith('systemctl is-enabled')) {
      const service = getServiceName();
      const svc = this.services.get(service);
      if (svc?.masked) return 'masked';
      return svc?.enabled ? 'enabled' : 'disabled';
    }

    // systemctl is-failed <service>
    if (cmdLower.startsWith('systemctl is-failed')) {
      const service = getServiceName();
      const svc = this.services.get(service);
      return svc?.failed ? 'failed' : 'active';
    }

    // systemctl show <service>
    if (cmdLower.startsWith('systemctl show')) {
      const service = getServiceName();
      const svc = this.services.get(service);
      if (!svc) {
        return `Unit ${service}.service could not be found.`;
      }

      // Check for -p flag (specific properties)
      const propMatch = cmd.match(/-p\s+(\S+)/i);
      if (propMatch) {
        const props = propMatch[1].split(',');
        let output = '';
        for (const prop of props) {
          output += this.getSystemctlProperty(svc, prop.trim()) + '\n';
        }
        return output.trim();
      }

      // Show all properties
      return `Id=${svc.name}.service
Names=${svc.name}.service
Description=${svc.description}
LoadState=loaded
ActiveState=${svc.active ? 'active' : 'inactive'}
SubState=${svc.active ? 'running' : 'dead'}
MainPID=${svc.pid}
ExecStart=${svc.execStart}
MemoryCurrent=${svc.memory}
NRestarts=${svc.restarts}
Enabled=${svc.enabled ? 'yes' : 'no'}
Masked=${svc.masked ? 'yes' : 'no'}`;
    }

    // systemctl cat <service>
    if (cmdLower.startsWith('systemctl cat')) {
      const service = getServiceName();
      const svc = this.services.get(service);
      if (!svc) {
        return `No files found for ${service}.service.`;
      }
      return `# /lib/systemd/system/${service}.service
[Unit]
Description=${svc.description}
After=network.target
${svc.dependencies.length > 0 ? `Requires=${svc.dependencies.join(' ')}\n` : ''}
[Service]
Type=simple
ExecStart=${svc.execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target`;
    }

    // systemctl list-units
    if (cmdLower.startsWith('systemctl list-units')) {
      const typeMatch = cmd.match(/--type=(\w+)/i);
      const stateMatch = cmd.match(/--state=(\w+)/i);
      const failed = cmdLower.includes('--failed');

      let output = 'UNIT                           LOAD   ACTIVE SUB       DESCRIPTION\n';
      this.services.forEach((svc) => {
        // Filter by type
        if (typeMatch && typeMatch[1] !== 'service') return;
        // Filter by state
        if (stateMatch) {
          if (stateMatch[1] === 'active' && !svc.active) return;
          if (stateMatch[1] === 'inactive' && svc.active) return;
        }
        // Filter failed
        if (failed && !svc.failed) return;

        output += `${svc.name}.service              loaded ${svc.active ? 'active  ' : 'inactive'} ${svc.active ? 'running' : 'dead   '} ${svc.description}\n`;
      });
      return output;
    }

    // systemctl list-unit-files
    if (cmdLower.startsWith('systemctl list-unit-files')) {
      const typeMatch = cmd.match(/--type=(\w+)/i);
      const stateMatch = cmd.match(/--state=(\w+)/i);

      let output = 'UNIT FILE                      STATE           VENDOR PRESET\n';
      this.services.forEach((svc) => {
        // Filter by type
        if (typeMatch && typeMatch[1] !== 'service') return;
        // Filter by state
        if (stateMatch) {
          if (stateMatch[1] === 'enabled' && !svc.enabled) return;
          if (stateMatch[1] === 'disabled' && svc.enabled) return;
        }

        const state = svc.masked ? 'masked  ' : (svc.enabled ? 'enabled ' : 'disabled');
        output += `${svc.name}.service              ${state} enabled\n`;
      });
      return output;
    }

    // systemctl daemon-reload
    if (cmdLower === 'systemctl daemon-reload') {
      return '';
    }

    // systemctl daemon-reexec
    if (cmdLower === 'systemctl daemon-reexec') {
      return '';
    }

    // systemctl list-dependencies
    if (cmdLower.startsWith('systemctl list-dependencies')) {
      const service = getServiceName();
      const svc = this.services.get(service);
      if (!svc) {
        return `${service}.service\n`;
      }
      let output = `${service}.service\n`;
      for (const dep of svc.dependencies) {
        output += `├─${dep}\n`;
      }
      output += `└─system.slice\n`;
      return output;
    }

    // systemctl edit
    if (cmdLower.startsWith('systemctl edit')) {
      const service = getServiceName();
      if (cmdLower.includes('--full')) {
        return `Editing full unit file for ${service}.service. Use your editor to modify.`;
      }
      return `Creating drop-in override file for ${service}.service.\nEdit /etc/systemd/system/${service}.service.d/override.conf`;
    }

    // systemctl kill
    if (cmdLower.startsWith('systemctl kill')) {
      const service = getServiceName();
      const svc = this.services.get(service);
      if (svc) {
        svc.active = false;
        svc.pid = 0;
        this.addJournalLog(service, `Killed ${svc.description}.`, 4);
      }
      return '';
    }

    // systemctl reset-failed
    if (cmdLower.startsWith('systemctl reset-failed')) {
      const service = getServiceName();
      if (service) {
        const svc = this.services.get(service);
        if (svc) {
          svc.failed = false;
        }
      } else {
        this.services.forEach(svc => { svc.failed = false; });
      }
      return '';
    }

    return 'Error: Unknown systemctl subcommand. Usage: systemctl [status|start|stop|restart|enable|disable|mask|unmask|show|cat] <service>';
  }

  /**
   * Gets a systemctl property value
   */
  private getSystemctlProperty(svc: ServiceInfo, prop: string): string {
    const propMap: { [key: string]: () => string } = {
      'ActiveState': () => `ActiveState=${svc.active ? 'active' : 'inactive'}`,
      'SubState': () => `SubState=${svc.active ? 'running' : 'dead'}`,
      'MainPID': () => `MainPID=${svc.pid}`,
      'MemoryCurrent': () => `MemoryCurrent=${svc.memory}`,
      'NRestarts': () => `NRestarts=${svc.restarts}`,
      'Description': () => `Description=${svc.description}`,
      'LoadState': () => `LoadState=loaded`,
      'ExecStart': () => `ExecStart=${svc.execStart}`,
    };
    return propMap[prop]?.() || `${prop}=`;
  }

  /**
   * Formats bytes to human readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0B';
    const k = 1024;
    const sizes = ['B', 'K', 'M', 'G'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
  }

  /**
   * Formats time since a date
   */
  private formatTimeSince(date: Date): string {
    const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)} days`;
  }

  /**
   * Gets service by name (case-insensitive lookup)
   */
  private getServiceByName(name: string): ServiceInfo | undefined {
    // Direct lookup first
    let svc = this.services.get(name);
    if (svc) return svc;

    // Case-insensitive lookup
    const nameLower = name.toLowerCase();
    for (const [key, value] of this.services) {
      if (key.toLowerCase() === nameLower) {
        return value;
      }
    }
    return undefined;
  }

  /**
   * Executes service command (legacy SysV init)
   */
  private executeServiceCommand(cmd: string): string {
    const parts = cmd.split(/\s+/);

    // service --status-all
    if (cmd.toLowerCase().includes('--status-all')) {
      let output = '';
      this.services.forEach((svc) => {
        const status = svc.active ? '+' : '-';
        output += ` [ ${status} ]  ${svc.name}\n`;
      });
      return output;
    }

    // service <name> <action>
    if (parts.length >= 3) {
      const service = parts[1].toLowerCase();
      const action = parts[2].toLowerCase();
      const svc = this.services.get(service);

      switch (action) {
        case 'status':
          if (svc) {
            return `● ${service} is ${svc.active ? 'running' : 'stopped'}`;
          }
          return `${service}: unrecognized service`;

        case 'start':
          if (svc) {
            svc.active = true;
            svc.pid = Math.floor(Math.random() * 10000) + 1000;
            svc.startTime = new Date();
            return `Starting ${service}: [ OK ]`;
          }
          return `${service}: unrecognized service`;

        case 'stop':
          if (svc) {
            svc.active = false;
            svc.pid = 0;
            return `Stopping ${service}: [ OK ]`;
          }
          return `${service}: unrecognized service`;

        case 'restart':
          if (svc) {
            svc.active = true;
            svc.pid = Math.floor(Math.random() * 10000) + 1000;
            svc.startTime = new Date();
            svc.restarts++;
            return `Restarting ${service}: [ OK ]`;
          }
          return `${service}: unrecognized service`;

        case 'reload':
        case 'force-reload':
          if (svc) {
            return `Reloading ${service} configuration: [ OK ]`;
          }
          return `${service}: unrecognized service`;
      }
    }

    return 'Usage: service <service> {start|stop|restart|reload|status}';
  }

  /**
   * Executes journalctl command
   */
  private executeJournalctlCommand(cmd: string): string {
    const cmdLower = cmd.toLowerCase();

    // journalctl -f (follow)
    if (cmdLower.includes('-f') && !cmdLower.includes('-files')) {
      return 'Following journal logs... (Press Ctrl+C to stop)';
    }

    // journalctl --disk-usage
    if (cmdLower.includes('--disk-usage')) {
      return 'Archived and active journals take up 48.0M in the file system.';
    }

    // journalctl --vacuum-size
    if (cmdLower.includes('--vacuum-size')) {
      return 'Vacuuming done, freed 0B of archived journals from /var/log/journal.';
    }

    // journalctl --vacuum-time
    if (cmdLower.includes('--vacuum-time')) {
      return 'Vacuuming done, freed 0B of archived journals from /var/log/journal.';
    }

    // journalctl --list-boots
    if (cmdLower.includes('--list-boots')) {
      return ` 0 abc123 ${new Date().toISOString()} - ${new Date().toISOString()}
-1 def456 ${new Date(Date.now() - 86400000).toISOString()} - ${new Date(Date.now() - 86400000).toISOString()}`;
    }

    // Parse filters
    const unitMatch = cmd.match(/(?:-u|--unit=?)[\s=]?(\S+)/i);
    const priorityMatch = cmd.match(/-p\s+(\S+)/i);
    const bootFlag = cmdLower.includes('-b');
    const kernelFlag = cmdLower.includes('-k') || cmdLower.includes('--dmesg');
    const reverseFlag = cmdLower.includes('-r');
    const nMatch = cmd.match(/-n\s+(\d+)/i);
    const grepMatch = cmd.match(/(?:-g|--grep=?)[\s=]?"?([^"]+)"?/i);

    // Filter logs
    let logs = [...this.journalLogs];

    if (unitMatch) {
      const unit = unitMatch[1].replace('.service', '');
      logs = logs.filter(l => l.unit.toLowerCase().includes(unit.toLowerCase()));
    }

    if (kernelFlag) {
      logs = logs.filter(l => l.unit === 'kernel');
    }

    if (priorityMatch) {
      const prio = this.parsePriority(priorityMatch[1]);
      logs = logs.filter(l => l.priority <= prio);
    }

    if (grepMatch) {
      const pattern = new RegExp(grepMatch[1], 'i');
      logs = logs.filter(l => pattern.test(l.message));
    }

    if (reverseFlag) {
      logs = logs.reverse();
    }

    if (nMatch) {
      logs = logs.slice(-parseInt(nMatch[1]));
    }

    // Output format
    const outputFormat = this.getJournalOutputFormat(cmd);

    if (bootFlag) {
      return this.formatJournalLogs(logs, outputFormat, true);
    }

    return this.formatJournalLogs(logs, outputFormat, false);
  }

  /**
   * Parses priority level
   */
  private parsePriority(prio: string): number {
    const priorities: { [key: string]: number } = {
      'emerg': 0, '0': 0,
      'alert': 1, '1': 1,
      'crit': 2, '2': 2,
      'err': 3, 'error': 3, '3': 3,
      'warning': 4, 'warn': 4, '4': 4,
      'notice': 5, '5': 5,
      'info': 6, '6': 6,
      'debug': 7, '7': 7,
    };
    return priorities[prio.toLowerCase()] ?? 6;
  }

  /**
   * Gets journal output format from command
   */
  private getJournalOutputFormat(cmd: string): string {
    const match = cmd.match(/-o\s+(\w+)/i);
    return match ? match[1] : 'short';
  }

  /**
   * Formats journal logs
   */
  private formatJournalLogs(logs: JournalEntry[], format: string, showBootMessage: boolean): string {
    let output = '';

    if (showBootMessage) {
      output = '-- boot abc123 --\n';
    }

    if (format === 'json') {
      const jsonLogs = logs.map(l => ({
        MESSAGE: l.message,
        _HOSTNAME: l.hostname,
        SYSLOG_IDENTIFIER: l.unit,
        PRIORITY: l.priority
      }));
      return JSON.stringify(jsonLogs, null, 2);
    }

    if (format === 'verbose') {
      for (const log of logs) {
        output += `${log.timestamp.toISOString()} ${log.hostname}\n`;
        output += `    _HOSTNAME=${log.hostname}\n`;
        output += `    SYSLOG_IDENTIFIER=${log.unit}\n`;
        output += `    PRIORITY=${log.priority}\n`;
        output += `    MESSAGE=${log.message}\n\n`;
      }
      return output;
    }

    // Default short format
    for (const log of logs) {
      const time = log.timestamp.toLocaleString('en-US', {
        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      output += `${time} ${log.hostname} ${log.unit}${log.pid ? `[${log.pid}]` : ''}: ${log.message}\n`;
    }

    return output || 'No journal entries found.';
  }

  /**
   * Executes update-rc.d command
   */
  private executeUpdateRcdCommand(cmd: string): string {
    const parts = cmd.split(/\s+/);

    // update-rc.d -f <service> remove
    if (cmd.toLowerCase().includes('remove')) {
      const service = parts.find(p => !p.startsWith('-') && p !== 'update-rc.d' && p !== 'remove');
      if (service) {
        return `Startup links for ${service} deleted and removed.`;
      }
    }

    // update-rc.d <service> defaults
    if (cmd.toLowerCase().includes('defaults')) {
      const service = parts.find(p => !p.startsWith('-') && p !== 'update-rc.d' && p !== 'defaults');
      if (service) {
        const svc = this.services.get(service);
        if (svc) {
          svc.enabled = true;
        }
        return `Adding system startup symlink for ${service}. Service enabled.`;
      }
    }

    // update-rc.d <service> disable
    if (cmd.toLowerCase().includes('disable')) {
      const service = parts.find(p => !p.startsWith('-') && p !== 'update-rc.d' && p !== 'disable');
      if (service) {
        const svc = this.getServiceByName(service);
        if (svc) {
          svc.enabled = false;
        }
        return `System startup disable for ${service}. Links removed.`;
      }
    }

    return 'Usage: update-rc.d <service> defaults|disable|remove';
  }

  /**
   * Executes chkconfig command (RHEL/CentOS)
   */
  private executeChkconfigCommand(cmd: string): string {
    const cmdLower = cmd.toLowerCase();
    const parts = cmd.split(/\s+/);

    // chkconfig --list
    if (cmdLower.includes('--list')) {
      let output = '';
      this.services.forEach((svc) => {
        output += `${svc.name}\t0:off\t1:off\t2:${svc.enabled ? 'on' : 'off'}\t3:${svc.enabled ? 'on' : 'off'}\t4:${svc.enabled ? 'on' : 'off'}\t5:${svc.enabled ? 'on' : 'off'}\t6:off\n`;
      });
      return output;
    }

    // chkconfig <service> on/off
    if (parts.length >= 3) {
      const service = parts[1];
      const state = parts[2].toLowerCase();
      const svc = this.services.get(service);
      if (svc) {
        svc.enabled = state === 'on';
      }
      return '';
    }

    return '';
  }

  /**
   * Executes hostnamectl command
   */
  private executeHostnamectlCommand(cmd: string): string {
    const cmdLower = cmd.toLowerCase();
    const parts = cmd.split(/\s+/);

    // hostnamectl / hostnamectl status
    if (cmdLower === 'hostnamectl' || cmdLower === 'hostnamectl status') {
      return `   Static hostname: ${this.getHostname()}
         Icon name: computer-vm
           Chassis: vm
        Machine ID: 1234567890abcdef1234567890abcdef
           Boot ID: abcdef1234567890abcdef1234567890
    Virtualization: kvm
  Operating System: Ubuntu 22.04.3 LTS
            Kernel: Linux 5.15.0-generic
      Architecture: x86-64`;
    }

    // hostnamectl set-hostname <name>
    if (cmdLower.startsWith('hostnamectl set-hostname')) {
      const newHostname = parts[parts.length - 1];
      if (newHostname && newHostname !== 'set-hostname') {
        this.setHostname(newHostname);
        return '';
      }
      return 'Error: Missing hostname';
    }

    return 'Error: Unknown hostnamectl subcommand';
  }

  /**
   * Executes netstat command
   */
  private executeNetstatCommand(cmd: string): string {
    const cmdLower = cmd.toLowerCase();

    // netstat -r (routing)
    if (cmdLower.includes('-r')) {
      return `Kernel IP routing table
Destination     Gateway         Genmask         Flags   MSS Window  irtt Iface
default         ${this.getGateway()?.toString() || '0.0.0.0'}     0.0.0.0         UG        0 0          0 eth0`;
    }

    // netstat -i (interfaces)
    if (cmdLower.includes('-i')) {
      return `Kernel Interface table
Iface      MTU    RX-OK RX-ERR RX-DRP RX-OVR    TX-OK TX-ERR TX-DRP TX-OVR Flg
eth0      1500        0      0      0 0             0      0      0      0 BMRU
lo       65536        0      0      0 0             0      0      0      0 LRU`;
    }

    // netstat -s (statistics)
    if (cmdLower.includes('-s')) {
      return `Ip:
    0 total packets received
    0 forwarded
    0 incoming packets discarded
Icmp:
    0 ICMP messages received
    0 ICMP messages sent
Tcp:
    0 active connections openings
    0 passive connection openings
Udp:
    0 packets received
    0 packets sent`;
    }

    // netstat -a, -l, -t
    let output = 'Proto Recv-Q Send-Q Local Address           Foreign Address         State\n';

    const listening = cmdLower.includes('-l');
    const tcp = cmdLower.includes('-t') || !cmdLower.includes('-u');

    if (tcp) {
      if (listening || cmdLower.includes('-a')) {
        output += 'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN\n';
        output += 'tcp        0      0 0.0.0.0:80              0.0.0.0:*               LISTEN\n';
      }
      // Show established connections for -t alone or -a
      if (cmdLower.includes('-a') || cmdLower.includes('-t')) {
        output += 'tcp        0      0 192.168.1.10:22         192.168.1.100:54321     ESTABLISHED\n';
      }
    }

    return output;
  }

  /**
   * Executes resolvectl command
   */
  private executeResolvectlCommand(cmd: string): string {
    const cmdLower = cmd.toLowerCase();

    // resolvectl status / systemd-resolve --status
    if (cmdLower.includes('status')) {
      return `Global
       Protocols: +LLMNR +mDNS -DNSOverTLS DNSSEC=no/unsupported
resolv.conf mode: stub

Link 2 (eth0)
    Current Scopes: DNS
         Protocols: +DefaultRoute +LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported
Current DNS Server: ${this.dnsServers[0]}
       DNS Servers: ${this.dnsServers.join(' ')}`;
    }

    // resolvectl query <domain>
    if (cmdLower.includes('query')) {
      const domain = cmd.split(/\s+/).pop() || 'unknown';
      return `${domain}: 142.250.185.78 -- link: eth0

-- Information acquired via protocol DNS in 12.5ms.
-- Data is authenticated: no`;
    }

    return 'Error: Unknown resolvectl subcommand';
  }

  /**
   * Executes dig command
   */
  private executeDigCommand(cmd: string): string {
    const parts = cmd.split(/\s+/);
    const domain = parts[1] || 'localhost';

    return `; <<>> DiG 9.18.12-1ubuntu1 <<>> ${domain}
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 12345
;; flags: qr rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 65494
;; QUESTION SECTION:
;${domain}.                     IN      A

;; ANSWER SECTION:
${domain}.              300     IN      A       142.250.185.78

;; Query time: 15 msec
;; SERVER: ${this.dnsServers[0]}#53(${this.dnsServers[0]})
;; WHEN: Mon Jan 27 12:00:00 UTC 2026
;; MSG SIZE  rcvd: 59`;
  }

  /**
   * Executes nslookup command
   */
  private executeNslookupCommand(cmd: string): string {
    const parts = cmd.split(/\s+/);
    const domain = parts[1] || 'localhost';

    return `Server:         ${this.dnsServers[0]}
Address:        ${this.dnsServers[0]}#53

Non-authoritative answer:
Name:   ${domain}
Address: 142.250.185.78`;
  }

  /**
   * Executes ethtool command
   */
  private executeEthtoolCommand(cmd: string): string {
    const cmdLower = cmd.toLowerCase();
    const parts = cmd.split(/\s+/);
    const iface = parts[parts.length - 1];

    // ethtool -i <interface> (driver info)
    if (cmdLower.includes('-i')) {
      return `driver: e1000
version: 5.15.0-generic
firmware-version:
expansion-rom-version:
bus-info: 0000:00:03.0
supports-statistics: yes
supports-test: yes
supports-eeprom-access: yes
supports-register-dump: yes
supports-priv-flags: no`;
    }

    // ethtool -S <interface> (statistics)
    if (cmdLower.includes('-s')) {
      return `NIC statistics:
     rx_packets: 0
     tx_packets: 0
     rx_bytes: 0
     tx_bytes: 0
     rx_errors: 0
     tx_errors: 0`;
    }

    // ethtool <interface>
    return `Settings for ${iface}:
        Supported ports: [ TP ]
        Supported link modes:   10baseT/Half 10baseT/Full
                                100baseT/Half 100baseT/Full
                                1000baseT/Full
        Supported pause frame use: No
        Supports auto-negotiation: Yes
        Supported FEC modes: Not reported
        Advertised link modes:  10baseT/Half 10baseT/Full
                                100baseT/Half 100baseT/Full
                                1000baseT/Full
        Advertised pause frame use: No
        Advertised auto-negotiation: Yes
        Advertised FEC modes: Not reported
        Speed: 1000Mb/s
        Duplex: Full
        Auto-negotiation: on
        Port: Twisted Pair
        PHYAD: 0
        Transceiver: internal
        MDI-X: off (auto)
        Supports Wake-on: d
        Wake-on: d
        Current message level: 0x00000007 (7)
                               drv probe link
        Link detected: yes`;
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
   * Supports: ping [-c count] <target>
   */
  private executePing(args: string): string {
    // Parse ping options
    const parts = args.split(/\s+/).filter(p => p);
    let count = 4; // Default packet count
    let targetStr = '';

    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '-c' && i + 1 < parts.length) {
        count = parseInt(parts[i + 1], 10) || 4;
        i++; // Skip the count value
      } else if (parts[i] === '-n' && i + 1 < parts.length) {
        // Some Linux systems also use -n for count
        count = parseInt(parts[i + 1], 10) || 4;
        i++;
      } else if (!parts[i].startsWith('-')) {
        targetStr = parts[i];
      }
    }

    if (!targetStr) {
      return 'ping: usage error: Destination address required';
    }

    // Validate and parse target IP
    try {
      const targetIP = new IPAddress(targetStr);

      // Check if device is powered on
      if (!this.isOnline()) {
        return 'Network is unreachable';
      }

      // Get our IP and check configuration
      const nic = this.getInterface('eth0');
      if (!nic || !nic.getIPAddress()) {
        return 'Network interface not configured';
      }

      // Send ping with specified count
      const result = this.sendPing(targetIP, count);
      return result;
    } catch (error) {
      return `ping: ${targetStr}: Name or service not known`;
    }
  }

  /**
   * Sends ping to target
   * Simplified synchronous version for terminal simulation
   *
   * @param targetIP - Target IP address
   * @param count - Number of packets to send (default 4)
   */
  private sendPing(targetIP: IPAddress, count: number = 4): string {
    const nic = this.getInterface('eth0');
    if (!nic) {
      return 'Network interface error';
    }

    const icmpService = this.getICMPService();
    let output = `PING ${targetIP.toString()} (${targetIP.toString()}) 56(84) bytes of data.\n`;

    let successCount = 0;
    let failCount = 0;
    const rtts: number[] = [];

    for (let i = 0; i < count; i++) {
      // Create Echo Request
      const data = Buffer.alloc(56); // Standard ping data size
      data.write(`Ping data ${i}`, 0);

      const request = icmpService.createEchoRequest(targetIP, data, 1000); // 1 second timeout

      // Send the ICMP packet
      try {
        this.sendICMPRequest(targetIP, request);

        // Simulate reply (in real implementation would wait for actual reply)
        // For now, indicate packet was sent
        const rtt = Math.random() * 5 + 0.5; // Simulated RTT between 0.5ms and 5.5ms
        rtts.push(rtt);
        output += `64 bytes from ${targetIP.toString()}: icmp_seq=${i + 1} ttl=64 time=${rtt.toFixed(2)} ms\n`;
        successCount++;
      } catch (error) {
        output += `Request timeout for icmp_seq ${i + 1}\n`;
        failCount++;
      }
    }

    // Statistics
    output += `\n--- ${targetIP.toString()} ping statistics ---\n`;
    output += `${count} packets transmitted, ${successCount} received, ${failCount > 0 ? ((failCount / count) * 100).toFixed(0) : '0'}% packet loss\n`;

    if (rtts.length > 0) {
      const min = Math.min(...rtts);
      const max = Math.max(...rtts);
      const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
      const mdev = Math.sqrt(rtts.reduce((sum, rtt) => sum + Math.pow(rtt - avg, 2), 0) / rtts.length);
      output += `rtt min/avg/max/mdev = ${min.toFixed(3)}/${avg.toFixed(3)}/${max.toFixed(3)}/${mdev.toFixed(3)} ms\n`;
    }

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
    let destMAC = this.resolveMAC(nextHop);
    if (!destMAC) {
      // MAC not in cache - send ARP request
      this.sendARPRequest(nextHop);
      // Try to resolve again after ARP (for synchronous simulation)
      destMAC = this.resolveMAC(nextHop);
      if (!destMAC) {
        // In a real async implementation, we would queue the packet and wait
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
    let destMAC = this.resolveMAC(nextHop);
    if (!destMAC) {
      // MAC not in cache - send ARP request
      this.sendARPRequest(nextHop);
      // Try to resolve again after ARP
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
