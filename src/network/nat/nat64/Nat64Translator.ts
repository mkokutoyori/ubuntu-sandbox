import {
  IPAddress, IPv6Address, IP_PROTO_ICMP, IP_PROTO_ICMPV6, createIPv4Packet, createIPv6Packet,
  type ICMPPacket, type ICMPType, type ICMPv6Packet, type ICMPv6Type, type IPv4Packet, type IPv6Packet,
  type TCPPacket, type UDPPacket,
} from '@/network/core/types';
import { recomputeL4Checksum } from '@/network/nat/rewrite';
import { isGlobalIpv4, type Nat64Prefix } from './Nat64Prefix';

const IP_PROTO_TCP = 6;
const IP_PROTO_UDP = 17;
const DF = 0b010;
const DF_LENGTH_THRESHOLD = 1260;
const MTU_PLATEAUS = [65535, 32000, 17914, 8166, 4352, 2002, 1492, 1006, 508, 296, 68];
const LOW_PORT_CEILING = 1024;
const WELL_KNOWN_CEILING = 512;

export type Nat64Protocol = 'tcp' | 'udp' | 'icmp';

export type Nat64TcpState =
  | 'v4-init' | 'v6-init' | 'established' | 'v4-fin-rcv' | 'v6-fin-rcv' | 'v6-fin-v4-fin-rcv' | 'trans';

export interface Nat64Timeouts {
  readonly udpMs: number;
  readonly icmpMs: number;
  readonly tcpEstablishedMs: number;
  readonly tcpTransitoryMs: number;
  readonly tcpInitialMs: number;
}

export const NAT64_DEFAULT_TIMEOUTS: Nat64Timeouts = {
  udpMs: 5 * 60_000,
  icmpMs: 60_000,
  tcpEstablishedMs: 2 * 3_600_000 + 4 * 60_000,
  tcpTransitoryMs: 4 * 60_000,
  tcpInitialMs: 6_000,
};

export interface Nat64NexthopMtu {
  ipv4(destination: IPAddress): number | undefined;
  ipv6(destination: IPv6Address): number | undefined;
}

export interface Nat64Config {
  readonly nexthopMtu?: Nat64NexthopMtu;
  readonly prefix: Nat64Prefix;
  readonly pool: readonly IPAddress[];
  readonly clock: () => number;
  readonly timeouts?: Partial<Nat64Timeouts>;
}

export interface Nat64Binding {
  readonly protocol: Nat64Protocol;
  readonly v6Address: string;
  readonly v6Port: number;
  readonly v4Address: string;
  readonly v4Port: number;
}

export interface Nat64Session {
  readonly protocol: Nat64Protocol;
  readonly v6Source: string;
  readonly v6SourcePort: number;
  readonly v6Destination: string;
  readonly v6DestinationPort: number;
  readonly v4Source: string;
  readonly v4SourcePort: number;
  readonly v4Destination: string;
  readonly v4DestinationPort: number;
  readonly createdAt: number;
  lastUsedAt: number;
  tcpState?: Nat64TcpState;
}

export type Nat64DropReason =
  | 'not-in-prefix' | 'non-global-destination' | 'unsupported-protocol' | 'pool-exhausted'
  | 'no-binding' | 'filtered' | 'unsupported-icmp';

const IPV6_MINIMUM_MTU = 1280;
const HEADER_GROWTH = 20;
const IPV6_HEADER_BYTES = 40;
const ICMP_ERROR_HEADER_BYTES = 8;
const IPV4_HEADER_BYTES = 20;

interface ErrorMapping<T> { readonly type: T; readonly code: number; readonly pointer?: number }

const V4_UNREACHABLE_TO_V6: Readonly<Record<number, ErrorMapping<ICMPv6Type>>> = {
  0: { type: 'destination-unreachable', code: 0 }, 1: { type: 'destination-unreachable', code: 0 },
  2: { type: 'parameter-problem', code: 1, pointer: 6 }, 3: { type: 'destination-unreachable', code: 4 },
  5: { type: 'destination-unreachable', code: 0 }, 6: { type: 'destination-unreachable', code: 0 },
  7: { type: 'destination-unreachable', code: 0 }, 8: { type: 'destination-unreachable', code: 0 },
  9: { type: 'destination-unreachable', code: 1 }, 10: { type: 'destination-unreachable', code: 1 },
  11: { type: 'destination-unreachable', code: 0 }, 12: { type: 'destination-unreachable', code: 0 },
  13: { type: 'destination-unreachable', code: 1 }, 15: { type: 'destination-unreachable', code: 1 },
};

