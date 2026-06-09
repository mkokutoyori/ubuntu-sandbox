/**
 * UdpStack — connectionless UDP transport for end hosts (RFC 768).
 *
 * Mirrors the TcpStack architecture (host adapter + bus events) but, unlike
 * TcpStack's naive subnet-scan egress, delegates the routing decision to the
 * host's real routing table (longest-prefix match incl. default gateway) and
 * next-hop resolution to the host's asynchronous ARP resolver. Datagrams
 * therefore traverse the simulated network frame by frame — no god-mode
 * object access.
 *
 * Delivery contract (RFC 1122 §4.1.3.1): when no socket listens on the
 * destination port, `handleIp()` returns false so the host can answer with
 * ICMP Destination Unreachable (code 3, Port Unreachable).
 */

import type { IEventBus } from '@/events/EventBus';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, createIPv4Packet,
} from '../core/types';
import { EPHEMERAL_PORT_MIN, EPHEMERAL_PORT_MAX } from '../core/WellKnownPorts';
import { Logger } from '../core/Logger';
import type { Port } from '../hardware/Port';
import type { UdpDropReason } from './events';

/** Limited broadcast address (RFC 919 §7) — never routed, never ARP-resolved. */
const LIMITED_BROADCAST = '255.255.255.255';

/** UDP header size in bytes (RFC 768). */
const UDP_HEADER_BYTES = 8;

/**
 * The surface a host must expose for the UDP stack to send frames.
 * Routing and ARP stay on the host side so UDP shares the exact same
 * data path as ICMP/ping (routing table, gateway, ARP cache & timeout).
 */
export interface UdpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPorts(): Port[];
  /** Longest-prefix-match lookup against the host routing table. */
  resolveRoute(destinationIp: IPAddress): { port: Port; nextHopIP: IPAddress } | null;
  /** ARP-resolve the next hop on the egress port. Rejects on timeout. */
  resolveMacAddress(portName: string, nextHopIp: IPAddress, timeoutMs?: number): Promise<MACAddress>;
  sendFrame(portName: string, frame: EthernetFrame): void;
  /** OS default TTL (64 Linux, 128 Windows) — read lazily, set by subclasses. */
  getDefaultTtl(): number;
}

/** An inbound datagram as presented to a listener. */
export interface ReceivedUdpDatagram {
  readonly sourceIp: string;
  readonly sourcePort: number;
  readonly destinationIp: string;
  readonly destinationPort: number;
  readonly payload: unknown;
  /** Name of the port the datagram arrived on. */
  readonly ingressPort: string;
  /** Send a datagram back to the sender (ports swapped). */
  reply(payload: unknown): Promise<boolean>;
}

export type UdpListenerHandler = (datagram: ReceivedUdpDatagram) => void;

export interface UdpListenOptions {
  /** Local address to bind ('0.0.0.0' = all interfaces, the default). */
  address?: string;
}

export interface UdpSendOptions {
  destinationIp: string;
  destinationPort: number;
  payload: unknown;
  /** Source port; defaults to an ephemeral port (RFC 6335). */
  sourcePort?: number;
  ttl?: number;
  /** Simulated payload size in bytes (drives the UDP/IP length fields). */
  payloadSize?: number;
  /** ARP resolution budget for the next hop. */
  arpTimeoutMs?: number;
}

interface UdpListenerEntry {
  readonly address: string;
  readonly port: number;
  readonly handler: UdpListenerHandler;
}

export class UdpStack {
  /** Keyed `${address}:${port}` — specific binds shadow the 0.0.0.0 wildcard. */
  private readonly listeners = new Map<string, UdpListenerEntry>();
  private nextEphemeralPort = EPHEMERAL_PORT_MIN;

  constructor(
    private readonly host: UdpHost,
    private readonly getBus: () => IEventBus,
  ) {}

  // ─── Listening ─────────────────────────────────────────────────────

