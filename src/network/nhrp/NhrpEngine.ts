import type { IEventBus } from '@/events/EventBus';
import type { Ipv4SendRequest } from '../layers/internet/Ipv4Egress';
import type { Port } from '../hardware/Port';
import {
  MACAddress, IPAddress,
  type EthernetFrame,
} from '../core/types';
import { Logger } from '../core/Logger';
import type { NhrpService } from '../devices/router/nhrp/NhrpService';
import type { DmvpnService } from '../devices/router/nhrp/DmvpnService';
import {
  IP_PROTO_NHRP, NHRP_ERROR_NONE, NHRP_ERROR_AUTHENTICATION_FAILURE, NHRP_ERROR_NO_BINDING_EXISTS,
  nextNhrpRequestId,
  type NhrpPacket, type NhrpOpcode,
  type NhrpRegistrationRequest, type NhrpRegistrationReply,
  type NhrpResolutionRequest, type NhrpResolutionReply,
} from './types';

export interface NhrpEngineHost {
  readonly id: string;
  readonly name: string;
  getPorts(): Map<string, Port>;
  sendFrame(iface: string, frame: EthernetFrame): void;
  sendIpv4Packet(request: Ipv4SendRequest): boolean;
  getArpEntry(ip: string): { mac: MACAddress; iface: string } | undefined;
}

/**
 * Real NHRP (RFC 2332) engine: Resolution and Registration Request/Reply
 * over genuine IP-protocol-54 packets between tunnel endpoints' real
 * underlay (NBMA) addresses. Replaces the previous CLI-fabricated
 * DmvpnService session state — a session only ever appears once an
 * actual reply has been received.
 *
 * Tunnel interfaces (e.g. `Tunnel100`) are virtual `Port`s with no
 * `Cable` attached — only their underlying physical (`tunnel source`)
 * interface can actually carry a frame. So every send takes the real
 * physical egress interface separately from the tunnel interface whose
 * `NhrpService` config (mappings/NHS list/authentication) applies. On
 * receipt, the tunnel interface is recovered from the packet's own
 * addressed proto-address rather than the (physical) inbound interface,
 * mirroring how a real NHS/spoke identifies which of its own tunnel
 * endpoints a request is for.
 */
export class NhrpEngine {
  constructor(
    private readonly host: NhrpEngineHost,
    private readonly nhrp: NhrpService,
    private readonly dmvpn: DmvpnService,
    private readonly getBus: () => IEventBus,
  ) {}

  // ── Sending (spoke → NHS) ─────────────────────────────────────────

  /** RFC 2332 §5.2.3: register this router's (tunnel-address, NBMA-address) binding with its NHS. */
  sendRegistrationRequest(physicalIfName: string, tunnelIfName: string, tunnelIp: string, nhsTunnelAddr: string): boolean {
    const physicalPort = this.host.getPorts().get(physicalIfName);
    const nbmaAddr = physicalPort?.getIPAddress()?.toString();
    if (!nbmaAddr) return false;
    const nhsNbma = this.resolveNbmaFor(tunnelIfName, nhsTunnelAddr);
    if (!nhsNbma) return false;
    const cfg = this.nhrp.getInterface(tunnelIfName);
    const pkt: NhrpRegistrationRequest = {
      type: 'nhrp', opcode: 'registration-request', requestId: nextNhrpRequestId(),
      srcProtoAddr: tunnelIp, srcNbmaAddr: nbmaAddr, dstProtoAddr: nhsTunnelAddr,
      holdtimeSec: cfg?.holdtimeSec ?? 7200,
      authentication: cfg?.authentication,
    };
    return this.transmit(physicalIfName, nhsNbma, pkt);
  }

  /** RFC 2332 §5.2.2: resolve a tunnel-address to its NBMA address via the NHS. */
  sendResolutionRequest(physicalIfName: string, tunnelIfName: string, tunnelIp: string, targetTunnelAddr: string): boolean {
    const physicalPort = this.host.getPorts().get(physicalIfName);
    const nbmaAddr = physicalPort?.getIPAddress()?.toString();
    if (!nbmaAddr) return false;
    const nhs = this.nhrp.listNhsServers(tunnelIfName)[0];
    if (!nhs) return false;
    const nhsNbma = this.resolveNbmaFor(tunnelIfName, nhs.address);
    if (!nhsNbma) return false;
    const pkt: NhrpResolutionRequest = {
      type: 'nhrp', opcode: 'resolution-request', requestId: nextNhrpRequestId(),
      srcProtoAddr: tunnelIp, srcNbmaAddr: nbmaAddr, dstProtoAddr: targetTunnelAddr,
      nhsProtoAddr: nhs.address,
    };
    return this.transmit(physicalIfName, nhsNbma, pkt);
  }