const V4_POINTER_TO_V6: Readonly<Record<number, number>> = { 0: 0, 1: 1, 2: 4, 3: 4, 8: 7, 9: 6, 12: 8, 13: 8, 14: 8, 15: 8, 16: 24, 17: 24, 18: 24, 19: 24 };
const V6_POINTER_TO_V4: Readonly<Record<number, number>> = { 0: 0, 1: 1, 4: 2, 5: 2, 6: 9, 7: 8 };

const V6_UNREACHABLE_TO_V4: Readonly<Record<number, number>> = { 0: 1, 1: 10, 2: 1, 3: 1, 4: 3 };

export type Nat64Result<T> = { readonly ok: true; readonly packet: T } | { readonly ok: false; readonly reason: Nat64DropReason };

interface Endpoint { readonly ip: string; readonly port: number }

function protocolOf(number: number): Nat64Protocol | null {
  if (number === IP_PROTO_TCP) return 'tcp';
  if (number === IP_PROTO_UDP) return 'udp';
  if (number === IP_PROTO_ICMP || number === IP_PROTO_ICMPV6) return 'icmp';
  return null;
}

const bindingKey6 = (protocol: Nat64Protocol, endpoint: Endpoint) => `${protocol}|${endpoint.ip}|${endpoint.port}`;
const bindingKey4 = bindingKey6;
const sessionKey = (protocol: Nat64Protocol, a: Endpoint, b: Endpoint) => `${protocol}|${a.ip}|${a.port}|${b.ip}|${b.port}`;

export class Nat64Translator {
  private readonly bindings6 = new Map<string, Nat64Binding>();
  private readonly bindings4 = new Map<string, Nat64Binding>();
  private readonly sessionsFrom6 = new Map<string, Nat64Session>();
  private readonly sessionsFrom4 = new Map<string, Nat64Session>();
  private readonly pairedAddress = new Map<string, string>();
  private readonly timeouts: Nat64Timeouts;

  constructor(private readonly config: Nat64Config) {
    this.timeouts = { ...NAT64_DEFAULT_TIMEOUTS, ...config.timeouts };
  }

  ownsPoolAddress(address: IPAddress): boolean {
    return this.config.pool.some((candidate) => candidate.equals(address));
  }

  getBindings(): readonly Nat64Binding[] { return [...this.bindings6.values()]; }

  getSessions(): readonly Nat64Session[] { return [...this.sessionsFrom6.values()]; }

  translate6to4(packet: IPv6Packet): Nat64Result<IPv4Packet> {
    const remote = this.config.prefix.extract(packet.destinationIP);
    if (remote === null) {
      return { ok: false, reason: this.config.prefix.contains(packet.destinationIP) ? 'non-global-destination' : 'not-in-prefix' };
    }
    const protocol = protocolOf(packet.nextHeader);
    if (protocol === null) return { ok: false, reason: 'unsupported-protocol' };
    const payload = packet.payload as TCPPacket | UDPPacket | ICMPv6Packet;
    if (payload.type === 'icmpv6' && payload.icmpType !== 'echo-request' && payload.icmpType !== 'echo-reply') {
      return this.translateError6to4(packet, remote, payload);
    }
    const source = this.sourceEndpoint6(packet, payload);
    const destination = { ip: remote.toString(), port: this.destinationPort6(payload) };
    if (source === null) return { ok: false, reason: 'unsupported-icmp' };

    this.purge();
    const binding = this.bindingFor6(protocol, source);
    if (binding === null) return { ok: false, reason: 'pool-exhausted' };
    const session = this.sessionFor6(protocol, packet, source, destination, binding);
    this.advanceTcp(session, payload, 'v6');

    const v4Source = new IPAddress(binding.v4Address);
    const translated = this.translatePayload6to4(payload, binding.v4Port, destination.port);
    const out = createIPv4Packet(v4Source, remote, packet.nextHeader === IP_PROTO_ICMPV6 ? IP_PROTO_ICMP : packet.nextHeader,
      packet.hopLimit, translated, packet.payloadLength,
      { tos: packet.trafficClass, flags: packet.payloadLength + IPV4_HEADER_BYTES > DF_LENGTH_THRESHOLD ? DF : 0 });
    out.payload = translated;
    recomputeL4Checksum(out);
    return { ok: true, packet: out };
  }

