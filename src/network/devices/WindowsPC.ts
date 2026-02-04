/**
 * WindowsPC - Windows workstation with terminal
 *
 * Supports Windows-style commands:
 * - ipconfig: show/configure interfaces
 * - netsh: set static IP
 * - ping: ICMP echo
 * - arp: view ARP table
 *
 * Internally reuses the same equipment-driven communication model as LinuxPC.
 */

import { Equipment } from '../equipment/Equipment';
import { Port } from '../hardware/Port';
import {
  EthernetFrame, MACAddress, IPAddress, SubnetMask,
  ARPPacket, ICMPPacket,
  ETHERTYPE_ARP, ETHERTYPE_IPV4,
} from '../core/types';
import { Logger } from '../core/Logger';

interface ARPEntry {
  mac: MACAddress;
  timestamp: number;
}

interface PendingPing {
  resolve: (rtt: number) => void;
  reject: (reason: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WindowsPC extends Equipment {
  private arpTable: Map<string, ARPEntry> = new Map();
  private pendingARPs: Map<string, Array<{ resolve: (mac: MACAddress) => void; reject: (reason: string) => void; timer: ReturnType<typeof setTimeout> }>> = new Map();
  private pendingPings: Map<string, PendingPing> = new Map();
  private pingIdCounter: number = 0;

  constructor(name: string, x: number = 0, y: number = 0) {
    super('windows-pc', name, x, y);
    this.createPorts();
  }

  private createPorts(): void {
    for (let i = 0; i < 4; i++) {
      this.addPort(new Port(`eth${i}`, 'ethernet'));
    }
  }

  getInterface(name: string): Port | undefined { return this.getPort(name); }
  getInterfaces(): Port[] { return this.getPorts(); }

  getARPTable(): Map<string, MACAddress> {
    const result = new Map<string, MACAddress>();
    for (const [ip, entry] of this.arpTable) {
      result.set(ip, entry.mac);
    }
    return result;
  }

  // ─── Frame Handling (identical to LinuxPC) ─────────────────────

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    const port = this.ports.get(portName);
    if (!port) return;

    if (!frame.dstMAC.isBroadcast() && !frame.dstMAC.equals(port.getMAC())) {
      return;
    }

    if (frame.etherType === ETHERTYPE_ARP) {
      this.handleARP(portName, frame.payload as ARPPacket);
    } else if (frame.etherType === ETHERTYPE_IPV4) {
      this.handleICMP(portName, frame.payload as ICMPPacket);
    }
  }

  private handleARP(portName: string, arp: ARPPacket): void {
    if (!arp || arp.type !== 'arp') return;
    const port = this.ports.get(portName);
    if (!port) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;

    this.arpTable.set(arp.senderIP.toString(), { mac: arp.senderMAC, timestamp: Date.now() });

    if (arp.operation === 'request' && arp.targetIP.equals(myIP)) {
      const reply: ARPPacket = {
        type: 'arp', operation: 'reply',
        senderMAC: port.getMAC(), senderIP: myIP,
        targetMAC: arp.senderMAC, targetIP: arp.senderIP,
      };
      this.sendFrame(portName, {
        srcMAC: port.getMAC(), dstMAC: arp.senderMAC,
        etherType: ETHERTYPE_ARP, payload: reply,
      });
    } else if (arp.operation === 'reply') {
      const pending = this.pendingARPs.get(arp.senderIP.toString());
      if (pending) {
        for (const p of pending) { clearTimeout(p.timer); p.resolve(arp.senderMAC); }
        this.pendingARPs.delete(arp.senderIP.toString());
      }
    }
  }

  private handleICMP(portName: string, icmp: ICMPPacket): void {
    if (!icmp || icmp.type !== 'icmp') return;

    if (icmp.icmpType === 'echo-request') {
      const port = this.ports.get(portName);
      if (!port) return;
      const myIP = port.getIPAddress();
      if (!myIP) return;

      const targetMAC = this.arpTable.get(icmp.sourceIP.toString());
      if (!targetMAC) return;

      const reply: ICMPPacket = {
        type: 'icmp', icmpType: 'echo-reply',
        id: icmp.id, sequence: icmp.sequence,
        sourceIP: myIP, destinationIP: icmp.sourceIP, ttl: 128,
      };
      this.sendFrame(portName, {
        srcMAC: port.getMAC(), dstMAC: targetMAC.mac,
        etherType: ETHERTYPE_IPV4, payload: reply,
      });
    } else if (icmp.icmpType === 'echo-reply') {
      const key = `${icmp.sourceIP}-${icmp.id}-${icmp.sequence}`;
      const pending = this.pendingPings.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingPings.delete(key);
        pending.resolve(1);
      }
    }
  }

