import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import type { EndHost } from '@/network/devices/EndHost';
import { Cable } from '@/network/hardware/Cable';
import { Port } from '@/network/hardware/Port';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import {
  IPAddress, IPv6Address, SubnetMask, MACAddress, createIPv4Packet, createIPv6Packet, resetCounters,
  ETHERTYPE_IPV4, ETHERTYPE_IPV6, IP_PROTO_TCP, IP_PROTO_UDP, IP_PROTO_ICMP, IP_PROTO_ICMPV6,
  type EthernetFrame, type IPv4Packet, type IPv6Packet, type ICMPPacket, type ICMPType,
  type ICMPv6Packet, type ICMPv6Type,
} from '@/network/core/types';
import {
  computeTcpChecksum, noFlags, type TcpFlags, type TcpOption, type TcpSegment,
} from '@/network/tcp/types';
import { optionsDataOffset } from '@/network/tcp/TcpOptionsCodec';
import { payloadBytes } from '@/network/layers/transport/L4Checksum';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EcnCodepoint } from '@/network/core/IpHeaderFields';
import type { TcpSocket, TcpListenOptions, TcpConnectOptions } from '@/network/tcp/TcpStack';

export const DUT_ADDRESS = '10.0.0.1';
export const PEER_ADDRESS = '10.0.0.2';
export const DUT_ADDRESS_V6 = '2001:db8::1';
export const PEER_ADDRESS_V6 = '2001:db8::2';
export const PEER_PORT = 40000;

export type PeerFamily = 'ipv4' | 'ipv6';

const FLAG_LETTERS: Readonly<Record<string, keyof TcpFlags>> = {
  F: 'fin', S: 'syn', R: 'rst', P: 'psh', A: 'ack', U: 'urg', E: 'ece', C: 'cwr',
};

export function flagsFrom(letters: string): TcpFlags {
  const flags = noFlags();
  for (const letter of letters) flags[FLAG_LETTERS[letter]] = true;
  return flags;
}

export function lettersOf(flags: TcpFlags): string {
  return Object.entries(FLAG_LETTERS)
    .filter(([, name]) => flags[name])
    .map(([letter]) => letter)
    .join('');
}

export function sackBlocksOf(segment: TcpSegment): ReadonlyArray<{ start: number; end: number }> {
  const option = segment.options.find(
    (o): o is Extract<TcpOption, { kind: 'sack' }> => o.kind === 'sack');
  return option?.blocks ?? [];
}

export interface PeerSegment {
  flags: string;
  sequence: number;
  acknowledgement?: number;
  window?: number;
  payload?: string;
  options?: TcpOption[];
  urgentPointer?: number;
  destinationPort?: number;
  sourcePort?: number;
  sourceAddress?: string;
  destinationAddress?: string;
  ttl?: number;
  ecn?: EcnCodepoint;
}

export interface ScriptedPeer {
  readonly dut: EndHost;
  readonly bus: EventBus;
  readonly clock: VirtualTimeScheduler;
  readonly family: PeerFamily;
  readonly addresses: { readonly dut: string; readonly peer: string };
  readonly frames: EthernetFrame[];
  readonly replies: TcpSegment[];
  readonly icmpReplies: ICMPPacket[];
  readonly icmpv6Replies: ICMPv6Packet[];
  readonly ports: { dut: number; peer: number };
  send(spec: PeerSegment): void;
  sendIpv4(packet: IPv4Packet): void;
  sendIpv6(packet: IPv6Packet): void;
  sendIcmpError(icmpType: ICMPType, code: number, offending: TcpSegment, mtu?: number): void;
  sendIcmpv6Error(icmpType: ICMPv6Type, code: number, offending: TcpSegment, mtu?: number): void;
  sendIcmpv6ErrorQuoting(icmpType: ICMPv6Type, code: number, invoking: IPv6Packet, mtu?: number): void;
  udpDatagrams(): IPv6Packet[];
  respond(handler: ((segment: TcpSegment) => void) | null): void;
  ecnOf(segment: TcpSegment): EcnCodepoint;
  take(): TcpSegment[];
  last(): TcpSegment | undefined;
  clear(): void;
  advance(ms: number): void;
}

