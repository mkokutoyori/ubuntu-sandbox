import type { IEventBus } from '@/events/EventBus';
import {
  type GreConfig, type GreTunnel, type GrePacket,
  createDefaultGreConfig, defaultTunnel, matchTunnel, computeGreChecksum,
  IP_PROTO_GRE, GRE_PROTOCOL_IPV4,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet,
  ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface GreHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
}

export class GreAgent {
  private config: GreConfig = createDefaultGreConfig();
  private running = false;

  constructor(
    private readonly host: GreHost,
    private readonly getBus: () => IEventBus,
  ) {}

  start(): void { if (!this.running) this.running = true; }
  stop(): void { this.running = false; }

  getConfig(): Readonly<GreConfig> { return this.config; }
  setEnabled(on: boolean): void { this.config.enabled = on; }

  addTunnel(tunnelId: string, sourceIp: string, destinationIp: string,
            opts: { overlayIp?: string; overlayMask?: string; key?: number; ttl?: number } = {}): GreTunnel {
    const existing = this.config.tunnels.get(tunnelId);
    if (existing) {
      existing.sourceIp = sourceIp;
      existing.destinationIp = destinationIp;
      if (opts.overlayIp !== undefined) existing.overlayIp = opts.overlayIp;
      if (opts.overlayMask !== undefined) existing.overlayMask = opts.overlayMask;
      if (opts.key !== undefined) existing.key = opts.key;
      if (opts.ttl !== undefined) existing.ttl = opts.ttl;
      return existing;
    }
    const t = defaultTunnel(tunnelId, sourceIp, destinationIp);
    if (opts.overlayIp !== undefined) t.overlayIp = opts.overlayIp;
    if (opts.overlayMask !== undefined) t.overlayMask = opts.overlayMask;
    if (opts.key !== undefined) t.key = opts.key;
    if (opts.ttl !== undefined) t.ttl = opts.ttl;
    this.config.tunnels.set(tunnelId, t);
    this.getBus().publish({
      topic: 'gre.tunnel.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        tunnelId, sourceIp, destinationIp, added: true,
      },
    });
    return t;
  }

  removeTunnel(tunnelId: string): void {
    const t = this.config.tunnels.get(tunnelId);
    if (!t) return;
    this.config.tunnels.delete(tunnelId);
    this.getBus().publish({
      topic: 'gre.tunnel.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        tunnelId, sourceIp: t.sourceIp, destinationIp: t.destinationIp, added: false,
      },
    });
  }

  setTunnelEnabled(tunnelId: string, on: boolean): void {
    const t = this.config.tunnels.get(tunnelId);
    if (t) t.enabled = on;
  }

  setSequenceEnabled(tunnelId: string, on: boolean): void {
    const t = this.config.tunnels.get(tunnelId);
    if (!t) return;
    t.sequenceEnabled = on;
    if (!on) { t.sendSeq = 0; t.expectedRecvSeq = 0; }
  }

  setChecksumEnabled(tunnelId: string, on: boolean): void {
    const t = this.config.tunnels.get(tunnelId);
    if (t) t.checksumEnabled = on;
  }

  getTunnel(tunnelId: string): GreTunnel | undefined { return this.config.tunnels.get(tunnelId); }

  listTunnels(): GreTunnel[] {
    return Array.from(this.config.tunnels.values()).sort((a, b) => a.tunnelId.localeCompare(b.tunnelId));
  }

  encapsulateAndSend(tunnelId: string, innerPacket: IPv4Packet, protocolType = GRE_PROTOCOL_IPV4): boolean {
    if (!this.config.enabled) {
      this.dropped('0.0.0.0', '0.0.0.0', 'disabled');
      return false;
    }
    const t = this.config.tunnels.get(tunnelId);
    if (!t) { this.dropped('0.0.0.0', '0.0.0.0', 'no-tunnel'); return false; }
    if (!t.enabled) { this.dropped(t.sourceIp, t.destinationIp, 'tunnel-down'); return false; }
    const egress = this.resolveEgress(t.destinationIp);
    if (!egress) { this.dropped(t.sourceIp, t.destinationIp, 'no-egress'); return false; }
    const srcIp = egress.port.getIPAddress();
    if (!srcIp) { this.dropped(t.sourceIp, t.destinationIp, 'no-source-ip'); return false; }
    const sequence = t.sequenceEnabled ? t.sendSeq : null;
    if (t.sequenceEnabled) t.sendSeq = (t.sendSeq + 1) >>> 0;
    const gre: GrePacket = {
      type: 'gre',
      checksumPresent: t.checksumEnabled,
      keyPresent: t.key !== null,
      sequencePresent: t.sequenceEnabled,
      version: 0,
      protocolType,
      checksum: 0,
      key: t.key,
      sequence,
      payload: innerPacket,
    };
    if (t.checksumEnabled) gre.checksum = computeGreChecksum(gre);
    const headerLen = 4
      + (t.checksumEnabled ? 4 : 0)
      + (t.key !== null ? 4 : 0)
      + (t.sequenceEnabled ? 4 : 0);
    const outer: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0,
      totalLength: 20 + headerLen + innerPacket.totalLength,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: t.ttl, protocol: IP_PROTO_GRE, headerChecksum: 0,
      sourceIP: new IPAddress(t.sourceIp),
      destinationIP: new IPAddress(t.destinationIp),
      payload: gre,
    };
    outer.headerChecksum = computeIPv4Checksum(outer);
    const eth: EthernetFrame = {
      srcMAC: egress.port.getMAC(),
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: outer,
    };
    this.host.sendFrame(egress.name, eth);
    t.packetsOut++;
    t.bytesOut += outer.totalLength;
    this.getBus().publish({
      topic: 'gre.packet.encapsulated',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        tunnelId: t.tunnelId, sourceIp: t.sourceIp, destinationIp: t.destinationIp,
        protocolType, key: t.key,
      },
    });
    Logger.info(this.host.id, 'gre:tx',
      `${this.host.name}: ${t.tunnelId} encap ${innerPacket.sourceIP}→${innerPacket.destinationIP}`);
    return true;
  }

  handleIp(_inPort: string, srcIp: IPAddress, ipPkt: IPv4Packet): IPv4Packet | null {
    if (!this.config.enabled) return null;
    if (ipPkt.protocol !== IP_PROTO_GRE) return null;
    const gre = ipPkt.payload as GrePacket | undefined;
    if (!gre || gre.type !== 'gre') return null;
    const tunnel = matchTunnel(this.config.tunnels.values(),
                               srcIp.toString(), ipPkt.destinationIP.toString(), gre.key);
    if (!tunnel) {
      const peer = this.tunnelByPeer(srcIp.toString(), ipPkt.destinationIP.toString());
      const reason = peer && peer.key !== gre.key ? 'key-mismatch' : 'no-tunnel';
      this.dropped(srcIp.toString(), ipPkt.destinationIP.toString(), reason);
      return null;
    }
    if (tunnel.checksumEnabled && gre.checksumPresent) {
      const wireChecksum = gre.checksum;
      const recomputed = computeGreChecksum({ ...gre, checksum: 0 });
      if (wireChecksum !== recomputed) {
        tunnel.checksumDrops++;
        this.dropped(tunnel.sourceIp, tunnel.destinationIp, 'checksum-mismatch');
        return null;
      }
    }
    if (tunnel.sequenceEnabled && gre.sequencePresent && gre.sequence !== null) {
      if (((gre.sequence - tunnel.expectedRecvSeq) | 0) < 0) {
        tunnel.outOfOrderDrops++;
        this.dropped(tunnel.sourceIp, tunnel.destinationIp, 'out-of-order');
        return null;
      }
      tunnel.expectedRecvSeq = (gre.sequence + 1) >>> 0;
    }
    tunnel.packetsIn++;
    tunnel.bytesIn += ipPkt.totalLength;
    const inner = gre.payload as IPv4Packet | undefined;
    const innerSrc = inner && inner.type === 'ipv4' ? inner.sourceIP.toString() : null;
    const innerDst = inner && inner.type === 'ipv4' ? inner.destinationIP.toString() : null;
    this.getBus().publish({
      topic: 'gre.packet.decapsulated',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        tunnelId: tunnel.tunnelId,
        sourceIp: tunnel.sourceIp, destinationIp: tunnel.destinationIp,
        protocolType: gre.protocolType,
        innerSourceIp: innerSrc, innerDestinationIp: innerDst,
      },
    });
    Logger.info(this.host.id, 'gre:rx',
      `${this.host.name}: ${tunnel.tunnelId} decap ${innerSrc}→${innerDst}`);
    return inner && inner.type === 'ipv4' ? inner : null;
  }

  private tunnelByPeer(srcIp: string, dstIp: string): GreTunnel | null {
    for (const t of this.config.tunnels.values()) {
      if (t.sourceIp === dstIp && t.destinationIp === srcIp) return t;
    }
    return null;
  }

  private dropped(sourceIp: string, destinationIp: string,
                  reason: 'no-tunnel' | 'key-mismatch' | 'no-source-ip' | 'no-egress' | 'disabled' | 'tunnel-down' | 'checksum-mismatch' | 'out-of-order'): void {
    this.getBus().publish({
      topic: 'gre.packet.dropped',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        sourceIp, destinationIp, reason,
      },
    });
  }

  private resolveEgress(targetIp: string): { name: string; port: import('../hardware/Port').Port } | null {
    const target = targetIp.split('.').map(Number);
    for (const port of this.host.getPorts()) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask) continue;
      const local = ip.toString().split('.').map(Number);
      const maskBits = mask.toString().split('.').map(Number);
      let same = true;
      for (let i = 0; i < 4; i++) {
        if ((local[i] & maskBits[i]) !== (target[i] & maskBits[i])) { same = false; break; }
      }
      if (same) return { name: port.getName(), port };
    }
    for (const port of this.host.getPorts()) {
      if (port.getIPAddress() && port.getIsUp() && port.isConnected()) {
        return { name: port.getName(), port };
      }
    }
    return null;
  }
}
