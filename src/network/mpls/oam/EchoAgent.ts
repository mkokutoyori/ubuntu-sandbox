import { IPAddress, IP_OPTION_ROUTER_ALERT, IP_PROTO_UDP, createIPv4Packet, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { PathClock } from '@/network/core/time/PathClock';
import { timestampFromMs } from '@/network/ntp/timestamp';
import {
  EchoDecodeError, EchoMessageType, MPLS_ECHO_UDP_PORT, MPLS_ECHO_VERSION, PadInstruction, ROUTER_ALERT_OPTION_VALUE,
  ReplyMode, ReturnCode, decodeEcho, encodeEcho, newEchoMessage,
  type EchoMessage, type TargetFec,
} from './EchoCodec';
import { evaluateEchoRequest, type EchoReceipt, type EchoResponderHost } from './EchoResponder';

const ECHO_LOOPBACK_PREFIX = '127.';
const ECHO_REQUEST_IP_TTL = 1;
const ECHO_REPLY_IP_TTL = 255;
const MINIMUM_HEADER = 32;

export interface EchoReply {
  readonly message: EchoMessage;
  readonly from: IPAddress;
  readonly roundTripMs: number;
}

export interface PendingEcho {
  readonly handle: number;
  readonly sequence: number;
  readonly sourcePort: number;
  readonly sentAt: number;
  reply: EchoReply | null;
}

export interface EchoRequestOptions {
  readonly replyMode?: number;
  readonly globalFlags?: number;
  readonly pad?: { readonly instruction: number; readonly length: number };
  readonly replyTosByte?: number;
}

export interface BuiltEchoRequest {
  readonly packet: IPv4Packet;
  readonly pending: PendingEcho;
}

export function isEchoRequestPacket(packet: IPv4Packet): boolean {
  if (packet.protocol !== IP_PROTO_UDP) return false;
  const udp = packet.payload as UDPPacket | undefined;
  return udp?.type === 'udp' && udp.destinationPort === MPLS_ECHO_UDP_PORT && udp.payload instanceof Uint8Array;
}

export function isEchoLoopbackDestination(destination: IPAddress): boolean {
  return destination.toString().startsWith(ECHO_LOOPBACK_PREFIX);
}

function udpPacket(sourcePort: number, destinationPort: number, payload: Uint8Array): UDPPacket {
  return { type: 'udp', sourcePort, destinationPort, length: 8 + payload.length, checksum: 0, payload };
}

function routerAlert() {
  return [{ type: IP_OPTION_ROUTER_ALERT, data: [ROUTER_ALERT_OPTION_VALUE, ROUTER_ALERT_OPTION_VALUE] }];
}

export class MplsEchoAgent {
  private nextHandle = 1;
  private nextSequence = 1;
  private readonly pendingByPort = new Map<number, PendingEcho>();

  constructor(
    private readonly host: {
      localAddress(): IPAddress;
      allocatePort(): number;
      releasePort(port: number): void;
      sendReply(packet: IPv4Packet): boolean;
    },
  ) {}

  buildRequest(source: IPAddress, fecs: readonly TargetFec[], options: EchoRequestOptions = {}): BuiltEchoRequest {
    const handle = this.nextHandle++;
    const sequence = this.nextSequence++;
    const sentAt = PathClock.now();
    const message = newEchoMessage({
      messageType: EchoMessageType.Request, senderHandle: handle, sequenceNumber: sequence,
      replyMode: options.replyMode ?? ReplyMode.Udp, globalFlags: options.globalFlags ?? 0,
      timestampSent: timestampFromMs(sentAt), targetFecs: fecs,
      pad: options.pad ?? null, replyTosByte: options.replyTosByte ?? null,
    });
    const payload = encodeEcho(message);
    const sourcePort = this.host.allocatePort();
    const destination = new IPAddress(`127.${1 + (handle % 254)}.${1 + (sequence % 254)}.1`);
    const packet = createIPv4Packet(
      source, destination, IP_PROTO_UDP, ECHO_REQUEST_IP_TTL, udpPacket(sourcePort, MPLS_ECHO_UDP_PORT, payload),
      8 + payload.length, { ipOptions: routerAlert() },
    );
    const pending: PendingEcho = { handle, sequence, sourcePort, sentAt, reply: null };
    this.pendingByPort.set(sourcePort, pending);
    return { packet, pending };
  }

  finish(pending: PendingEcho): void {
    if (this.pendingByPort.delete(pending.sourcePort)) this.host.releasePort(pending.sourcePort);
  }

  receiveReply(from: IPAddress, udp: UDPPacket): void {
    const pending = this.pendingByPort.get(udp.destinationPort);
    if (pending === undefined || !(udp.payload instanceof Uint8Array)) return;
    let message: EchoMessage;
    try { message = decodeEcho(udp.payload); } catch { return; }
    if (message.messageType !== EchoMessageType.Reply || message.senderHandle !== pending.handle) return;
    if (message.sequenceNumber !== pending.sequence) return;
    pending.reply = { message, from, roundTripMs: Math.max(0, PathClock.now() - pending.sentAt) };
  }

  receiveRequest(request: IPv4Packet, receipt: EchoReceipt, responder: EchoResponderHost): void {
    const udp = request.payload as UDPPacket;
    const bytes = udp.payload as Uint8Array;
    const arrivedAt = PathClock.now();
    let message: EchoMessage;
    try {
      message = decodeEcho(bytes);
    } catch (error) {
      if (error instanceof EchoDecodeError && bytes.length >= MINIMUM_HEADER) this.replyMalformed(request, bytes, arrivedAt);
      return;
    }
    if (message.messageType !== EchoMessageType.Request || message.version !== MPLS_ECHO_VERSION) {
      if (message.messageType === EchoMessageType.Request) this.replyMalformed(request, bytes, arrivedAt);
      return;
    }
    if (message.replyMode !== ReplyMode.Udp && message.replyMode !== ReplyMode.UdpRouterAlert) return;
    const verdict = evaluateEchoRequest(message, receipt, responder);
    if (!verdict.reply) return;
    const copyPad = message.pad !== null && message.pad.instruction === PadInstruction.CopyToReply;
    const reply = newEchoMessage({
      messageType: EchoMessageType.Reply, senderHandle: message.senderHandle, sequenceNumber: message.sequenceNumber,
      replyMode: message.replyMode, returnCode: verdict.returnCode, returnSubcode: verdict.returnSubcode,
      timestampSent: message.timestampSent, timestampReceived: timestampFromMs(arrivedAt),
      targetFecs: message.targetFecs, pad: copyPad ? message.pad : null,
      interfaceAndLabelStack: verdict.interfaceAndLabelStack, erroredTlvs: verdict.erroredTlvs,
    });
    this.sendReply(request, reply, message.replyTosByte, message.replyMode === ReplyMode.UdpRouterAlert);
  }

  private replyMalformed(request: IPv4Packet, bytes: Uint8Array, arrivedAt: number): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const reply = newEchoMessage({
      messageType: EchoMessageType.Reply, senderHandle: view.getUint32(8), sequenceNumber: view.getUint32(12),
      replyMode: view.getUint8(5), returnCode: ReturnCode.Malformed, timestampReceived: timestampFromMs(arrivedAt),
    });
    this.sendReply(request, reply, null, false);
  }

  private sendReply(request: IPv4Packet, reply: EchoMessage, tos: number | null, withRouterAlert: boolean): void {
    const udp = request.payload as UDPPacket;
    const payload = encodeEcho(reply);
    const packet = createIPv4Packet(
      this.host.localAddress(), request.sourceIP, IP_PROTO_UDP, ECHO_REPLY_IP_TTL,
      udpPacket(MPLS_ECHO_UDP_PORT, udp.sourcePort, payload), 8 + payload.length,
      { tos: tos ?? 0, ...(withRouterAlert ? { ipOptions: routerAlert() } : {}) },
    );
    this.host.sendReply(packet);
  }
}
