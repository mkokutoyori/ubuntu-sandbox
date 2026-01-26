/**
 * CiscoRouter - Cisco IOS router with realistic terminal emulation
 *
 * Features:
 * - Realistic boot sequence
 * - MOTD, Login, Exec banners
 * - Configuration modes (user, privileged, config, interface, line, router)
 * - Enable secret/password authentication
 * - Common IOS commands (ping, traceroute, show, write, clock, etc.)
 * - Interface IP configuration
 * - Static routing
 *
 * @example
 * ```typescript
 * const router = new CiscoRouter({ id: 'r1', name: 'Router 1', hostname: 'R1' });
 * router.powerOn();
 *
 * await router.executeCommand('enable');
 * await router.executeCommand('configure terminal');
 * await router.executeCommand('interface GigabitEthernet0/0');
 * await router.executeCommand('ip address 192.168.1.1 255.255.255.0');
 * await router.executeCommand('no shutdown');
 * ```
 */

import { Router } from './Router';
import { DeviceConfig, OSType } from './types';
import { IPAddress } from '../network/value-objects/IPAddress';
import { SubnetMask } from '../network/value-objects/SubnetMask';

/**
 * Configuration mode
 */
type ConfigMode = 'user' | 'privileged' | 'config' | 'interface' | 'line' | 'router';

/**
 * Banner types
 */
type BannerType = 'motd' | 'login' | 'exec';

/**
 * CiscoRouter - Cisco IOS router device
 */
export class CiscoRouter extends Router {
  private commandHistory: string[];
  private configMode: ConfigMode;
  private enablePassword: string;
  private enableSecret: string;
  private isEnabled: boolean;
  private awaitingPassword: boolean;
  private banners: Map<BannerType, string>;
  private currentInterface: string;
  private currentLine: string;
  private clock: Date;