  /** A static `ip nhrp map` entry doubles as "how do I reach this NBMA peer" for bootstrap. */
  private resolveNbmaFor(tunnelIfName: string, targetProtoAddr: string): string | null {
    const map = this.nhrp.listMappings(tunnelIfName).find(m => m.targetAddress === targetProtoAddr);
    return map?.nbmaAddress ?? targetProtoAddr;
  }

  /** Find which of the router's own tunnel interfaces a packet is addressed to, by matching its own IP. */
  private findOwnTunnelIface(protoAddr: string): string | undefined {
    for (const [name, port] of this.host.getPorts()) {
      if (port.getIPAddress()?.toString() === protoAddr) return name;
    }
    return undefined;
  }

  private transmit(physicalIfName: string, destNbma: string, pkt: NhrpPacket): boolean {
    const port = this.host.getPorts().get(physicalIfName);
    if (!port) return false;
    const myIP = port.getIPAddress();
    if (!myIP) return false;
    if (!this.host.sendIpv4Packet({
      destination: new IPAddress(destNbma), source: myIP,
      protocol: IP_PROTO_NHRP, ttl: 64,
      payload: pkt, payloadBytes: 64,
    })) return false;
    this.getBus().publish({
      topic: 'nhrp.packet.sent',
      payload: { deviceId: this.host.id, hostname: this.host.name, ifName: physicalIfName, opcode: pkt.opcode, destNbmaAddr: destNbma },
    });
    Logger.info(this.host.id, 'nhrp:tx', `${this.host.name}: NHRP ${pkt.opcode} on ${physicalIfName} -> ${destNbma}`);
    return true;
  }

  // ── Receiving ──────────────────────────────────────────────────────

  /** `physicalIfName` is the real (cabled) interface the packet arrived on; the tunnel interface it's addressed to is recovered from the packet content. */
  processPacket(physicalIfName: string, srcNbmaIp: string, pkt: NhrpPacket): void {
    this.getBus().publish({
      topic: 'nhrp.packet.received',
      payload: { deviceId: this.host.id, hostname: this.host.name, ifName: physicalIfName, opcode: pkt.opcode, srcNbmaAddr: srcNbmaIp },
    });
    switch (pkt.opcode) {
      case 'registration-request': return this.handleRegistrationRequest(physicalIfName, srcNbmaIp, pkt);
      case 'registration-reply': return this.handleRegistrationReply(pkt);
      case 'resolution-request': return this.handleResolutionRequest(physicalIfName, srcNbmaIp, pkt);
      case 'resolution-reply': return this.handleResolutionReply(pkt);
    }
  }

  private handleRegistrationRequest(physicalIfName: string, srcNbmaIp: string, pkt: NhrpRegistrationRequest): void {
    const tunnelIfName = this.findOwnTunnelIface(pkt.dstProtoAddr);
    if (!tunnelIfName) return; // not addressed to any of our tunnel interfaces

    const localAuth = this.nhrp.getInterface(tunnelIfName)?.authentication;
    if (localAuth && localAuth !== pkt.authentication) {
      this.dropped(tunnelIfName, pkt.opcode, 'authentication-failure');
      this.sendRegistrationReply(physicalIfName, tunnelIfName, srcNbmaIp, pkt, NHRP_ERROR_AUTHENTICATION_FAILURE);
      return;
    }
    this.nhrp.registerDynamic(tunnelIfName, pkt.srcProtoAddr, pkt.srcNbmaAddr, pkt.holdtimeSec);
    this.dmvpn.upsertSession({
      ifName: tunnelIfName, peerNbmaAddress: pkt.srcNbmaAddr, peerTunnelAddress: pkt.srcProtoAddr,
      role: 'spoke', state: 'UP', attribute: 'D',
    });
    this.getBus().publish({
      topic: 'nhrp.cache.updated',
      payload: { deviceId: this.host.id, hostname: this.host.name, ifName: tunnelIfName, targetAddress: pkt.srcProtoAddr, nbmaAddress: pkt.srcNbmaAddr, type: 'dynamic' },
    });
    this.sendRegistrationReply(physicalIfName, tunnelIfName, srcNbmaIp, pkt, NHRP_ERROR_NONE);
  }