export function scriptedPeer(
  platform: 'linux' | 'windows' = 'linux', family: PeerFamily = 'ipv4',
): ScriptedPeer {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  const bus = new EventBus();
  const clock = new VirtualTimeScheduler();
  const dut = platform === 'windows' ? new WindowsPC('windows-pc', 'DUT') : new LinuxPC('DUT');
  dut.setEventBus(bus);
  dut.powerOn();
  dut.setScheduler(clock);
  const port = new Port('eth0', 'ethernet');
  port.setEquipmentId('PEER');
  const cable = new Cable('scripted');
  cable.setEventBus(bus);
  cable.connect(dut.getPort('eth0')!, port);
  const addresses = family === 'ipv6'
    ? { dut: DUT_ADDRESS_V6, peer: PEER_ADDRESS_V6 }
    : { dut: DUT_ADDRESS, peer: PEER_ADDRESS };
  if (family === 'ipv6') {
    dut.configureIPv6Interface('eth0', new IPv6Address(DUT_ADDRESS_V6), 64);
    dut.addStaticNeighbor6(new IPv6Address(PEER_ADDRESS_V6), port.getMAC(), 'eth0');
  } else {
    dut.getPort('eth0')!.configureIP(new IPAddress(DUT_ADDRESS), new SubnetMask('255.255.255.0'));
    dut.addStaticARP(new IPAddress(PEER_ADDRESS), port.getMAC(), 'eth0');
  }

  const frames: EthernetFrame[] = [];
  const replies: TcpSegment[] = [];
  const icmpReplies: ICMPPacket[] = [];
  const icmpv6Replies: ICMPv6Packet[] = [];
  let responder: ((segment: TcpSegment) => void) | null = null;
  const ecnOfReply = new WeakMap<TcpSegment, EcnCodepoint>();
  port.onFrame((_name, frame) => {
    frames.push(frame);
    if (frame.etherType === ETHERTYPE_IPV6) {
      const packet = frame.payload as IPv6Packet;
      if (packet.nextHeader === IP_PROTO_ICMPV6) icmpv6Replies.push(packet.payload as ICMPv6Packet);
      if (packet.nextHeader !== IP_PROTO_TCP) return;
      const segment = packet.payload as TcpSegment;
      ecnOfReply.set(segment, EcnCodepoint.ofField(packet.trafficClass));
      replies.push(segment);
      responder?.(segment);
      return;
    }
    if (frame.etherType !== ETHERTYPE_IPV4) return;
    const packet = frame.payload as IPv4Packet;
    if (packet.protocol === IP_PROTO_ICMP) icmpReplies.push(packet.payload as ICMPPacket);
    if (packet.protocol !== IP_PROTO_TCP) return;
    const segment = packet.payload as TcpSegment;
    ecnOfReply.set(segment, EcnCodepoint.ofField(packet.tos));
    replies.push(segment);
    responder?.(segment);
  });

  const emitFrame = (etherType: number, packet: IPv4Packet | IPv6Packet): void => {
    port.sendFrame({
      srcMAC: port.getMAC(), dstMAC: dut.getPort('eth0')!.getMAC(), etherType, payload: packet,
    } as EthernetFrame);
  };
  const emit = (packet: IPv4Packet): void => emitFrame(ETHERTYPE_IPV4, packet);
  const emit6 = (packet: IPv6Packet): void => emitFrame(ETHERTYPE_IPV6, packet);

  const ports = { dut: 4000, peer: PEER_PORT };

  const send = (spec: PeerSegment): void => {
    const options = spec.options ?? [];
    const seg: TcpSegment = {
      type: 'tcp',
      sourcePort: spec.sourcePort ?? ports.peer,
      destinationPort: spec.destinationPort ?? ports.dut,
      sequence: spec.sequence >>> 0,
      acknowledgement: (spec.acknowledgement ?? 0) >>> 0,
      dataOffset: optionsDataOffset(options),
      flags: flagsFrom(spec.flags),
      window: spec.window ?? 65535,
      checksum: 0,
      urgentPointer: spec.urgentPointer ?? 0,
      options,
      payload: spec.payload,
    };
    const source = spec.sourceAddress ?? addresses.peer;
    const destination = spec.destinationAddress ?? addresses.dut;
    seg.checksum = computeTcpChecksum(seg, source, destination);
    const size = seg.dataOffset * 4 + payloadBytes(seg.payload).length;
    const ecn = spec.ecn ?? EcnCodepoint.NOT_ECT;
    if (family === 'ipv6') {
      emit6({
        ...createIPv6Packet(
          new IPv6Address(source), new IPv6Address(destination), IP_PROTO_TCP, spec.ttl ?? 64, seg, size),
        trafficClass: ecn.bits,
      });
      return;
    }
    emit(createIPv4Packet(
      new IPAddress(source), new IPAddress(destination), IP_PROTO_TCP, spec.ttl ?? 64, seg, size,
      { tos: ecn.bits }));
  };

  const sendIcmpError = (icmpType: ICMPType, code: number, offending: TcpSegment, mtu?: number): void => {
    const original = createIPv4Packet(
      new IPAddress(DUT_ADDRESS), new IPAddress(PEER_ADDRESS), IP_PROTO_TCP, 64, offending,
      offending.dataOffset * 4);
    const icmp: ICMPPacket = {
      type: 'icmp', icmpType, code, id: 0, sequence: 0, dataSize: 28, originalPacket: original,
      ...(mtu === undefined ? {} : { mtu }),
    };
    emit(createIPv4Packet(
      new IPAddress(PEER_ADDRESS), new IPAddress(DUT_ADDRESS), IP_PROTO_ICMP, 64, icmp, 8 + 28));
  };

  const sendIcmpv6ErrorQuoting = (
    icmpType: ICMPv6Type, code: number, invoking: IPv6Packet, mtu?: number,
  ): void => {
    const icmp: ICMPv6Packet = {
      type: 'icmpv6', icmpType, code, invokingPacket: invoking, ...(mtu === undefined ? {} : { mtu }),
    };
    emit6(createIPv6Packet(
      new IPv6Address(PEER_ADDRESS_V6), new IPv6Address(DUT_ADDRESS_V6), IP_PROTO_ICMPV6, 64, icmp, 48));
  };

  const sendIcmpv6Error = (icmpType: ICMPv6Type, code: number, offending: TcpSegment, mtu?: number): void => {
    sendIcmpv6ErrorQuoting(icmpType, code, createIPv6Packet(
      new IPv6Address(DUT_ADDRESS_V6), new IPv6Address(PEER_ADDRESS_V6), IP_PROTO_TCP, 64, offending,
      offending.dataOffset * 4 + payloadBytes(offending.payload).length), mtu);
  };

  const udpDatagrams = (): IPv6Packet[] => frames
    .filter((frame) => frame.etherType === ETHERTYPE_IPV6)
    .map((frame) => frame.payload as IPv6Packet)
    .filter((packet) => packet.nextHeader === IP_PROTO_UDP);

  return {
    dut, bus, clock, family, addresses, frames, replies, icmpReplies, icmpv6Replies, ports, send,
    sendIpv4: emit, sendIpv6: emit6, sendIcmpError, sendIcmpv6Error, sendIcmpv6ErrorQuoting, udpDatagrams,
    respond: (handler) => { responder = handler; },
    ecnOf: (segment) => ecnOfReply.get(segment) ?? EcnCodepoint.NOT_ECT,
    take: () => replies.splice(0, replies.length),
    last: () => replies[replies.length - 1],
    clear: () => { replies.length = 0; icmpReplies.length = 0; icmpv6Replies.length = 0; },
    advance: (ms) => clock.advance(ms),
  };
}

