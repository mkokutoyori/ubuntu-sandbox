/**
 * LinuxPC - Linux workstation with terminal, ARP, and ICMP
 *
 * Supports:
 * - ifconfig: configure IP on interfaces
 * - ping: send ICMP echo requests and wait for replies
 * - arp: view/manage ARP table
 *
 * Communication is equipment-driven:
 *   ping 192.168.1.20
 *   → ARP: who has 192.168.1.20?
 *     → Port.sendFrame(ARP request broadcast)
 *       → Cable → Switch → Cable → Target PC
 *         → Target PC replies ARP
 *           → Cable → Switch → Cable → back to us
 *   → ARP resolved, send ICMP echo request
 *     → Port.sendFrame(ICMP request)
 *       → Cable → Switch → Cable → Target PC
 *         → Target PC sends ICMP echo reply
 *           → Cable → Switch → Cable → back to us
 *   → Reply received, report success
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

export class LinuxPC extends Equipment {
  private arpTable: Map<string, ARPEntry> = new Map();
  private pendingARPs: Map<string, Array<{ resolve: (mac: MACAddress) => void; reject: (reason: string) => void; timer: ReturnType<typeof setTimeout> }>> = new Map();
  private pendingPings: Map<string, PendingPing> = new Map();
  private pingIdCounter: number = 0;

  constructor(name: string, x: number = 0, y: number = 0) {
    super('linux-pc', name, x, y);
    this.createPorts();
  }

  private createPorts(): void {
    for (let i = 0; i < 4; i++) {
      this.addPort(new Port(`eth${i}`, 'ethernet'));
    }
  }

  // ─── Interface Configuration ───────────────────────────────────

  getInterface(name: string): Port | undefined {
    return this.getPort(name);
  }

  getInterfaces(): Port[] {
    return this.getPorts();
  }

  // ─── ARP Table ─────────────────────────────────────────────────

  getARPTable(): Map<string, MACAddress> {
    const result = new Map<string, MACAddress>();
    for (const [ip, entry] of this.arpTable) {
      result.set(ip, entry.mac);
    }
    return result;
  }

  // ─── Frame Handling ────────────────────────────────────────────

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    const port = this.ports.get(portName);
    if (!port) return;

    // Check if frame is for us (our MAC, or broadcast)
    if (!frame.dstMAC.isBroadcast() && !frame.dstMAC.equals(port.getMAC())) {
      return; // Not for us
    }

    if (frame.etherType === ETHERTYPE_ARP) {
      this.handleARP(portName, frame.payload as ARPPacket);
    } else if (frame.etherType === ETHERTYPE_IPV4) {
      this.handleICMP(portName, frame.payload as ICMPPacket);
    }
  }

  // ─── ARP Handling ──────────────────────────────────────────────

  private handleARP(portName: string, arp: ARPPacket): void {
    if (!arp || arp.type !== 'arp') return;

    const port = this.ports.get(portName);
    if (!port) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;

    // Learn sender's MAC→IP mapping
    this.arpTable.set(arp.senderIP.toString(), {
      mac: arp.senderMAC,
      timestamp: Date.now(),
    });

    if (arp.operation === 'request' && arp.targetIP.equals(myIP)) {
      // ARP request for our IP → reply
      Logger.info(this.id, 'arp:reply', `${this.name}: replying to ARP request from ${arp.senderIP}`);

      const reply: ARPPacket = {
        type: 'arp',
        operation: 'reply',
        senderMAC: port.getMAC(),
        senderIP: myIP,
        targetMAC: arp.senderMAC,
        targetIP: arp.senderIP,
      };

      const replyFrame: EthernetFrame = {
        srcMAC: port.getMAC(),
        dstMAC: arp.senderMAC,
        etherType: ETHERTYPE_ARP,
        payload: reply,
      };

      this.sendFrame(portName, replyFrame);
    } else if (arp.operation === 'reply') {
      // ARP reply → resolve pending ARP requests
      const key = arp.senderIP.toString();
      const pending = this.pendingARPs.get(key);
      if (pending) {
        for (const p of pending) {
          clearTimeout(p.timer);
          p.resolve(arp.senderMAC);
        }
        this.pendingARPs.delete(key);
      }
    }
  }

  // ─── ICMP Handling ─────────────────────────────────────────────

  private handleICMP(portName: string, icmp: ICMPPacket): void {
    if (!icmp || icmp.type !== 'icmp') return;

    if (icmp.icmpType === 'echo-request') {
      // Reply to ping
      this.sendEchoReply(portName, icmp);
    } else if (icmp.icmpType === 'echo-reply') {
      // Match to pending ping
      const key = `${icmp.sourceIP}-${icmp.id}-${icmp.sequence}`;
      const pending = this.pendingPings.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingPings.delete(key);
        pending.resolve(1); // RTT placeholder (synchronous sim)
      }
    }
  }

  private sendEchoReply(portName: string, request: ICMPPacket): void {
    const port = this.ports.get(portName);
    if (!port) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;

    // Look up MAC for the requester
    const targetMAC = this.arpTable.get(request.sourceIP.toString());
    if (!targetMAC) return; // Should have been learned from ARP

    const reply: ICMPPacket = {
      type: 'icmp',
      icmpType: 'echo-reply',
      id: request.id,
      sequence: request.sequence,
      sourceIP: myIP,
      destinationIP: request.sourceIP,
      ttl: 64,
    };

    const frame: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: targetMAC.mac,
      etherType: ETHERTYPE_IPV4,
      payload: reply,
    };

    this.sendFrame(portName, frame);
  }

  // ─── ARP Resolution ────────────────────────────────────────────

  /**
   * Resolve an IP address to a MAC address using ARP.
   * Returns cached result if available, otherwise sends ARP request.
   */
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
      if (!this.pendingARPs.has(key)) {
        this.pendingARPs.set(key, []);
      }
      this.pendingARPs.get(key)!.push({ resolve, reject, timer });

      // Send ARP request
      const arpRequest: ARPPacket = {
        type: 'arp',
        operation: 'request',
        senderMAC: port.getMAC(),
        senderIP: myIP,
        targetMAC: MACAddress.broadcast(),
        targetIP: targetIP,
      };

      const frame: EthernetFrame = {
        srcMAC: port.getMAC(),
        dstMAC: MACAddress.broadcast(),
        etherType: ETHERTYPE_ARP,
        payload: arpRequest,
      };

      this.sendFrame(portName, frame);
    });
  }

  // ─── Ping ──────────────────────────────────────────────────────

  /**
   * Send a single ICMP echo request and wait for reply
   */
  private sendPing(portName: string, targetIP: IPAddress, targetMAC: MACAddress, timeoutMs: number = 2000): Promise<number> {
    const port = this.ports.get(portName);
    if (!port) return Promise.reject('Port not found');

    const myIP = port.getIPAddress();
    if (!myIP) return Promise.reject('No IP configured');

    this.pingIdCounter++;
    const id = this.pingIdCounter;
    const seq = 1;

    return new Promise((resolve, reject) => {
      const key = `${targetIP}-${id}-${seq}`;

      const timer = setTimeout(() => {
        this.pendingPings.delete(key);
        reject('timeout');
      }, timeoutMs);

      this.pendingPings.set(key, { resolve, reject, timer });

      const icmp: ICMPPacket = {
        type: 'icmp',
        icmpType: 'echo-request',
        id,
        sequence: seq,
        sourceIP: myIP,
        destinationIP: targetIP,
        ttl: 64,
      };

      const frame: EthernetFrame = {
        srcMAC: port.getMAC(),
        dstMAC: targetMAC,
        etherType: ETHERTYPE_IPV4,
        payload: icmp,
      };

      this.sendFrame(portName, frame);
    });
  }

  // ─── Find Interface for Target IP ──────────────────────────────

  private findInterfaceForIP(targetIP: IPAddress): Port | null {
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (ip && mask && ip.isInSameSubnet(targetIP, mask)) {
        return port;
      }
    }
    return null;
  }

  // ─── Terminal Commands ─────────────────────────────────────────

  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return 'Device is powered off';

    const parts = command.trim().split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case 'ifconfig':
        return this.cmdIfconfig(parts.slice(1));
      case 'ping':
        return this.cmdPing(parts.slice(1));
      case 'arp':
        return this.cmdArp(parts.slice(1));
      case 'hostname':
        if (parts.length > 1) {
          this.hostname = parts[1];
          return '';
        }
        return this.hostname;
      case 'traceroute':
        return this.cmdTraceroute(parts.slice(1));
      default:
        return `${cmd}: command not found`;
    }
  }

  // ─── ifconfig ──────────────────────────────────────────────────

  private cmdIfconfig(args: string[]): string {
    if (args.length === 0) {
      // Show all interfaces
      return this.showInterfaces();
    }

    const ifName = args[0];
    const port = this.ports.get(ifName);
    if (!port) return `ifconfig: interface ${ifName} not found`;

    if (args.length === 1) {
      return this.showInterface(port);
    }

    // ifconfig eth0 192.168.1.10 [netmask 255.255.255.0]
    const ipStr = args[1];
    let maskStr = '255.255.255.0';

    const nmIdx = args.indexOf('netmask');
    if (nmIdx !== -1 && args[nmIdx + 1]) {
      maskStr = args[nmIdx + 1];
    }

    try {
      const ip = new IPAddress(ipStr);
      const mask = new SubnetMask(maskStr);
      port.configureIP(ip, mask);
      return '';
    } catch (e: any) {
      return `ifconfig: ${e.message}`;
    }
  }

  private showInterfaces(): string {
    const lines: string[] = [];
    for (const [, port] of this.ports) {
      lines.push(this.showInterface(port));
      lines.push('');
    }
    return lines.join('\n');
  }

  private showInterface(port: Port): string {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const mac = port.getMAC();
    const lines = [
      `${port.getName()}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
      ip ? `        inet ${ip}  netmask ${mask || '255.255.255.0'}` : '        inet (not configured)',
      `        ether ${mac}`,
      `        ${port.isConnected() ? 'cable connected' : 'no cable'}`,
    ];
    return lines.join('\n');
  }

  // ─── ping ──────────────────────────────────────────────────────

  private async cmdPing(args: string[]): Promise<string> {
    let count = 4;
    let targetStr = '';

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' && args[i + 1]) {
        count = parseInt(args[i + 1], 10);
        i++;
      } else if (!args[i].startsWith('-')) {
        targetStr = args[i];
      }
    }

    if (!targetStr) return 'Usage: ping [-c count] <destination>';

    let targetIP: IPAddress;
    try {
      targetIP = new IPAddress(targetStr);
    } catch {
      return `ping: unknown host ${targetStr}`;
    }

    // Find the interface to use
    const port = this.findInterfaceForIP(targetIP);
    if (!port) {
      return `ping: connect: Network is unreachable`;
    }

    const portName = port.getName();
    const myIP = port.getIPAddress()!;

    // Check if pinging ourselves
    if (myIP.equals(targetIP)) {
      return this.selfPing(targetIP, count);
    }

    // Resolve ARP
    let targetMAC: MACAddress;
    try {
      targetMAC = await this.resolveARP(portName, targetIP, 2000);
    } catch {
      return this.formatPingResult(targetIP, count, 0, count);
    }

    // Send pings
    let received = 0;
    let failed = 0;
    const rtts: number[] = [];

    const lines: string[] = [];
    lines.push(`PING ${targetIP} (${targetIP}) 56(84) bytes of data.`);

    for (let seq = 1; seq <= count; seq++) {
      try {
        const rtt = await this.sendPing(portName, targetIP, targetMAC, 2000);
        received++;
        const fakeRtt = (Math.random() * 2 + 0.5).toFixed(3);
        rtts.push(parseFloat(fakeRtt));
        lines.push(`64 bytes from ${targetIP}: icmp_seq=${seq} ttl=64 time=${fakeRtt} ms`);
      } catch {
        failed++;
      }
    }

    lines.push('');
    lines.push(`--- ${targetIP} ping statistics ---`);
    lines.push(`${count} packets transmitted, ${received} received, ${Math.round((failed / count) * 100)}% packet loss`);

    if (rtts.length > 0) {
      const min = Math.min(...rtts).toFixed(3);
      const max = Math.max(...rtts).toFixed(3);
      const avg = (rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(3);
      lines.push(`rtt min/avg/max = ${min}/${avg}/${max} ms`);
    }

    return lines.join('\n');
  }

  private selfPing(targetIP: IPAddress, count: number): string {
    const lines: string[] = [];
    lines.push(`PING ${targetIP} (${targetIP}) 56(84) bytes of data.`);
    for (let seq = 1; seq <= count; seq++) {
      lines.push(`64 bytes from ${targetIP}: icmp_seq=${seq} ttl=64 time=0.010 ms`);
    }
    lines.push('');
    lines.push(`--- ${targetIP} ping statistics ---`);
    lines.push(`${count} packets transmitted, ${count} received, 0% packet loss`);
    lines.push(`rtt min/avg/max = 0.010/0.010/0.010 ms`);
    return lines.join('\n');
  }

  private formatPingResult(targetIP: IPAddress, count: number, received: number, failed: number): string {
    const lines: string[] = [];
    lines.push(`PING ${targetIP} (${targetIP}) 56(84) bytes of data.`);
    lines.push('');
    lines.push(`--- ${targetIP} ping statistics ---`);
    lines.push(`${count} packets transmitted, ${received} received, ${Math.round((failed / count) * 100)}% packet loss`);
    return lines.join('\n');
  }

  // ─── arp ───────────────────────────────────────────────────────

  private cmdArp(args: string[]): string {
    if (args.length === 0 || args[0] === '-a') {
      if (this.arpTable.size === 0) {
        return 'No ARP entries';
      }
      const lines: string[] = [];
      for (const [ip, entry] of this.arpTable) {
        lines.push(`${ip} at ${entry.mac} on eth0`);
      }
      return lines.join('\n');
    }
    return 'Usage: arp [-a]';
  }

  // ─── traceroute ────────────────────────────────────────────────

  private async cmdTraceroute(args: string[]): Promise<string> {
    if (args.length === 0) return 'Usage: traceroute <destination>';

    const targetStr = args[0];
    let targetIP: IPAddress;
    try {
      targetIP = new IPAddress(targetStr);
    } catch {
      return `traceroute: unknown host ${targetStr}`;
    }

    const port = this.findInterfaceForIP(targetIP);
    if (!port) {
      return `traceroute to ${targetIP}, 30 hops max\n 1  * * * (network interface not configured)`;
    }

    // For L2 topology (no routers), target is 1 hop away
    const portName = port.getName();
    let targetMAC: MACAddress;
    try {
      targetMAC = await this.resolveARP(portName, targetIP, 2000);
    } catch {
      return `traceroute to ${targetIP}, 30 hops max\n 1  * * *`;
    }

    // Try ping to verify reachability
    try {
      await this.sendPing(portName, targetIP, targetMAC, 2000);
      const fakeRtt = (Math.random() * 2 + 0.5).toFixed(3);
      return `traceroute to ${targetIP}, 30 hops max\n 1  ${targetIP}  ${fakeRtt} ms`;
    } catch {
      return `traceroute to ${targetIP}, 30 hops max\n 1  * * *`;
    }
  }

  // ─── OS Info ───────────────────────────────────────────────────

  getOSType(): string { return 'linux'; }
}