  translate4to6(packet: IPv4Packet): Nat64Result<IPv6Packet> {
    const protocol = protocolOf(packet.protocol);
    if (protocol === null) return { ok: false, reason: 'unsupported-protocol' };
    const payload = packet.payload as TCPPacket | UDPPacket | ICMPPacket;
    if (payload.type === 'icmp' && payload.icmpType !== 'echo-request' && payload.icmpType !== 'echo-reply') {
      return this.translateError4to6(packet, payload);
    }
    const remote: Endpoint | null = this.remoteEndpoint4(packet, payload);
    if (remote === null) return { ok: false, reason: 'unsupported-icmp' };
    const local: Endpoint = { ip: packet.destinationIP.toString(), port: this.localPort4(payload) };

    this.purge();
    const binding = this.bindings4.get(bindingKey4(protocol, local));
    if (binding === undefined) return { ok: false, reason: 'no-binding' };
    const session = this.sessionFor4(protocol, binding, remote, payload);
    if (session === null) return { ok: false, reason: 'filtered' };
    this.advanceTcp(session, payload, 'v4');

    const v6Source = this.config.prefix.synthesize(packet.sourceIP);
    const v6Destination = new IPv6Address(binding.v6Address);
    const translated = this.translatePayload4to6(payload, remote.port, binding.v6Port);
    const length = packet.totalLength - packet.ihl * 4;
    const out = createIPv6Packet(v6Source, v6Destination, packet.protocol === IP_PROTO_ICMP ? IP_PROTO_ICMPV6 : packet.protocol,
      packet.ttl, translated, length, { trafficClass: packet.tos });
    recomputeL4Checksum(out);
    return { ok: true, packet: out };
  }

  purge(): void {
    const now = this.config.clock();
    for (const [key, session] of this.sessionsFrom6) {
      if (now - session.lastUsedAt < this.timeoutOf(session)) continue;
      this.sessionsFrom6.delete(key);
      this.sessionsFrom4.delete(sessionKey(session.protocol,
        { ip: session.v4Source, port: session.v4SourcePort }, { ip: session.v4Destination, port: session.v4DestinationPort }));
    }
    for (const [key, binding] of this.bindings6) {
      const held = [...this.sessionsFrom6.values()].some((s) => s.protocol === binding.protocol
        && s.v4Source === binding.v4Address && s.v4SourcePort === binding.v4Port);
      if (held) continue;
      this.bindings6.delete(key);
      this.bindings4.delete(bindingKey4(binding.protocol, { ip: binding.v4Address, port: binding.v4Port }));
    }
  }

  private timeoutOf(session: Nat64Session): number {
    if (session.protocol === 'udp') return this.timeouts.udpMs;
    if (session.protocol === 'icmp') return this.timeouts.icmpMs;
    if (session.tcpState === 'established' || session.tcpState === 'v4-fin-rcv' || session.tcpState === 'v6-fin-rcv') {
      return this.timeouts.tcpEstablishedMs;
    }
    if (session.tcpState === 'v4-init' || session.tcpState === 'v6-init') return this.timeouts.tcpInitialMs;
    return this.timeouts.tcpTransitoryMs;
  }

  private sourceEndpoint6(packet: IPv6Packet, payload: TCPPacket | UDPPacket | ICMPv6Packet): Endpoint | null {
    const ip = packet.sourceIP.toString();
    if (payload.type === 'icmpv6') {
      return payload.icmpType === 'echo-request' ? { ip, port: payload.id ?? 0 } : null;
    }
    return { ip, port: payload.sourcePort };
  }