export const PEER_ISN = 7_000_000;

export interface OpenConnection {
  readonly socket: TcpSocket;
  readonly dutIsn: number;
  readonly peerIsn: number;
}

export function openPassive(
  peer: ScriptedPeer, synOptions: TcpOption[] = [], peerIsn = PEER_ISN, window = 65535,
  listenOptions: Omit<TcpListenOptions, 'onAccept'> = {}, synFlags = 'S',
): OpenConnection {
  const accepted: TcpSocket[] = [];
  peer.dut.getTcpStack().listen(peer.ports.dut, {
    ...listenOptions, onAccept: (socket) => { accepted.push(socket); },
  });
  peer.send({ flags: synFlags, sequence: peerIsn, options: synOptions, window });
  const synAck = peer.last()!;
  peer.send({ flags: 'A', sequence: peerIsn + 1, acknowledgement: synAck.sequence + 1, window });
  peer.clear();
  return { socket: accepted[0], dutIsn: synAck.sequence, peerIsn };
}

export function openActive(
  peer: ScriptedPeer, synAckOptions: TcpOption[] = [], peerIsn = PEER_ISN, window = 65535,
  connectOptions: TcpConnectOptions = {}, synAckFlags = 'SA',
): OpenConnection {
  const socket = peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer, connectOptions)!;
  const syn = peer.last()!;
  peer.ports.dut = syn.sourcePort;
  peer.send({
    flags: synAckFlags, sequence: peerIsn, acknowledgement: syn.sequence + 1, options: synAckOptions, window,
  });
  peer.clear();
  return { socket, dutIsn: syn.sequence, peerIsn };
}