  /**
   * Register a datagram handler on (address, port).
   * Returns a disposer. Throws EADDRINUSE on a duplicate bind.
   */
  listen(port: number, handler: UdpListenerHandler, options: UdpListenOptions = {}): () => void {
    const address = options.address ?? '0.0.0.0';
    const key = this.listenerKey(address, port);
    if (this.listeners.has(key)) {
      throw new Error(`EADDRINUSE: UDP port ${port} already bound on ${address}`);
    }
    this.listeners.set(key, { address, port, handler });
    this.publishListenerChanged(address, port, true);
    return () => {
      if (this.listeners.delete(key)) this.publishListenerChanged(address, port, false);
    };
  }

  /**
   * Bind a handler on a free ephemeral port (client-side request/response,
   * e.g. a DNS query awaiting its answer).
   */
  listenEphemeral(handler: UdpListenerHandler): { port: number; dispose: () => void } {
    const port = this.allocateEphemeralPort();
    const dispose = this.listen(port, handler);
    return { port, dispose };
  }

  isListening(port: number, address: string = '0.0.0.0'): boolean {
    return this.listeners.has(this.listenerKey(address, port));
  }

  listListeners(): Array<{ address: string; port: number }> {
    return Array.from(this.listeners.values(), l => ({ address: l.address, port: l.port }));
  }

  // ─── Sending ───────────────────────────────────────────────────────

