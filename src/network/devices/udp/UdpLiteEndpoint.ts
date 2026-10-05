import {
  IPAddress, IPv6Address, IP_PROTO_UDPLITE, createIPv4Packet, createIPv6Packet,
  type IPv4Option, type IPv4Packet, type IPv6Packet, type UDPLitePacket,
} from '@/network/core/types';
import { IPV4_FLAG_DF } from '@/network/core/Ipv4Fragmentation';
import { isMulticastIpv4 } from '@/network/core/ip';
import { Logger } from '@/network/core/Logger';
import { PORT_ANY } from '@/network/core/ports/PortNumber';
import type { SocketTable } from '@/network/core/SocketTable';
import type { DiffServField, TimeToLive } from '@/network/core/IpHeaderFields';
import type { ProtocolCounters } from '@/network/layers/internet/ProtocolCounters';
import { ChecksumCoverage } from '@/network/layers/transport/ChecksumCoverage';
import { stampUdpLiteChecksum } from '@/network/layers/transport/UdpChecksum';
import {
  UDPLITE_MAX_IP_PAYLOAD, buildUdpLiteDatagram, udpLiteIpPayloadLength,
} from '@/network/layers/transport/UdpLiteEgress';
import { acceptUdpLiteDatagram, admitsCoverage } from '@/network/layers/transport/UdpLiteInput';

const IPV4_HEADER_BYTES = 20;
const LIMITED_BROADCAST = '255.255.255.255';

export interface UdpLiteDelivery {
  readonly inPort: string;
  readonly sourceIP: IPAddress | IPv6Address;
  readonly destinationIP: IPAddress | IPv6Address;
  readonly udp: UDPLitePacket;
  readonly coverage: number;
  readonly sourceMAC?: string;
  readonly ipOptions?: readonly IPv4Option[];
}

export type UdpLiteListener = (delivery: UdpLiteDelivery) => void;

export interface UdpLiteBindOptions {
  readonly processName?: string;
  readonly pid?: number;
  readonly uid?: number;
  readonly minimumCoverage?: ChecksumCoverage;
}

export interface UdpLiteSend {
  readonly destination: IPAddress | IPv6Address;
  readonly destinationPort: number;
  readonly sourcePort: number;
  readonly payload: unknown;
  readonly payloadBytes?: number;
  readonly checksumCoverage?: ChecksumCoverage;
  readonly source?: IPAddress;
  readonly iface?: string;
  readonly ttl?: TimeToLive;
  readonly diffServ?: DiffServField;
  readonly dontFragment?: boolean;
  readonly ipOptions?: readonly IPv4Option[];
}

export interface UdpLiteHost {
  readonly id: string;
  readonly name: string;
  readonly counters: ProtocolCounters;
  readonly socketTable: SocketTable;
  defaultTtl(): number;
  defaultHopLimit(): number;
  isLocalAddress(address: IPAddress): boolean;
  isLocalAddress6(address: IPv6Address): boolean;
  hasInvalidSource(packet: IPv4Packet): boolean;
  emitIpv4(
    destination: IPAddress, build: (source: IPAddress) => IPv4Packet,
    route: { iface?: string; source?: IPAddress },
  ): boolean;
  emitIpv4ToGroup(
    group: IPAddress, build: (source: IPAddress, ttl: number) => IPv4Packet, iface?: string,
  ): boolean;
  emitIpv6(destination: IPv6Address, build: (source: IPv6Address) => IPv6Packet): boolean;
  emitIpv6ToGroup(
    group: IPv6Address, payload: UDPLitePacket, payloadLength: number, iface?: string,
  ): boolean;
  replyPortUnreachable(portName: string, offending: IPv4Packet): void;
  replyPortUnreachable6(portName: string, offending: IPv6Packet): void;
}

interface UdpLiteBinding {
  readonly listener: UdpLiteListener;
  readonly minimumCoverage: ChecksumCoverage;
}

type Dispatch = 'delivered' | 'no-socket' | 'below-minimum-coverage';