  private destinationPort6(payload: TCPPacket | UDPPacket | ICMPv6Packet): number {
    return payload.type === 'icmpv6' ? (payload.id ?? 0) : payload.destinationPort;
  }

  private remoteEndpoint4(packet: IPv4Packet, payload: TCPPacket | UDPPacket | ICMPPacket): Endpoint | null {
    const ip = packet.sourceIP.toString();
    if (payload.type === 'icmp') return payload.icmpType === 'echo-reply' ? { ip, port: payload.id } : null;
    return { ip, port: payload.sourcePort };
  }

  private localPort4(payload: TCPPacket | UDPPacket | ICMPPacket): number {
    return payload.type === 'icmp' ? payload.id : payload.destinationPort;
  }

  private bindingFor6(protocol: Nat64Protocol, source: Endpoint): Nat64Binding | null {
    const key = bindingKey6(protocol, source);
    const existing = this.bindings6.get(key);
    if (existing !== undefined) return existing;
    const address = this.addressFor(source.ip, protocol, source.port);
    if (address === null) return null;
    const port = this.portFor(protocol, address, source.port);
    if (port === null) return null;
    const binding: Nat64Binding = { protocol, v6Address: source.ip, v6Port: source.port, v4Address: address, v4Port: port };
    this.bindings6.set(key, binding);
    this.bindings4.set(bindingKey4(protocol, { ip: address, port }), binding);
    this.pairedAddress.set(source.ip, address);
    return binding;
  }

  private addressFor(v6: string, protocol: Nat64Protocol, preferredPort: number): string | null {
    const paired = this.pairedAddress.get(v6);
    const holdsBinding = paired !== undefined && [...this.bindings6.values()].some((b) => b.v6Address === v6);
    if (holdsBinding && this.portFor(protocol, paired, preferredPort) !== null) return paired;
    for (const address of this.config.pool) {
      const text = address.toString();
      if (this.portFor(protocol, text, preferredPort) !== null) return text;
    }
    return null;
  }

  private portFor(protocol: Nat64Protocol, address: string, preferred: number): number | null {
    const free = (port: number) => !this.bindings4.has(bindingKey4(protocol, { ip: address, port }));
    if (preferred >= 1 && preferred <= 65535 && free(preferred)) return preferred;
    const [low, high] = preferred < WELL_KNOWN_CEILING ? [1, WELL_KNOWN_CEILING - 1]
      : preferred < LOW_PORT_CEILING ? [WELL_KNOWN_CEILING, LOW_PORT_CEILING - 1] : [LOW_PORT_CEILING, 65535];
    for (let port = low; port <= high; port++) if (free(port)) return port;
    return null;
  }

  private sessionFor6(
    protocol: Nat64Protocol, packet: IPv6Packet, source: Endpoint, destination: Endpoint, binding: Nat64Binding,
  ): Nat64Session {
    const v4Destination = { ip: destination.ip, port: destination.port };
    const v4Source = { ip: binding.v4Address, port: binding.v4Port };
    const key = sessionKey(protocol, source, { ip: packet.destinationIP.toString(), port: destination.port });
    const existing = this.sessionsFrom6.get(key);
    if (existing !== undefined) return existing;
    const now = this.config.clock();
    const session: Nat64Session = {
      protocol,
      v6Source: source.ip, v6SourcePort: source.port,
      v6Destination: packet.destinationIP.toString(), v6DestinationPort: destination.port,
      v4Source: v4Source.ip, v4SourcePort: v4Source.port,
      v4Destination: v4Destination.ip, v4DestinationPort: v4Destination.port,
      createdAt: now, lastUsedAt: now,
      ...(protocol === 'tcp' ? { tcpState: 'v6-init' as const } : {}),
    };
    this.sessionsFrom6.set(key, session);
    this.sessionsFrom4.set(sessionKey(protocol, v4Source, v4Destination), session);
    return session;
  }