  constructor(config: DeviceConfig) {
    const id = config.id || `cisco-router-${Date.now()}`;
    const name = config.name || id;

    // Cisco routers typically have 4 interfaces
    super(id, name, 4);

    (this as any).type = 'cisco-router';

    if (config.hostname) {
      this.setHostname(config.hostname);
    } else {
      this.setHostname('Router');
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
    this.banners = new Map();
    this.currentInterface = '';
    this.currentLine = '';
    this.clock = new Date();

    if (config.isPoweredOn !== false) {
      this.powerOn();
    }
  }

  public getOSType(): OSType {
    return 'cisco-ios';
  }

  /**
   * Returns realistic Cisco IOS boot sequence
   */
  public getBootSequence(): string {
    return `
System Bootstrap, Version 15.1(4)M4, RELEASE SOFTWARE (fc1)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 2010 by cisco Systems, Inc.

Initializing memory for ECC

BOOTLDR: C2900 Boot Loader (C2900-HBOOT-M) Version 15.0(1r)M15, RELEASE SOFTWARE (fc1)

           cisco Systems, Inc.
           170 West Tasman Drive
           San Jose, California 95134-1706

Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.1(4)M4, RELEASE SOFTWARE (fc1)
Copyright (c) 1986-2012 by Cisco Systems, Inc.

cisco C2911 (revision 1.0) processor with 491520K/32768K bytes of memory.
Processor board ID FTX152400KS
3 Gigabit Ethernet interfaces
255K bytes of non-volatile configuration memory.
249856K bytes of ATA System CompactFlash 0 (Read/Write)

Press RETURN to get started!
`;
  }

  public setBanner(type: BannerType, message: string): void {
    this.banners.set(type, message);
  }

  public getBanner(type: BannerType): string {
    return this.banners.get(type) || '';
  }

  public setEnableSecret(secret: string): void {
    this.enableSecret = secret;
  }

  public setEnablePassword(password: string): void {
    this.enablePassword = password;
  }

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

    if (this.configMode === 'interface') {
      return this.executeInterfaceCommand(cmd);
    }

    if (this.configMode === 'line') {
      return this.executeLineCommand(cmd);
    }

    if (this.configMode === 'router') {
      return this.executeRouterCommand(cmd);
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

    if (cmd === 'show version') {
      return this.getVersionOutput();
    }

    return `% Invalid input detected at '^' marker.\n`;
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

    if (cmd.startsWith('ping ')) {
      return this.executePingCommand(cmd);
    }

    if (cmd.startsWith('traceroute ') || cmd.startsWith('tracert ')) {
      return this.executeTracerouteCommand(cmd);
    }

    if (cmd === 'write memory' || cmd === 'write' || cmd === 'wr') {
      return `Building configuration...\n[OK]`;
    }

    if (cmd === 'copy running-config startup-config' || cmd === 'copy run start') {
      return `Destination filename [startup-config]?\nBuilding configuration...\n[OK]`;
    }

    if (cmd === 'show clock') {
      return this.getClockOutput();
    }

    if (cmd.startsWith('clock set ')) {
      return '';
    }

    if (cmd === 'reload') {
      return 'Proceed with reload? [confirm]';
    }

    if (cmd === '?') {
      return this.getPrivilegedModeHelp();
    }

    if (cmd === 'show ?' || cmd.endsWith(' ?')) {
      return this.getContextHelp(cmd.replace('?', '').trim());
    }

    return `% Invalid input detected at '^' marker.\n`;
  }

  private executeConfigCommand(cmd: string): string {
    if (cmd === 'end' || cmd === 'exit') {
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

    if (cmd === 'no hostname') {
      this.setHostname('Router');
      return '';
    }

    if (cmd.startsWith('interface ') || cmd.startsWith('int ')) {
      const parts = cmd.split(/\s+/);
      this.currentInterface = parts.slice(1).join('');
      this.configMode = 'interface';
      return '';
    }

    if (cmd.startsWith('line ')) {
      this.currentLine = cmd.substring(5);
      this.configMode = 'line';
      return '';
    }

    if (cmd.startsWith('router ')) {
      this.configMode = 'router';
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

    if (cmd.startsWith('banner motd ')) {
      const delimiter = cmd.charAt(12);
      const message = cmd.substring(13, cmd.lastIndexOf(delimiter));
      this.banners.set('motd', message);
      return '';
    }

    if (cmd.startsWith('banner login ')) {
      const delimiter = cmd.charAt(13);
      const message = cmd.substring(14, cmd.lastIndexOf(delimiter));
      this.banners.set('login', message);
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

    if (cmd.startsWith('ip address ')) {
      const parts = cmd.substring(11).split(/\s+/);
      if (parts.length >= 2) {
        try {
          const ip = new IPAddress(parts[0]);
          const mask = new SubnetMask(parts[1]);

          const ifaceName = this.convertCiscoInterfaceToInternal(this.currentInterface);
          const iface = this.getInterface(ifaceName);
          if (iface) {
            this.setIPAddress(ifaceName, ip, mask);
          }
        } catch (e) {
          return '% Invalid input';
        }
      }
      return '';
    }

    if (cmd === 'no shutdown' || cmd === 'no shut') {
      const ifaceName = this.convertCiscoInterfaceToInternal(this.currentInterface);
      const iface = this.getInterface(ifaceName);
      if (iface) {
        iface.up();
      }
      return `%LINK-5-CHANGED: Interface ${this.currentInterface}, changed state to up`;
    }

    if (cmd === 'shutdown') {
      const ifaceName = this.convertCiscoInterfaceToInternal(this.currentInterface);
      const iface = this.getInterface(ifaceName);
      if (iface) {
        iface.down();
      }
      return `%LINK-5-CHANGED: Interface ${this.currentInterface}, changed state to administratively down`;
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

  private executeRouterCommand(cmd: string): string {
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

    if (cmd === 'show ip interface brief' || cmd === 'sh ip int br') {
      return this.getInterfaceBriefOutput();
    }

    if (cmd === 'show ip route' || cmd === 'sh ip route') {
      return this.getRouteTableOutput();
    }

    if (cmd === 'show arp' || cmd === 'sh arp') {
      return this.getArpTableOutput();
    }

    if (cmd === 'show running-config' || cmd === 'sh run') {
      return this.getRunningConfigOutput();
    }

    if (cmd === 'show interfaces' || cmd === 'sh int') {
      return this.getInterfacesOutput();
    }

    if (cmd === 'show clock') {
      return this.getClockOutput();
    }

    if (cmd === 'show protocols' || cmd === 'sh protocols') {
      return `Global values:\n  Internet Protocol routing is enabled`;
    }

    if (cmd === 'show flash' || cmd === 'sh flash') {
      return `-#- --length-- -----date/time------ path\n1     33591768 May 19 2012 21:29:58 c2900-universalk9-mz.SPA.151-4.M4.bin\n\n249856000 bytes total (216263232 bytes free)`;
    }

    if (cmd === 'show history' || cmd === 'sh history') {
      return this.commandHistory.slice(-10).map((c, i) => `  ${i + 1}  ${c}`).join('\n');
    }

    if (cmd === 'show ?') {
      return this.getShowHelp();
    }

    return `% Invalid input detected at '^' marker.\n`;
  }

  private executePingCommand(cmd: string): string {
    const target = cmd.substring(5).trim();
    return `Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:\n.....\nSuccess rate is 0 percent (0/5)`;
  }

  private executeTracerouteCommand(cmd: string): string {
    const parts = cmd.split(/\s+/);
    const target = parts[1] || '';
    return `Type escape sequence to abort.\nTracing the route to ${target}\n\n  1   *   *   *\n  2   *   *   *\n  3   *   *   *`;
  }

  private getClockOutput(): string {
    const now = this.clock;
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    return `*${hours}:${minutes}:${seconds}.000 UTC Mon Jan 1 2000`;
  }

  private getVersionOutput(): string {
    return `Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.1(4)M4, RELEASE SOFTWARE (fc1)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2012 by Cisco Systems, Inc.

ROM: System Bootstrap, Version 15.0(1r)M15, RELEASE SOFTWARE (fc1)

${this.getHostname()} uptime is 0 minutes
System returned to ROM by power-on
System image file is "flash:c2900-universalk9-mz.SPA.151-4.M4.bin"

cisco C2911 (revision 1.0) with 491520K/32768K bytes of memory.
Processor board ID FTX152400KS
3 Gigabit Ethernet interfaces
255K bytes of non-volatile configuration memory.
249856K bytes of ATA System CompactFlash 0 (Read/Write)

Configuration register is 0x2102`;
  }

  private getInterfaceBriefOutput(): string {
    let output = 'Interface                  IP-Address      OK? Method Status                Protocol\n';

    for (const port of this.getPorts()) {
      const iface = this.getInterface(port);
      if (iface) {
        const ip = iface.getIPAddress();
        const status = iface.isUp() ? 'up' : 'administratively down';
        const protocol = iface.isUp() ? 'up' : 'down';
        let ciscoName = port.startsWith('eth') ? `GigabitEthernet0/${port.replace('eth', '')}` : port;
        output += `${ciscoName.padEnd(27)}${(ip?.toString() || 'unassigned').padEnd(16)}YES manual  ${status.padEnd(22)}${protocol}\n`;
      }
    }

    return output;
  }

  private getRouteTableOutput(): string {
    const routes = this.getRoutes();
    let output = 'Codes: C - connected, S - static, R - RIP, M - mobile, B - BGP\n\nGateway of last resort is not set\n\n';

    for (const route of routes) {
      const code = route.isDirectlyConnected ? 'C' : 'S';
      const network = `${route.network.toString()}/${route.mask.getCIDR()}`;
      let ciscoIface = route.interface.startsWith('eth') ? `GigabitEthernet0/${route.interface.replace('eth', '')}` : route.interface;

      if (route.isDirectlyConnected) {
        output += `${code}    ${network} is directly connected, ${ciscoIface}\n`;
      } else {
        output += `${code}    ${network} [1/0] via ${route.nextHop?.toString()}\n`;
      }
    }

    return output;
  }

  private getArpTableOutput(): string {
    let output = 'Protocol  Address          Age (min)  Hardware Addr   Type   Interface\n';

    for (const port of this.getPorts()) {
      const entries = this.getARPTable(port);
      let ciscoPort = port.startsWith('eth') ? `GigabitEthernet0/${port.replace('eth', '')}` : port;

      for (const entry of entries) {
        output += `Internet  ${entry.ip.toString().padEnd(17)}0          ${entry.mac.toString().padEnd(16)}ARPA   ${ciscoPort}\n`;
      }
    }

    return output;
  }

  private getRunningConfigOutput(): string {
    let output = `Building configuration...\n\nCurrent configuration : 1024 bytes\n!\nversion 15.1\nservice timestamps debug datetime msec\nservice timestamps log datetime msec\n!\nhostname ${this.getHostname()}\n!\n`;

    if (this.enableSecret) {
      output += `enable secret 5 $1$mERr$hash\n`;
    }

    for (const port of this.getPorts()) {
      const iface = this.getInterface(port);
      if (iface) {
        const ip = iface.getIPAddress();
        const mask = iface.getSubnetMask();
        let ciscoName = port.startsWith('eth') ? `GigabitEthernet0/${port.replace('eth', '')}` : port;
        output += `interface ${ciscoName}\n`;
        if (ip && mask) {
          output += ` ip address ${ip.toString()} ${mask.toString()}\n`;
        } else {
          output += ` no ip address\n`;
        }
        if (!iface.isUp()) {
          output += ` shutdown\n`;
        }
        output += '!\n';
      }
    }

    output += 'end\n';
    return output;
  }

  private getInterfacesOutput(): string {
    let output = '';

    for (const port of this.getPorts()) {
      const iface = this.getInterface(port);
      if (iface) {
        let ciscoName = port.startsWith('eth') ? `GigabitEthernet0/${port.replace('eth', '')}` : port;
        output += `${ciscoName} is ${iface.isUp() ? 'up' : 'administratively down'}, line protocol is ${iface.isUp() ? 'up' : 'down'}\n`;
        output += `  Hardware is Gigabit Ethernet, address is ${iface.getMAC().toString()}\n`;
        const ip = iface.getIPAddress();
        if (ip) {
          output += `  Internet address is ${ip.toString()}/${iface.getSubnetMask()?.getCIDR() || 24}\n`;
        }
        output += '  MTU 1500 bytes, BW 1000000 Kbit/sec\n!\n';
      }
    }

    return output;
  }

  private getUserModeHelp(): string {
    return `Exec commands:
  enable         Turn on privileged commands
  exit           Exit from the EXEC
  show           Show running system information
`;
  }

  private getPrivilegedModeHelp(): string {
    return `Exec commands:
  configure      Enter configuration mode
  copy           Copy from one file to another
  disable        Turn off privileged commands
  exit           Exit from the EXEC
  ping           Send echo messages
  reload         Halt and perform a cold restart
  show           Show running system information
  traceroute     Trace route to destination
  write          Write running configuration to memory
`;
  }

  private getShowHelp(): string {
    return `  arp                ARP table
  clock              Display the system clock
  flash              Display information about flash
  history            Display the session command history
  interfaces         Interface status and configuration
  ip                 IP information
  protocols          Active network routing protocols
  running-config     Current operating configuration
  version            System hardware and software status
`;
  }

  private getContextHelp(partial: string): string {
    if (partial === 'show') {
      return this.getShowHelp();
    }
    if (partial === 'show ip') {
      return `  interface      IP interface status and configuration\n  route          IP routing table\n`;
    }
    return `% Unrecognized command\n`;
  }

  /**
   * Converts Cisco interface name (GigabitEthernet0/0) to internal name (eth0)
   */
  private convertCiscoInterfaceToInternal(ciscoName: string): string {
    const lower = ciscoName.toLowerCase();

    // Extract the port number from patterns like:
    // GigabitEthernet0/0 -> 0
    // Gi0/0 -> 0
    // FastEthernet0/1 -> 1
    // Fa0/1 -> 1
    const match = lower.match(/(?:gigabitethernet|gi|fastethernet|fa|ethernet|eth)(\d+)(?:\/(\d+))?/);
    if (match) {
      // If format is X/Y, use Y as the port number
      // If format is just X, use X as the port number
      const portNum = match[2] !== undefined ? match[2] : match[1];
      return `eth${portNum}`;
    }

    return lower;
  }

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
      case 'line':
        return `${hostname}(config-line)#`;
      case 'router':
        return `${hostname}(config-router)#`;
      default:
        return `${hostname}>`;
    }
  }

  public getCommandHistory(): string[] {
    return [...this.commandHistory];
  }
}
