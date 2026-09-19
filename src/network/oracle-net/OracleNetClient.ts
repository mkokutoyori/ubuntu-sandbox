import { IPAddress } from '@/network/core/types';
import type { PortNumber } from '@/network/core/ports/PortNumber';
import {
  NsPacketType, NS_MAX_TDU_SIZE, NS_NT_PROTO_CHARACTERISTICS, NS_LINE_TURNAROUND,
  NS_SDU_SIZE, NS_SERVICE_OPTIONS, NS_VERSION_19C, NS_VERSION_COMPATIBLE,
  decodeAccept, decodeData, decodeRefuse, encodeConnect, encodeData,
  readNsFrame, readNsHeader,
} from './wire/NsPacket';
import { renderConnectDescriptor, type ConnectDescriptorRequest } from './wire/ConnectDescriptor';

export interface OracleNetTransportSocket {
  readonly everEstablished: boolean;
  send(data: unknown): void;
  close(): void;
  onData(handler: (data: unknown) => void): () => void;
}

export interface OracleNetTransport {
  connect(ip: IPAddress, port: number): OracleNetTransportSocket | null;
}

export type OracleNetHandshake =
  | { readonly ok: true; readonly session: OracleNetSession }
  | { readonly ok: false; readonly error: string };

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  const text = String(data);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function readRefusalText(refuseData: string): string {
  return /\(\s*TEXT\s*=\s*([^)]*)\)/i.exec(refuseData)?.[1]?.trim()
    ?? 'ORA-12500: TNS:listener failed to start a dedicated server process';
}

export class OracleNetSession {
  private pending = new Uint8Array(0);
  private inbox: Uint8Array[] = [];
  private closed = false;

  constructor(private readonly socket: OracleNetTransportSocket) {
    this.socket.onData((data) => this.receive(toBytes(data)));
  }

  private receive(chunk: Uint8Array): void {
    this.pending = concat(this.pending, chunk);
    for (;;) {
      const frame = readNsFrame(this.pending);
      if (!frame) return;
      this.inbox.push(frame.packet.slice());
      this.pending = this.pending.subarray(frame.consumed);
    }
  }

  private takePacket(type: NsPacketType): Uint8Array | null {
    const index = this.inbox.findIndex((p) => readNsHeader(p)?.type === type);
    if (index < 0) return null;
    return this.inbox.splice(index, 1)[0];
  }

  call(request: Uint8Array): Uint8Array | null {
    if (this.closed) return null;
    this.socket.send(encodeData(request));
    const packet = this.takePacket(NsPacketType.Data);
    return packet ? decodeData(packet)?.payload.slice() ?? null : null;
  }

  isOpen(): boolean { return !this.closed; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }

  _adopt(inbox: Uint8Array[], pending: Uint8Array): void {
    this.inbox = inbox;
    this.pending = pending;
  }
}

export class OracleNetClient {
  constructor(private readonly transport: OracleNetTransport) {}

  connect(
    ip: IPAddress,
    port: PortNumber,
    request: ConnectDescriptorRequest,
  ): OracleNetHandshake {
    const socket = this.transport.connect(ip, port.value);
    if (!socket) return { ok: false, error: 'ORA-12541: TNS:no listener' };
    if (!socket.everEstablished) {
      socket.close();
      return { ok: false, error: 'ORA-12541: TNS:no listener' };
    }

    let pending = new Uint8Array(0);
    const frames: Uint8Array[] = [];
    const stop = socket.onData((data) => {
      pending = concat(pending, toBytes(data));
      for (;;) {
        const frame = readNsFrame(pending);
        if (!frame) return;
        frames.push(frame.packet.slice());
        pending = pending.subarray(frame.consumed);
      }
    });

    socket.send(encodeConnect({
      version: NS_VERSION_19C,
      compatibleVersion: NS_VERSION_COMPATIBLE,
      serviceOptions: NS_SERVICE_OPTIONS,
      sduSize: NS_SDU_SIZE,
      maxTduSize: NS_MAX_TDU_SIZE,
      ntProtoCharacteristics: NS_NT_PROTO_CHARACTERISTICS,
      lineTurnaround: NS_LINE_TURNAROUND,
      connectData: renderConnectDescriptor(request),
    }));
    stop();

    const refuse = frames.find((p) => readNsHeader(p)?.type === NsPacketType.Refuse);
    if (refuse) {
      socket.close();
      const body = decodeRefuse(refuse);
      return { ok: false, error: readRefusalText(body?.refuseData ?? '') };
    }

    const accept = frames.find((p) => readNsHeader(p)?.type === NsPacketType.Accept);
    if (!accept || !decodeAccept(accept)) {
      socket.close();
      return { ok: false, error: 'ORA-12547: TNS:lost contact' };
    }

    const session = new OracleNetSession(socket);
    const leftovers = frames.filter((p) => p !== accept && readNsHeader(p)?.type !== NsPacketType.Refuse);
    session._adopt(leftovers, pending);
    return { ok: true, session };
  }
}