  /**
   * Build and ship a UDP datagram through the simulated network.
   * Resolves the route via the host routing table and the next-hop MAC via
   * ARP. Returns false when the datagram could not leave the host.
   */
  async send(options: UdpSendOptions): Promise<boolean> {
    const sourcePort = options.sourcePort ?? this.allocateEphemeralPort();
    let destinationIp: IPAddress;
    try {
      destinationIp = new IPAddress(options.destinationIp);
    } catch {
      this.publishDropped('0.0.0.0', options.destinationIp, sourcePort, options.destinationPort, 'no-route');
      return false;
    }

    const egress = this.resolveEgress(destinationIp);
    if (!egress) {
      this.publishDropped('0.0.0.0', options.destinationIp, sourcePort, options.destinationPort, 'no-route');
      return false;
    }

    const sourceIp = egress.port.getIPAddress();
    if (!sourceIp) {
      this.publishDropped('0.0.0.0', options.destinationIp, sourcePort, options.destinationPort, 'no-source-ip');
      return false;
    }

    const payloadSize = options.payloadSize ?? UdpStack.estimatePayloadSize(options.payload);
    const udp: UDPPacket = {
      type: 'udp',
      sourcePort,
      destinationPort: options.destinationPort,
      length: UDP_HEADER_BYTES + payloadSize,
      checksum: 0,
      payload: options.payload,
    };
    const ipPkt = createIPv4Packet(
      sourceIp, destinationIp, IP_PROTO_UDP,
      options.ttl ?? this.host.getDefaultTtl(),
      udp, udp.length,
    );

    let destinationMac: MACAddress;
    if (this.isBroadcastDestination(destinationIp, egress.port)) {
      destinationMac = MACAddress.broadcast();
    } else {
      try {
        destinationMac = await this.host.resolveMacAddress(
          egress.port.getName(), egress.nextHopIP, options.arpTimeoutMs,
        );
      } catch {
        this.publishDropped(sourceIp.toString(), options.destinationIp, sourcePort, options.destinationPort, 'arp-timeout');
        return false;
      }
    }

    this.getBus().publish({
      topic: 'udp.datagram.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        sourceIp: sourceIp.toString(), destinationIp: options.destinationIp,
        sourcePort, destinationPort: options.destinationPort,
        payloadSize,
      },
    });
    this.host.sendFrame(egress.port.getName(), {
      srcMAC: egress.port.getMAC(),
      dstMAC: destinationMac,
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    });
    return true;
  }

  // ─── Receiving ─────────────────────────────────────────────────────

  /**
   * Demultiplex an inbound UDP/IPv4 packet to its listener.
   * Returns true when a listener consumed it; false signals the host to
   * answer with ICMP Port Unreachable (unless the packet was broadcast).
   */
  handleIp(ingressPort: string, ipPkt: IPv4Packet): boolean {
    const udp = ipPkt.payload as UDPPacket;
    if (!udp || udp.type !== 'udp') return true; // malformed — swallow, no ICMP

    const sourceIp = ipPkt.sourceIP.toString();
    const destinationIp = ipPkt.destinationIP.toString();
    const listener = this.findListener(destinationIp, udp.destinationPort);
    if (!listener) {
      this.publishDropped(sourceIp, destinationIp, udp.sourcePort, udp.destinationPort, 'no-listener');
      return false;
    }

    this.getBus().publish({
      topic: 'udp.datagram.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        sourceIp, destinationIp,
        sourcePort: udp.sourcePort, destinationPort: udp.destinationPort,
        payloadSize: Math.max(0, udp.length - UDP_HEADER_BYTES),
      },
    });

    const datagram: ReceivedUdpDatagram = {
      sourceIp,
      sourcePort: udp.sourcePort,
      destinationIp,
      destinationPort: udp.destinationPort,
      payload: udp.payload,
      ingressPort,
      reply: (payload: unknown) => this.send({
        destinationIp: sourceIp,
        destinationPort: udp.sourcePort,
        sourcePort: udp.destinationPort,
        payload,
      }),
    };
    try {
      listener.handler(datagram);
    } catch (err) {
      Logger.warn(this.host.id, 'udp:listener-error',
        `${this.host.name}: UDP listener on port ${udp.destinationPort} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private listenerKey(address: string, port: number): string {
    return `${address}:${port}`;
  }

  private findListener(destinationIp: string, port: number): UdpListenerEntry | undefined {
    return this.listeners.get(this.listenerKey(destinationIp, port))
      ?? this.listeners.get(this.listenerKey('0.0.0.0', port));
  }

  private resolveEgress(destinationIp: IPAddress): { port: Port; nextHopIP: IPAddress } | null {
    if (destinationIp.toString() === LIMITED_BROADCAST) {
      // Limited broadcast goes out of the first usable interface, unrouted.
      for (const port of this.host.getPorts()) {
        if (port.getIPAddress() && port.getIsUp() && port.isConnected()) {
          return { port, nextHopIP: destinationIp };
        }
      }
      return null;
    }
    return this.host.resolveRoute(destinationIp);
  }

  private isBroadcastDestination(destinationIp: IPAddress, egressPort: Port): boolean {
    if (destinationIp.toString() === LIMITED_BROADCAST) return true;
    const mask = egressPort.getSubnetMask();
    return !!mask && destinationIp.isBroadcastFor(mask);
  }

  private allocateEphemeralPort(): number {
    for (let attempts = 0; attempts <= EPHEMERAL_PORT_MAX - EPHEMERAL_PORT_MIN; attempts++) {
      const candidate = this.nextEphemeralPort;
      this.nextEphemeralPort = this.nextEphemeralPort >= EPHEMERAL_PORT_MAX
        ? EPHEMERAL_PORT_MIN
        : this.nextEphemeralPort + 1;
      if (!this.isListening(candidate)) return candidate;
    }
    throw new Error('EADDRINUSE: No ephemeral UDP ports available');
  }

  private static estimatePayloadSize(payload: unknown): number {
    if (payload === undefined || payload === null) return 0;
    if (typeof payload === 'string') return payload.length;
    try { return JSON.stringify(payload).length; } catch { return 32; }
  }

  private publishListenerChanged(address: string, port: number, added: boolean): void {
    this.getBus().publish({
      topic: 'udp.listener.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        localIp: address, localPort: port, added,
      },
    });
  }

  private publishDropped(
    sourceIp: string, destinationIp: string,
    sourcePort: number, destinationPort: number,
    reason: UdpDropReason,
  ): void {
    this.getBus().publish({
      topic: 'udp.datagram.dropped',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        sourceIp, destinationIp, sourcePort, destinationPort, reason,
      },
    });
  }
}