  private sessionFor4(
    protocol: Nat64Protocol, binding: Nat64Binding, remote: Endpoint, payload: TCPPacket | UDPPacket | ICMPPacket,
  ): Nat64Session | null {
    const local = { ip: binding.v4Address, port: binding.v4Port };
    const existing = this.sessionsFrom4.get(sessionKey(protocol, local, remote));
    if (existing !== undefined) return existing;
    const knowsRemote = [...this.sessionsFrom6.values()].find((s) => s.protocol === protocol
      && s.v4Source === binding.v4Address && s.v4SourcePort === binding.v4Port && s.v4Destination === remote.ip);
    if (knowsRemote === undefined) return null;
    if (protocol === 'tcp' && !(payload as TCPPacket).flags.syn) return null;
    const now = this.config.clock();
    const v6Destination = this.config.prefix.synthesize(new IPAddress(remote.ip)).toString();
    const session: Nat64Session = {
      protocol,
      v6Source: binding.v6Address, v6SourcePort: binding.v6Port,
      v6Destination, v6DestinationPort: remote.port,
      v4Source: local.ip, v4SourcePort: local.port,
      v4Destination: remote.ip, v4DestinationPort: remote.port,
      createdAt: now, lastUsedAt: now,
      ...(protocol === 'tcp' ? { tcpState: 'v4-init' as const } : {}),
    };
    this.sessionsFrom6.set(sessionKey(protocol, { ip: binding.v6Address, port: binding.v6Port }, { ip: v6Destination, port: remote.port }), session);
    this.sessionsFrom4.set(sessionKey(protocol, local, remote), session);
    return session;
  }

  private advanceTcp(session: Nat64Session, payload: unknown, side: 'v4' | 'v6'): void {
    session.lastUsedAt = this.config.clock();
    if (session.protocol !== 'tcp') return;
    const flags = (payload as TCPPacket).flags;
    if (flags.rst) { session.tcpState = 'trans'; return; }
    const state = session.tcpState;
    if (flags.syn && ((state === 'v6-init' && side === 'v4') || (state === 'v4-init' && side === 'v6'))) {
      session.tcpState = 'established';
    } else if (flags.fin) {
      if (state === 'established') session.tcpState = side === 'v4' ? 'v4-fin-rcv' : 'v6-fin-rcv';
      else if ((state === 'v4-fin-rcv' && side === 'v6') || (state === 'v6-fin-rcv' && side === 'v4')) {
        session.tcpState = 'v6-fin-v4-fin-rcv';
      }
    } else if (state === 'v6-fin-v4-fin-rcv') {
      session.tcpState = 'trans';
    }
  }

  private translateError6to4(packet: IPv6Packet, remote: IPAddress, icmp: ICMPv6Packet): Nat64Result<IPv4Packet> {
    const invoking = icmp.invokingPacket;
    const mapped = this.errorToV4(icmp, invoking?.destinationIP, remote);
    if (mapped === null || invoking === undefined) return { ok: false, reason: 'unsupported-icmp' };
    const original = this.embedded6to4(invoking);
    if (original === null) return { ok: false, reason: 'no-binding' };
    const payload: ICMPPacket = {
      type: 'icmp', icmpType: mapped.type, code: mapped.code, id: 0, sequence: 0, dataSize: 0,
      originalPacket: original.packet, ...(mapped.mtu === undefined ? {} : { mtu: mapped.mtu }),
      ...(mapped.pointer === undefined ? {} : { pointer: mapped.pointer }),
    };
    const out = createIPv4Packet(new IPAddress(original.binding.v4Address), remote, IP_PROTO_ICMP, packet.hopLimit, payload,
      ICMP_ERROR_HEADER_BYTES + original.packet.totalLength,
      { tos: packet.trafficClass, flags: ICMP_ERROR_HEADER_BYTES + original.packet.totalLength + IPV4_HEADER_BYTES > DF_LENGTH_THRESHOLD ? DF : 0 });
    return { ok: true, packet: out };
  }