  private sendRegistrationReply(
    physicalIfName: string, tunnelIfName: string, destNbma: string,
    req: NhrpRegistrationRequest, errorCode: number,
  ): void {
    const tunnelPort = this.host.getPorts().get(tunnelIfName);
    const physicalPort = this.host.getPorts().get(physicalIfName);
    const myTunnelIp = tunnelPort?.getIPAddress()?.toString();
    const myNbmaIp = physicalPort?.getIPAddress()?.toString();
    if (!myTunnelIp || !myNbmaIp) return;
    const reply: NhrpRegistrationReply = {
      type: 'nhrp', opcode: 'registration-reply', requestId: req.requestId,
      srcProtoAddr: myTunnelIp, srcNbmaAddr: myNbmaIp,
      dstProtoAddr: req.srcProtoAddr, holdtimeSec: req.holdtimeSec, errorCode,
    };
    this.transmit(physicalIfName, destNbma, reply);
  }

  private handleRegistrationReply(pkt: NhrpRegistrationReply): void {
    const tunnelIfName = this.findOwnTunnelIface(pkt.dstProtoAddr);
    if (!tunnelIfName) return;
    const success = pkt.errorCode === NHRP_ERROR_NONE;
    this.nhrp.markNhsRegistered(tunnelIfName, pkt.srcProtoAddr, success);
    if (success) {
      this.dmvpn.upsertSession({
        ifName: tunnelIfName, peerNbmaAddress: pkt.srcNbmaAddr, peerTunnelAddress: pkt.srcProtoAddr,
        role: 'hub', state: 'UP', attribute: 'D',
      });
    }
  }

  private handleResolutionRequest(physicalIfName: string, srcNbmaIp: string, pkt: NhrpResolutionRequest): void {
    const tunnelIfName = this.findOwnTunnelIface(pkt.nhsProtoAddr);
    if (!tunnelIfName) return; // not addressed to any of our tunnel interfaces

    const binding = this.nhrp.lookupBinding(tunnelIfName, pkt.dstProtoAddr);
    if (!binding) {
      this.dropped(tunnelIfName, pkt.opcode, 'no-binding');
      this.sendResolutionReply(physicalIfName, tunnelIfName, srcNbmaIp, pkt, NHRP_ERROR_NO_BINDING_EXISTS);
      return;
    }
    this.sendResolutionReply(physicalIfName, tunnelIfName, srcNbmaIp, pkt, NHRP_ERROR_NONE, binding.nbmaAddress);
  }

  private sendResolutionReply(
    physicalIfName: string, tunnelIfName: string, destNbma: string, req: NhrpResolutionRequest,
    errorCode: number, resolvedNbmaAddr?: string,
  ): void {
    const tunnelPort = this.host.getPorts().get(tunnelIfName);
    const physicalPort = this.host.getPorts().get(physicalIfName);
    const myTunnelIp = tunnelPort?.getIPAddress()?.toString();
    const myNbmaIp = physicalPort?.getIPAddress()?.toString();
    if (!myTunnelIp || !myNbmaIp) return;
    const reply: NhrpResolutionReply = {
      type: 'nhrp', opcode: 'resolution-reply', requestId: req.requestId,
      srcProtoAddr: myTunnelIp, srcNbmaAddr: myNbmaIp,
      dstProtoAddr: req.dstProtoAddr, requesterProtoAddr: req.srcProtoAddr,
      errorCode, resolvedNbmaAddr,
    };
    this.transmit(physicalIfName, destNbma, reply);
  }

  private handleResolutionReply(pkt: NhrpResolutionReply): void {
    const tunnelIfName = this.findOwnTunnelIface(pkt.requesterProtoAddr);
    if (!tunnelIfName) return;
    if (pkt.errorCode !== NHRP_ERROR_NONE || !pkt.resolvedNbmaAddr) return;
    this.nhrp.registerDynamic(tunnelIfName, pkt.dstProtoAddr, pkt.resolvedNbmaAddr, 7200);
    this.dmvpn.upsertSession({
      ifName: tunnelIfName, peerNbmaAddress: pkt.resolvedNbmaAddr, peerTunnelAddress: pkt.dstProtoAddr,
      role: 'spoke', state: 'UP', attribute: 'D',
    });
    this.getBus().publish({
      topic: 'nhrp.cache.updated',
      payload: { deviceId: this.host.id, hostname: this.host.name, ifName: tunnelIfName, targetAddress: pkt.dstProtoAddr, nbmaAddress: pkt.resolvedNbmaAddr, type: 'dynamic' },
    });
  }

  private dropped(ifName: string, opcode: NhrpOpcode, reason: 'authentication-failure' | 'no-binding'): void {
    this.getBus().publish({
      topic: 'nhrp.packet.dropped',
      payload: { deviceId: this.host.id, hostname: this.host.name, ifName, opcode, reason },
    });
  }
}