export class UdpLiteEndpoint {
  private readonly bindings = new Map<number, UdpLiteBinding>();

  constructor(private readonly host: UdpLiteHost) {}

  bind(port: number, listener: UdpLiteListener, options: UdpLiteBindOptions = {}): number | false {
    const table = this.host.socketTable;
    let bound: number;
    try {
      bound = port === PORT_ANY ? table.allocateEphemeralPort() : port;
      table.bind('udplite', '0.0.0.0', bound, options.pid, options.processName, undefined,
        options.uid === undefined ? undefined : { ownerUid: options.uid });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('EADDRINUSE')) return false;
      throw error;
    }
    this.bindings.set(bound, {
      listener, minimumCoverage: options.minimumCoverage ?? ChecksumCoverage.FULL,
    });
    return bound;
  }

  close(port: number): void {
    this.bindings.delete(port);
    this.host.socketTable.unbind('udplite', '0.0.0.0', port);
  }

  setMinimumCoverage(port: number, minimum: ChecksumCoverage): boolean {
    const binding = this.bindings.get(port);
    if (!binding) return false;
    this.bindings.set(port, { listener: binding.listener, minimumCoverage: minimum });
    return true;
  }

  send(request: UdpLiteSend): boolean {
    const length = udpLiteIpPayloadLength(request.payload, request.payloadBytes ?? 0);
    return request.destination instanceof IPAddress
      ? this.send4(request.destination, request, length)
      : this.send6(request.destination, request, length);
  }

  private send4(destination: IPAddress, request: UdpLiteSend, length: number): boolean {
    if (length > UDPLITE_MAX_IP_PAYLOAD - IPV4_HEADER_BYTES) return false;
    const base = buildUdpLiteDatagram(
      request.sourcePort, request.destinationPort, request.payload, request.checksumCoverage, length);
    const packetFrom = (source: IPAddress, ttl: number): IPv4Packet => createIPv4Packet(
      source, destination, IP_PROTO_UDPLITE, ttl,
      stampUdpLiteChecksum(base, length, source.toString(), destination.toString()), length,
      {
        flags: request.dontFragment === true ? IPV4_FLAG_DF : 0,
        ...(request.diffServ === undefined ? {} : { tos: request.diffServ.value }),
        ...(request.ipOptions === undefined ? {} : { ipOptions: [...request.ipOptions] }),
      });
    const ttl = request.ttl?.value ?? this.host.defaultTtl();

    if (this.host.isLocalAddress(destination)) {
      this.receive4('lo', packetFrom(destination, this.host.defaultTtl()), false);
      return true;
    }
    if (isMulticastIpv4(destination.toString()) || destination.toString() === LIMITED_BROADCAST) {
      return this.host.emitIpv4ToGroup(
        destination, (source, groupTtl) => packetFrom(source, request.ttl?.value ?? groupTtl), request.iface);
    }
    return this.host.emitIpv4(
      destination, (source) => packetFrom(source, ttl), { iface: request.iface, source: request.source });
  }

  private send6(destination: IPv6Address, request: UdpLiteSend, length: number): boolean {
    if (length > UDPLITE_MAX_IP_PAYLOAD) return false;
    const base = buildUdpLiteDatagram(
      request.sourcePort, request.destinationPort, request.payload, request.checksumCoverage, length);
    const packetFrom = (source: IPv6Address, hopLimit: number): IPv6Packet => createIPv6Packet(
      source, destination, IP_PROTO_UDPLITE, hopLimit,
      stampUdpLiteChecksum(base, length, source.toString(), destination.toString()), length);
    const hopLimit = request.ttl?.value ?? this.host.defaultHopLimit();

    if (this.host.isLocalAddress6(destination)) {
      this.receive6('lo', packetFrom(destination, this.host.defaultHopLimit()));
      return true;
    }
    if (destination.isMulticast()) {
      return this.host.emitIpv6ToGroup(destination, base, length, request.iface);
    }
    return this.host.emitIpv6(destination, (source) => packetFrom(source, hopLimit));
  }

  receive4(portName: string, packet: IPv4Packet, wasBroadcast: boolean, sourceMac?: string): void {
    const udp = packet.payload as UDPLitePacket;
    if (!udp || udp.type !== 'udplite') return;
    const counters = this.host.counters;

    if (portName !== 'lo' && this.host.hasInvalidSource(packet)) {
      counters.ipInAddrErrors++;
      Logger.warn(this.host.id, 'udplite:invalid-source',
        `${this.host.name}: invalid source ${packet.sourceIP} for UDP-Lite to ${packet.destinationIP}, dropping`);
      return;
    }

    const available = packet.totalLength - packet.ihl * 4;
    const verdict = acceptUdpLiteDatagram(udp, {
      source: packet.sourceIP.toString(), destination: packet.destinationIP.toString(),
      availableBytes: available,
    });
    if (verdict.accepted === false) {
      counters.udpLiteInErrors++;
      if (verdict.refusal !== 'short-datagram') counters.udpLiteInCsumErrors++;
      Logger.warn(this.host.id, `udplite:${verdict.refusal}`,
        `${this.host.name}: ${verdict.refusal} from ${packet.sourceIP}:${udp.sourcePort}, dropping`);
      return;
    }

    switch (this.dispatch({
      inPort: portName, sourceIP: packet.sourceIP, destinationIP: packet.destinationIP,
      udp: verdict.datagram, coverage: verdict.coverage,
      ...(sourceMac === undefined ? {} : { sourceMAC: sourceMac }),
      ...(packet.options === undefined ? {} : { ipOptions: packet.options }),
    }, available)) {
      case 'delivered':
        counters.udpLiteInDatagrams++;
        return;
      case 'below-minimum-coverage':
        counters.udpLiteInErrors++;
        return;
      case 'no-socket':
        counters.udpLiteNoPorts++;
        if (!wasBroadcast) this.host.replyPortUnreachable(portName, packet);
        return;
    }
  }

  receive6(portName: string, packet: IPv6Packet, sourceMac?: string): void {
    const udp = packet.payload as UDPLitePacket;
    if (!udp || udp.type !== 'udplite') return;
    const counters = this.host.counters;

    const verdict = acceptUdpLiteDatagram(udp, {
      source: packet.sourceIP.toString(), destination: packet.destinationIP.toString(),
      availableBytes: packet.payloadLength,
    });
    if (verdict.accepted === false) {
      counters.udpLiteInErrors++;
      if (verdict.refusal !== 'short-datagram') counters.udpLiteInCsumErrors++;
      Logger.warn(this.host.id, `udplite6:${verdict.refusal}`,
        `${this.host.name}: ${verdict.refusal} over IPv6, dropping`);
      return;
    }

    switch (this.dispatch({
      inPort: portName, sourceIP: packet.sourceIP, destinationIP: packet.destinationIP,
      udp: verdict.datagram, coverage: verdict.coverage,
      ...(sourceMac === undefined ? {} : { sourceMAC: sourceMac }),
    }, packet.payloadLength)) {
      case 'delivered':
        counters.udpLiteInDatagrams++;
        return;
      case 'below-minimum-coverage':
        counters.udpLiteInErrors++;
        return;
      case 'no-socket':
        counters.udpLiteNoPorts++;
        this.host.replyPortUnreachable6(portName, packet);
        return;
    }
  }

  private dispatch(delivery: UdpLiteDelivery, datagramBytes: number): Dispatch {
    const port = delivery.udp.destinationPort;
    const binding = this.bindings.get(port);
    if (!binding) return 'no-socket';
    if (!this.host.socketTable.isPortBound(port, 'udplite')) {
      this.bindings.delete(port);
      return 'no-socket';
    }
    if (!admitsCoverage(binding.minimumCoverage, delivery.coverage, datagramBytes)) {
      return 'below-minimum-coverage';
    }
    binding.listener(delivery);
    return 'delivered';
  }
}