  private translateError4to6(packet: IPv4Packet, icmp: ICMPPacket): Nat64Result<IPv6Packet> {
    const original = icmp.originalPacket;
    if (original === undefined) return { ok: false, reason: 'unsupported-icmp' };
    const embedded = this.embedded4to6(original);
    if (embedded === null) return { ok: false, reason: 'no-binding' };
    const mapped = this.errorToV6(icmp, original.destinationIP, new IPv6Address(embedded.binding.v6Address));
    if (mapped === null) return { ok: false, reason: 'unsupported-icmp' };
    const payload: ICMPv6Packet = {
      type: 'icmpv6', icmpType: mapped.type, code: mapped.code, invokingPacket: embedded.packet,
      ...(mapped.mtu === undefined ? {} : { mtu: mapped.mtu }),
      ...(mapped.pointer === undefined ? {} : { pointer: mapped.pointer }),
    };
    const out = createIPv6Packet(this.config.prefix.synthesize(packet.sourceIP), new IPv6Address(embedded.binding.v6Address),
      IP_PROTO_ICMPV6, packet.ttl, payload, ICMP_ERROR_HEADER_BYTES + IPV6_HEADER_BYTES + embedded.packet.payloadLength,
      { trafficClass: packet.tos });
    return { ok: true, packet: out };
  }

  private errorToV4(icmp: ICMPv6Packet, v6Hop: IPv6Address | undefined, v4Sender: IPAddress): { type: ICMPType; code: number; mtu?: number; pointer?: number } | null {
    if (icmp.icmpType === 'packet-too-big') {
      const nexthop = this.config.nexthopMtu;
      const v4Mtu = nexthop?.ipv4(v4Sender);
      const v6Mtu = v6Hop === undefined ? undefined : nexthop?.ipv6(v6Hop);
      const candidates = [(icmp.mtu ?? IPV6_MINIMUM_MTU) - HEADER_GROWTH];
      if (v4Mtu !== undefined) candidates.push(v4Mtu);
      if (v6Mtu !== undefined) candidates.push(v6Mtu - HEADER_GROWTH);
      return { type: 'destination-unreachable', code: 4, mtu: Math.min(...candidates) };
    }
    if (icmp.icmpType === 'time-exceeded') return { type: 'time-exceeded', code: icmp.code };
    if (icmp.icmpType === 'destination-unreachable') {
      const code = V6_UNREACHABLE_TO_V4[icmp.code];
      return code === undefined ? null : { type: 'destination-unreachable', code };
    }
    if (icmp.icmpType === 'parameter-problem' && icmp.code === 1) return { type: 'destination-unreachable', code: 2 };
    if (icmp.icmpType === 'parameter-problem' && icmp.code === 0) {
      const pointer = V6_POINTER_TO_V4[icmp.pointer ?? -1];
      return pointer === undefined ? null : { type: 'parameter-problem', code: 0, pointer };
    }
    return null;
  }

  private errorToV6(icmp: ICMPPacket, v4Hop: IPAddress | undefined, v6Host: IPv6Address): { type: ICMPv6Type; code: number; mtu?: number; pointer?: number } | null {
    if (icmp.icmpType === 'time-exceeded') return { type: 'time-exceeded', code: icmp.code };
    if (icmp.icmpType === 'parameter-problem') {
      const pointer = V4_POINTER_TO_V6[icmp.pointer ?? -1];
      return (icmp.code === 0 || icmp.code === 2) && pointer !== undefined ? { type: 'parameter-problem', code: 0, pointer } : null;
    }
    if (icmp.icmpType !== 'destination-unreachable') return null;
    if (icmp.code === 4) {
      const known = icmp.mtu !== undefined && icmp.mtu > 0 ? icmp.mtu : this.plateauBelow(icmp.originalPacket?.totalLength ?? 0);
      const nexthop = this.config.nexthopMtu;
      const v4Mtu = v4Hop === undefined ? undefined : nexthop?.ipv4(v4Hop);
      const candidates = [known + HEADER_GROWTH];
      if (v6Host !== undefined) {
        const v6Mtu = nexthop?.ipv6(v6Host);
        if (v6Mtu !== undefined) candidates.push(v6Mtu);
      }
      if (v4Mtu !== undefined) candidates.push(v4Mtu + HEADER_GROWTH);
      return { type: 'packet-too-big', code: 0, mtu: Math.max(IPV6_MINIMUM_MTU, Math.min(...candidates)) };
    }
    return V4_UNREACHABLE_TO_V6[icmp.code] ?? null;
  }