  private resolveARP(portName: string, targetIP: IPAddress, timeoutMs: number = 2000): Promise<MACAddress> {
    const cached = this.arpTable.get(targetIP.toString());
    if (cached) return Promise.resolve(cached.mac);

    const port = this.ports.get(portName);
    if (!port) return Promise.reject('Port not found');
    const myIP = port.getIPAddress();
    if (!myIP) return Promise.reject('No IP configured');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingARPs.get(targetIP.toString());
        if (pending) {
          const idx = pending.findIndex(p => p.resolve === resolve);
          if (idx !== -1) pending.splice(idx, 1);
          if (pending.length === 0) this.pendingARPs.delete(targetIP.toString());
        }
        reject('ARP timeout');
      }, timeoutMs);

      const key = targetIP.toString();
      if (!this.pendingARPs.has(key)) this.pendingARPs.set(key, []);
      this.pendingARPs.get(key)!.push({ resolve, reject, timer });

      const arpReq: ARPPacket = {
        type: 'arp', operation: 'request',
        senderMAC: port.getMAC(), senderIP: myIP,
        targetMAC: MACAddress.broadcast(), targetIP,
      };
      this.sendFrame(portName, {
        srcMAC: port.getMAC(), dstMAC: MACAddress.broadcast(),
        etherType: ETHERTYPE_ARP, payload: arpReq,
      });
    });
  }

  private sendPingPacket(portName: string, targetIP: IPAddress, targetMAC: MACAddress, timeoutMs: number = 2000): Promise<number> {
    const port = this.ports.get(portName);
    if (!port) return Promise.reject('Port not found');
    const myIP = port.getIPAddress();
    if (!myIP) return Promise.reject('No IP');

    this.pingIdCounter++;
    const id = this.pingIdCounter;
    const seq = 1;

    return new Promise((resolve, reject) => {
      const key = `${targetIP}-${id}-${seq}`;
      const timer = setTimeout(() => { this.pendingPings.delete(key); reject('timeout'); }, timeoutMs);
      this.pendingPings.set(key, { resolve, reject, timer });

      const icmp: ICMPPacket = {
        type: 'icmp', icmpType: 'echo-request', id, sequence: seq,
        sourceIP: myIP, destinationIP: targetIP, ttl: 128,
      };
      this.sendFrame(portName, {
        srcMAC: port.getMAC(), dstMAC: targetMAC,
        etherType: ETHERTYPE_IPV4, payload: icmp,
      });
    });
  }

  private findInterfaceForIP(targetIP: IPAddress): Port | null {
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (ip && mask && ip.isInSameSubnet(targetIP, mask)) return port;
    }
    return null;
  }

  // ─── Terminal Commands ─────────────────────────────────────────

  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return 'Device is powered off';

    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case 'ipconfig': return this.cmdIpconfig(parts.slice(1));
      case 'netsh': return this.cmdNetsh(parts.slice(1));
      case 'ping': return this.cmdPing(parts.slice(1));
      case 'arp': return this.cmdArp(parts.slice(1));
      case 'ifconfig': return this.cmdIfconfig(parts.slice(1));
      case 'tracert':
      case 'traceroute': return this.cmdTraceroute(parts.slice(1));
      default: return `'${cmd}' is not recognized as an internal or external command.`;
    }
  }

  private cmdIpconfig(args: string[]): string {
    const lines: string[] = ['Windows IP Configuration', ''];
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      lines.push(`Ethernet adapter ${port.getName()}:`);
      lines.push(`   Connection-specific DNS Suffix  . :`);
      lines.push(`   IPv4 Address. . . . . . . . . . . : ${ip || 'Not configured'}`);
      lines.push(`   Subnet Mask . . . . . . . . . . . : ${mask || 'Not configured'}`);
      lines.push(`   Default Gateway . . . . . . . . . :`);
      lines.push('');
    }
    return lines.join('\n');
  }

  // netsh interface ip set address "Ethernet0" static 192.168.1.20 255.255.255.0
  private cmdNetsh(args: string[]): string {
    const joined = args.join(' ');
    const match = joined.match(/interface\s+ip\s+set\s+address\s+"?(\w+)"?\s+static\s+([\d.]+)\s+([\d.]+)/i);
    if (!match) return 'Usage: netsh interface ip set address "name" static <ip> <mask>';

    const ifName = match[1];
    // Map Windows names to internal: Ethernet0 → eth0
    const portName = ifName.replace(/^Ethernet/i, 'eth');
    const port = this.ports.get(portName);
    if (!port) return `The interface "${ifName}" was not found.`;

    try {
      port.configureIP(new IPAddress(match[2]), new SubnetMask(match[3]));
      return 'Ok.';
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  private cmdIfconfig(args: string[]): string {
    if (args.length < 2) return 'Usage: ifconfig <interface> <ip> [netmask <mask>]';
    const portName = args[0];
    const port = this.ports.get(portName);
    if (!port) return `ifconfig: interface ${portName} not found`;

    const ipStr = args[1];
    let maskStr = '255.255.255.0';
    const nmIdx = args.indexOf('netmask');
    if (nmIdx !== -1 && args[nmIdx + 1]) maskStr = args[nmIdx + 1];

    try {
      port.configureIP(new IPAddress(ipStr), new SubnetMask(maskStr));
      return '';
    } catch (e: any) {
      return `ifconfig: ${e.message}`;
    }
  }

  private async cmdPing(args: string[]): Promise<string> {
    let count = 4;
    let targetStr = '';

    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '-n' || args[i] === '-c') && args[i + 1]) { count = parseInt(args[i + 1], 10); i++; }
      else if (!args[i].startsWith('-')) { targetStr = args[i]; }
    }

    if (!targetStr) return 'Usage: ping [-n count] <destination>';

    let targetIP: IPAddress;
    try { targetIP = new IPAddress(targetStr); } catch { return `Ping request could not find host ${targetStr}.`; }

    const port = this.findInterfaceForIP(targetIP);
    if (!port) return `Ping request could not find host ${targetStr}. Please check the name and try again.`;

    const portName = port.getName();
    const myIP = port.getIPAddress()!;

    if (myIP.equals(targetIP)) {
      const lines = [`Pinging ${targetIP} with 32 bytes of data:`, ''];
      for (let i = 0; i < count; i++) lines.push(`Reply from ${targetIP}: bytes=32 time<1ms TTL=128`);
      lines.push('', `Ping statistics for ${targetIP}:`, `    Packets: Sent = ${count}, Received = ${count}, Lost = 0 (0% loss)`);
      return lines.join('\n');
    }

    let targetMAC: MACAddress;
    try { targetMAC = await this.resolveARP(portName, targetIP, 2000); }
    catch {
      const lines = [`Pinging ${targetIP} with 32 bytes of data:`, ''];
      for (let i = 0; i < count; i++) lines.push('Request timed out.');
      lines.push('', `Ping statistics for ${targetIP}:`, `    Packets: Sent = ${count}, Received = 0, Lost = ${count} (100% loss)`);
      return lines.join('\n');
    }

    let received = 0;
    const lines = [`Pinging ${targetIP} with 32 bytes of data:`, ''];

    for (let seq = 1; seq <= count; seq++) {
      try {
        await this.sendPingPacket(portName, targetIP, targetMAC, 2000);
        received++;
        const fakeRtt = Math.floor(Math.random() * 3 + 1);
        lines.push(`Reply from ${targetIP}: bytes=32 time=${fakeRtt}ms TTL=128`);
      } catch {
        lines.push('Request timed out.');
      }
    }

    const lost = count - received;
    lines.push('', `Ping statistics for ${targetIP}:`,
      `    Packets: Sent = ${count}, Received = ${received}, Lost = ${lost} (${Math.round((lost / count) * 100)}% loss)`);
    return lines.join('\n');
  }

  private cmdArp(args: string[]): string {
    if (this.arpTable.size === 0) return 'No ARP Entries Found.';
    const lines = ['  Internet Address      Physical Address      Type', ''];
    for (const [ip, entry] of this.arpTable) {
      const mac = entry.mac.toString().replace(/:/g, '-');
      lines.push(`  ${ip.padEnd(22)}${mac.padEnd(22)}dynamic`);
    }
    return lines.join('\n');
  }

  private async cmdTraceroute(args: string[]): Promise<string> {
    if (args.length === 0) return 'Usage: tracert <destination>';
    const targetStr = args[0];
    let targetIP: IPAddress;
    try { targetIP = new IPAddress(targetStr); } catch { return `Unable to resolve target system name ${targetStr}.`; }

    const port = this.findInterfaceForIP(targetIP);
    if (!port) return `Unable to resolve target system name ${targetStr}.`;

    const portName = port.getName();
    let targetMAC: MACAddress;
    try { targetMAC = await this.resolveARP(portName, targetIP, 2000); }
    catch { return `Tracing route to ${targetIP}\n  1     *        *        *     Request timed out.`; }

    try {
      await this.sendPingPacket(portName, targetIP, targetMAC, 2000);
      const fakeRtt = Math.floor(Math.random() * 3 + 1);
      return `Tracing route to ${targetIP}\n  1    ${fakeRtt} ms    ${fakeRtt} ms    ${fakeRtt} ms  ${targetIP}\nTrace complete.`;
    } catch {
      return `Tracing route to ${targetIP}\n  1     *        *        *     Request timed out.`;
    }
  }

  getOSType(): string { return 'windows'; }
}
