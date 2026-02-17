/**
 * LinuxServer - Linux server with full filesystem and user management.
 *
 * Extends EndHost (provides L2/L3 network stack).
 * Uses LinuxCommandExecutor for filesystem, user management, and utility commands.
 * Falls through to networking commands (ifconfig, ip, ping, etc.) when needed.
 */

import { EndHost, PingResult } from './EndHost';
import { Port } from '../hardware/Port';
import { IPAddress, SubnetMask, DeviceType } from '../core/types';
import { LinuxCommandExecutor } from './linux/LinuxCommandExecutor';

export class LinuxServer extends EndHost {
  protected readonly defaultTTL = 64;
  private executor: LinuxCommandExecutor;

  constructor(type: DeviceType = 'linux-server', name: string = 'Server', x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.createPorts();
    this.executor = new LinuxCommandExecutor(true); // isServer = true (root user)
  }

  private createPorts(): void {
    for (let i = 0; i < 4; i++) {
      this.addPort(new Port(`eth${i}`, 'ethernet'));
    }
  }

  // ─── Terminal ──────────────────────────────────────────────────

  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return 'Device is powered off';

    const trimmed = command.trim();
    if (!trimmed) return '';

    // Try networking commands first (they need access to EndHost internals)
    const networkResult = this.tryNetworkCommand(trimmed);
    if (networkResult !== null) return networkResult;

    // Delegate to Linux command executor
    return this.executor.execute(trimmed);
  }

  /**
   * Try to handle as a networking command. Returns null if not a network command.
   */
  private tryNetworkCommand(input: string): string | null {
    // Strip sudo for network commands too
    const noSudo = input.startsWith('sudo ') ? input.slice(5).trim() : input;
    const parts = noSudo.split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case 'ifconfig': return this.cmdIfconfig(parts.slice(1));
      case 'ip': return this.cmdIp(parts.slice(1));
      case 'ping': return null; // Let executor handle (async not needed for tests)
      case 'arp': return this.cmdArp(parts.slice(1));
      default: return null;
    }
  }

  // ─── Networking commands (same as LinuxPC) ──────────────────────

  private cmdIfconfig(args: string[]): string {
    if (args.length === 0) return this.showAllInterfaces();

    const ifName = args[0];
    const port = this.ports.get(ifName);
    if (!port) return `ifconfig: interface ${ifName} not found`;
    if (args.length === 1) return this.formatInterface(port);

    const ipStr = args[1];
    let maskStr = '255.255.255.0';
    const nmIdx = args.indexOf('netmask');
    if (nmIdx !== -1 && args[nmIdx + 1]) maskStr = args[nmIdx + 1];

    try {
      this.configureInterface(ifName, new IPAddress(ipStr), new SubnetMask(maskStr));
      return '';
    } catch (e: any) {
      return `ifconfig: ${e.message}`;
    }
  }

  private showAllInterfaces(): string {
    const lines: string[] = [];
    for (const [, port] of this.ports) {
      lines.push(this.formatInterface(port));
      lines.push('');
    }
    return lines.join('\n');
  }

  private formatInterface(port: Port): string {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const mac = port.getMAC();
    const status = port.getIsUp() && port.isConnected() ? 'UP,BROADCAST,RUNNING,MULTICAST' : 'UP,BROADCAST,MULTICAST';
    return [
      `${port.getName()}: flags=4163<${status}>  mtu 1500`,
      ip ? `        inet ${ip}  netmask ${mask || '255.255.255.0'}` : '        inet (not configured)',
      `        ether ${mac}`,
    ].join('\n');
  }

  private cmdIp(args: string[]): string {
    if (args.length === 0) return 'Usage: ip { addr | route }';
    // Simplified for server
    return '';
  }

  private cmdArp(args: string[]): string {
    if (this.arpTable.size === 0) return '';
    const lines: string[] = [];
    for (const [ip, entry] of this.arpTable) {
      lines.push(`? (${ip}) at ${entry.mac} [ether] on ${entry.iface}`);
    }
    return lines.join('\n');
  }

  getOSType(): string { return 'linux'; }
  getCwd(): string { return this.executor.getCwd(); }
  getCompletions(partial: string): string[] { return this.executor.getCompletions(partial); }
  getCurrentUser(): string { return this.executor.getCurrentUser(); }
  getCurrentUid(): number { return this.executor.getCurrentUid(); }
  handleExit(): { output: string; inSu: boolean } { return this.executor.handleExit(); }
  checkPassword(username: string, password: string): boolean { return this.executor.checkPassword(username, password); }
  setUserPassword(username: string, password: string): void { this.executor.setUserPassword(username, password); }
  userExists(username: string): boolean { return this.executor.userExists(username); }
}