  private plateauBelow(totalLength: number): number {
    return MTU_PLATEAUS.find((plateau) => plateau < totalLength && plateau >= IPV6_MINIMUM_MTU) ?? IPV6_MINIMUM_MTU;
  }

  private embedded4to6(original: IPv4Packet): { packet: IPv6Packet; binding: Nat64Binding } | null {
    const protocol = protocolOf(original.protocol);
    if (protocol === null) return null;
    const inner = original.payload as TCPPacket | UDPPacket | ICMPPacket;
    const port = inner.type === 'icmp' ? inner.id : inner.sourcePort;
    const binding = this.bindings4.get(bindingKey4(protocol, { ip: original.sourceIP.toString(), port }));
    if (binding === undefined) return null;
    const payload = inner.type === 'icmp'
      ? { type: 'icmpv6', icmpType: 'echo-request', code: 0, id: binding.v6Port, sequence: inner.sequence, dataSize: inner.dataSize } as ICMPv6Packet
      : { ...inner, sourcePort: binding.v6Port };
    const packet = createIPv6Packet(new IPv6Address(binding.v6Address), this.config.prefix.synthesize(original.destinationIP),
      original.protocol === IP_PROTO_ICMP ? IP_PROTO_ICMPV6 : original.protocol, original.ttl, payload,
      original.totalLength - original.ihl * 4, { trafficClass: original.tos });
    recomputeL4Checksum(packet);
    return { packet, binding };
  }

  private embedded6to4(invoking: IPv6Packet): { packet: IPv4Packet; binding: Nat64Binding } | null {
    const protocol = protocolOf(invoking.nextHeader);
    const remote = this.config.prefix.extract(invoking.sourceIP);
    if (protocol === null || remote === null) return null;
    const inner = invoking.payload as TCPPacket | UDPPacket | ICMPv6Packet;
    const port = inner.type === 'icmpv6' ? (inner.id ?? 0) : inner.destinationPort;
    const binding = this.bindings6.get(bindingKey6(protocol, { ip: invoking.destinationIP.toString(), port }));
    if (binding === undefined) return null;
    const payload = inner.type === 'icmpv6'
      ? { type: 'icmp', icmpType: 'echo-reply', code: 0, id: binding.v4Port, sequence: inner.sequence ?? 0, dataSize: inner.dataSize ?? 56 } as ICMPPacket
      : { ...inner, destinationPort: binding.v4Port };
    const packet = createIPv4Packet(remote, new IPAddress(binding.v4Address),
      invoking.nextHeader === IP_PROTO_ICMPV6 ? IP_PROTO_ICMP : invoking.nextHeader, invoking.hopLimit, payload,
      invoking.payloadLength, { tos: invoking.trafficClass, flags: invoking.payloadLength + IPV4_HEADER_BYTES > DF_LENGTH_THRESHOLD ? DF : 0 });
    recomputeL4Checksum(packet);
    return { packet, binding };
  }

  private translatePayload6to4(payload: TCPPacket | UDPPacket | ICMPv6Packet, sourcePort: number, destinationPort: number): unknown {
    if (payload.type === 'icmpv6') {
      const echo: ICMPPacket = {
        type: 'icmp', icmpType: 'echo-request', code: 0, id: sourcePort,
        sequence: payload.sequence ?? 0, dataSize: payload.dataSize ?? 56,
      };
      return echo;
    }
    return { ...payload, sourcePort, destinationPort };
  }

  private translatePayload4to6(payload: TCPPacket | UDPPacket | ICMPPacket, sourcePort: number, destinationPort: number): unknown {
    if (payload.type === 'icmp') {
      const echo: ICMPv6Packet = {
        type: 'icmpv6', icmpType: 'echo-reply', code: 0, id: destinationPort,
        sequence: payload.sequence, dataSize: payload.dataSize,
      };
      return echo;
    }
    return { ...payload, sourcePort, destinationPort };
  }
}
