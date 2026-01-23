/**
 * CiscoRouter - Cisco IOS router with terminal emulation
 *
 * Extends Router with Cisco IOS terminal capabilities:
 * - IOS command execution
 * - Configuration modes (user EXEC, privileged EXEC, config)
 * - Cisco-specific commands
 *
 * @example
 * ```typescript
 * const router = new CiscoRouter({ id: 'r1', name: 'Router 1' });
 * router.powerOn();
 *
 * const result = await router.executeCommand('show ip interface brief');
 * console.log(result);
 * ```
 */

import { Router } from './Router';
import { DeviceConfig, OSType } from './types';

/**
 * Configuration mode
 */
type ConfigMode = 'user' | 'privileged' | 'config' | 'interface';

/**
 * CiscoRouter - Cisco IOS router device
 */
export class CiscoRouter extends Router {
  private commandHistory: string[];
  private configMode: ConfigMode;
  private enablePassword: string;
  private isEnabled: boolean;

  constructor(config: DeviceConfig) {
    // Create Router with cisco-router type
    const id = config.id || `cisco-router-${Date.now()}`;
    const name = config.name || id;

    // Cisco routers typically have 2 interfaces by default
    super(id, name, 2);

    // Override type to cisco-router
    (this as any).type = 'cisco-router';

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
    if (this.configMode === 'config') {
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

    if (cmd === 'show ip interface brief' || cmd === 'sh ip int br') {
      return this.getInterfaceBriefOutput();
    }

    if (cmd === 'show ip route') {
      return this.getRouteTableOutput();
    }

    if (cmd === 'show arp') {
      return this.getArpTableOutput();
    }

    if (cmd === 'show running-config' || cmd === 'sh run') {
      return this.getRunningConfigOutput();
    }

    if (cmd === 'show interfaces') {
      return this.getInterfacesOutput();
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

    return '';
  }

  /**
   * Returns version output
   */
  private getVersionOutput(): string {
    return `Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.1(4)M4, RELEASE SOFTWARE (fc1)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2012 by Cisco Systems, Inc.
Compiled Thurs 5-Jan-12 15:41 by pt_team

ROM: System Bootstrap, Version 15.0(1r)M15, RELEASE SOFTWARE (fc1)

${this.getHostname()} uptime is 0 minutes
System returned to ROM by power-on
System image file is "flash:c2900-universalk9-mz.SPA.151-4.M4.bin"

cisco C2911 (revision 1.0) with 491520K/32768K bytes of memory.
Processor board ID FTX152400KS
2 Gigabit Ethernet interfaces
DRAM configuration is 64 bits wide with parity disabled.
255K bytes of non-volatile configuration memory.
249856K bytes of ATA System CompactFlash 0 (Read/Write)

Configuration register is 0x2102`;
  }

  /**
   * Returns interface brief output
   */
  private getInterfaceBriefOutput(): string {
    let output = 'Interface                  IP-Address      OK? Method Status                Protocol\n';

    const routes = this.getRoutes();
    for (const route of routes) {
      if (route.isDirectlyConnected) {
        const iface = this.getInterface(route.interface);
        if (iface) {
          const ip = iface.getIPAddress();
          const status = iface.isUp() ? 'up' : 'administratively down';
          const protocol = iface.isUp() ? 'up' : 'down';

          output += `${route.interface.padEnd(27)}${(ip?.toString() || 'unassigned').padEnd(16)}YES manual  ${status.padEnd(22)}${protocol}\n`;
        }
      }
    }

    return output;
  }

  /**
   * Returns route table output
   */
  private getRouteTableOutput(): string {
    const routes = this.getRoutes();

    let output = 'Codes: C - connected, S - static, R - RIP, M - mobile, B - BGP\n';
    output += '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area\n';
    output += '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2\n';
    output += '       E1 - OSPF external type 1, E2 - OSPF external type 2\n';
    output += '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2\n';
    output += '       ia - IS-IS inter area, * - candidate default, U - per-user static route\n';
    output += '       o - ODR, P - periodic downloaded static route\n\n';
    output += 'Gateway of last resort is not set\n\n';

    for (const route of routes) {
      const code = route.isDirectlyConnected ? 'C' : 'S';
      const network = `${route.network.toString()}/${route.mask.getCIDR()}`;

      if (route.isDirectlyConnected) {
        output += `${code}    ${network} is directly connected, ${route.interface}\n`;
      } else {
        output += `${code}    ${network} [1/0] via ${route.nextHop?.toString()}\n`;
      }
    }

    return output;
  }

  /**
   * Returns ARP table output
   */
  private getArpTableOutput(): string {
    let output = 'Protocol  Address          Age (min)  Hardware Addr   Type   Interface\n';

    for (const port of this.getPorts()) {
      const entries = this.getARPTable(port);

      for (const entry of entries) {
        output += `Internet  ${entry.ip.toString().padEnd(17)}0          ${entry.mac.toString().padEnd(16)}ARPA   ${port}\n`;
      }
    }

    if (output === 'Protocol  Address          Age (min)  Hardware Addr   Type   Interface\n') {
      return 'No ARP entries found';
    }

    return output;
  }

  /**
   * Returns running config output
   */
  private getRunningConfigOutput(): string {
    let output = 'Building configuration...\n\nCurrent configuration : 1024 bytes\n!\nversion 15.1\n';
    output += 'service timestamps debug datetime msec\n';
    output += 'service timestamps log datetime msec\n';
    output += '!\n';
    output += `hostname ${this.getHostname()}\n`;
    output += '!\n!\n';

    const routes = this.getRoutes();
    for (const route of routes) {
      if (route.isDirectlyConnected) {
        const iface = this.getInterface(route.interface);
        if (iface) {
          const ip = iface.getIPAddress();
          const mask = iface.getSubnetMask();

          output += `interface ${route.interface}\n`;

          if (ip && mask) {
            output += ` ip address ${ip.toString()} ${mask.toString()}\n`;
          }

          output += ` ${iface.isUp() ? 'no shutdown' : 'shutdown'}\n`;
          output += '!\n';
        }
      }
    }

    output += 'end\n';

    return output;
  }

  /**
   * Returns interfaces output
   */
  private getInterfacesOutput(): string {
    let output = '';

    for (const port of this.getPorts()) {
      const iface = this.getInterface(port);
      if (iface) {
        output += `${port} is ${iface.isUp() ? 'up' : 'administratively down'}, line protocol is ${iface.isUp() ? 'up' : 'down'}\n`;
        output += `  Hardware is Gigabit Ethernet, address is ${iface.getMAC().toString()}\n`;

        const ip = iface.getIPAddress();
        if (ip) {
          output += `  Internet address is ${ip.toString()}/${iface.getSubnetMask()?.getCIDR() || 24}\n`;
        }

        output += '  MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec,\n';
        output += '     reliability 255/255, txload 1/255, rxload 1/255\n';
        output += '!\n';
      }
    }

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
  show version             - System hardware and software status
  show ip interface brief  - Brief summary of IP interfaces
  show ip route            - IP routing table
  show arp                 - ARP table
  show running-config      - Current operating configuration
  show interfaces          - Interface status and configuration
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
