import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import type { EndHost } from '@/network/devices/EndHost';
import { Cable } from '@/network/hardware/Cable';
import { Port } from '@/network/hardware/Port';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import {
  IPAddress, SubnetMask, MACAddress, createIPv4Packet, resetCounters,
  ETHERTYPE_IPV4, IP_PROTO_TCP, IP_PROTO_ICMP,
  type EthernetFrame, type IPv4Packet, type ICMPPacket, type ICMPType,
} from '@/network/core/types';
import {
  computeTcpChecksum, noFlags, type TcpFlags, type TcpOption, type TcpSegment,
} from '@/network/tcp/types';
import { optionsDataOffset } from '@/network/tcp/TcpOptionsCodec';
import { payloadBytes } from '@/network/layers/transport/L4Checksum';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { TcpSocket } from '@/network/tcp/TcpStack';

export const DUT_ADDRESS = '10.0.0.1';
export const PEER_ADDRESS = '10.0.0.2';
export const PEER_PORT = 40000;

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
}

export interface ScriptedPeer {
  readonly dut: EndHost;
  readonly bus: EventBus;
  readonly clock: VirtualTimeScheduler;
  readonly frames: EthernetFrame[];
  readonly replies: TcpSegment[];
  readonly icmpReplies: ICMPPacket[];
  readonly ports: { dut: number; peer: number };
  send(spec: PeerSegment): void;
  sendIpv4(packet: IPv4Packet): void;
  sendIcmpError(icmpType: ICMPType, code: number, offending: TcpSegment): void;
  respond(handler: ((segment: TcpSegment) => void) | null): void;
  take(): TcpSegment[];
  last(): TcpSegment | undefined;
  clear(): void;
  advance(ms: number): void;
}

export function scriptedPeer(platform: 'linux' | 'windows' = 'linux'): ScriptedPeer {
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
  dut.getPort('eth0')!.configureIP(new IPAddress(DUT_ADDRESS), new SubnetMask('255.255.255.0'));
  dut.addStaticARP(new IPAddress(PEER_ADDRESS), port.getMAC(), 'eth0');

  const frames: EthernetFrame[] = [];
  const replies: TcpSegment[] = [];
  const icmpReplies: ICMPPacket[] = [];
  let responder: ((segment: TcpSegment) => void) | null = null;
  port.onFrame((_name, frame) => {
    frames.push(frame);
    if (frame.etherType !== ETHERTYPE_IPV4) return;
    const packet = frame.payload as IPv4Packet;
    if (packet.protocol === IP_PROTO_ICMP) icmpReplies.push(packet.payload as ICMPPacket);
    if (packet.protocol !== IP_PROTO_TCP) return;
    const segment = packet.payload as TcpSegment;
    replies.push(segment);
    responder?.(segment);
  });

  const emit = (packet: IPv4Packet): void => {
    port.sendFrame({
      srcMAC: port.getMAC(), dstMAC: dut.getPort('eth0')!.getMAC(),
      etherType: ETHERTYPE_IPV4, payload: packet,
    } as EthernetFrame);
  };

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
    const source = spec.sourceAddress ?? PEER_ADDRESS;
    const destination = spec.destinationAddress ?? DUT_ADDRESS;
    seg.checksum = computeTcpChecksum(seg, source, destination);
    const size = seg.dataOffset * 4 + payloadBytes(seg.payload).length;
    emit(createIPv4Packet(
      new IPAddress(source), new IPAddress(destination), IP_PROTO_TCP, spec.ttl ?? 64, seg, size));
  };

  const sendIcmpError = (icmpType: ICMPType, code: number, offending: TcpSegment): void => {
    const original = createIPv4Packet(
      new IPAddress(DUT_ADDRESS), new IPAddress(PEER_ADDRESS), IP_PROTO_TCP, 64, offending,
      offending.dataOffset * 4);
    const icmp: ICMPPacket = {
      type: 'icmp', icmpType, code, id: 0, sequence: 0, dataSize: 28, originalPacket: original,
    };
    emit(createIPv4Packet(
      new IPAddress(PEER_ADDRESS), new IPAddress(DUT_ADDRESS), IP_PROTO_ICMP, 64, icmp, 8 + 28));
  };

  return {
    dut, bus, clock, frames, replies, icmpReplies, ports, send, sendIpv4: emit, sendIcmpError,
    respond: (handler) => { responder = handler; },
    take: () => replies.splice(0, replies.length),
    last: () => replies[replies.length - 1],
    clear: () => { replies.length = 0; icmpReplies.length = 0; },
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
  peer: ScriptedPeer, synOptions: TcpOption[] = [], peerIsn = PEER_ISN,
): OpenConnection {
  const accepted: TcpSocket[] = [];
  peer.dut.getTcpStack().listen(peer.ports.dut, { onAccept: (socket) => { accepted.push(socket); } });
  peer.send({ flags: 'S', sequence: peerIsn, options: synOptions });
  const synAck = peer.last()!;
  peer.send({ flags: 'A', sequence: peerIsn + 1, acknowledgement: synAck.sequence + 1 });
  peer.clear();
  return { socket: accepted[0], dutIsn: synAck.sequence, peerIsn };
}

export function openActive(
  peer: ScriptedPeer, synAckOptions: TcpOption[] = [], peerIsn = PEER_ISN,
): OpenConnection {
  const socket = peer.dut.getTcpStack().connect(PEER_ADDRESS, peer.ports.peer)!;
  const syn = peer.last()!;
  peer.ports.dut = syn.sourcePort;
  peer.send({
    flags: 'SA', sequence: peerIsn, acknowledgement: syn.sequence + 1, options: synAckOptions,
  });
  peer.clear();
  return { socket, dutIsn: syn.sequence, peerIsn };
}
