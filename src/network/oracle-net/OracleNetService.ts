import type { ListenerControl } from '@/database/oracle/listener/ListenerControl';
import {
  NsPacketType, NsRefuseReason, NS_SDU_SIZE, NS_MAX_TDU_SIZE, NS_SERVICE_OPTIONS,
  NS_VERSION_19C, decodeConnect, decodeData, encodeAccept, encodeData, encodeRefuse,
  readNsFrame, readNsHeader,
} from './wire/NsPacket';
import { parseConnectDescriptor } from './wire/ConnectDescriptor';

export interface OracleNetPeer {
  readonly remoteIp: string;
  readonly remotePort: number;
}

export interface OracleNetCallContext {
  readonly peer: OracleNetPeer;
  readonly service: string;
  readonly programName?: string;
  readonly hostName?: string;
  readonly userName?: string;
}

export interface OracleNetCallHandler {
  handleCall(request: Uint8Array, context: OracleNetCallContext): Uint8Array | null;
}

export interface OracleNetSocket extends OracleNetPeer {
  send(data: unknown): void;
  close(): void;
  onData(handler: (data: unknown) => void): () => void;
  onClose(handler: (reason: unknown) => void): () => void;
}

const ACCEPT_DATA = '';

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

class OracleNetConnection {
  private pending = new Uint8Array(0);
  private context: OracleNetCallContext | null = null;
  private sawConnect = false;

  constructor(
    private readonly socket: OracleNetSocket,
    private readonly listener: ListenerControl,
    private readonly handler: OracleNetCallHandler | null,
  ) {}

  attach(): void {
    this.socket.onData((data) => this.receive(toBytes(data)));
    this.socket.onClose(() => {
      if (!this.sawConnect) this.listener.recordScanAttempt(this.socket.remoteIp, 'syn-probe');
    });
  }

  private receive(chunk: Uint8Array): void {
    this.pending = concat(this.pending, chunk);
    for (;;) {
      const frame = readNsFrame(this.pending);
      if (!frame) return;
      const packet = frame.packet.slice();
      this.pending = this.pending.subarray(frame.consumed);
      this.dispatch(packet);
    }
  }

  private dispatch(packet: Uint8Array): void {
    const header = readNsHeader(packet);
    if (!header) return;
    if (header.type === NsPacketType.Connect) { this.onConnect(packet); return; }
    if (header.type === NsPacketType.Data) { this.onData(packet); return; }
  }

  private onConnect(packet: Uint8Array): void {
    this.sawConnect = true;
    const body = decodeConnect(packet);
    if (!body) {
      this.refuse(NsRefuseReason.System, 'ORA-12547: TNS:lost contact');
      return;
    }
    const descriptor = parseConnectDescriptor(body.connectData);
    const service = descriptor?.service
      ?? body.connectData.replace(/.*SERVICE_NAME\s*=\s*([^)\s]+).*/is, '$1').toUpperCase();
    const outcome = this.listener.attemptConnect(service, this.socket.remoteIp);
    if (outcome.ok === false) {
      this.refuse(NsRefuseReason.User, outcome.error);
      return;
    }
    this.context = {
      peer: { remoteIp: this.socket.remoteIp, remotePort: this.socket.remotePort },
      service,
      programName: descriptor?.programName,
      hostName: descriptor?.hostName,
      userName: descriptor?.userName,
    };
    this.socket.send(encodeAccept({
      version: Math.min(body.version, NS_VERSION_19C),
      serviceOptions: NS_SERVICE_OPTIONS,
      sduSize: Math.min(body.sduSize, NS_SDU_SIZE),
      maxTduSize: Math.min(body.maxTduSize, NS_MAX_TDU_SIZE),
      acceptData: ACCEPT_DATA,
    }));
  }

  private onData(packet: Uint8Array): void {
    const body = decodeData(packet);
    if (!body) return;
    if (!this.context) {
      this.refuse(NsRefuseReason.System, 'ORA-12547: TNS:lost contact');
      return;
    }
    const answer = this.handler?.handleCall(body.payload.slice(), this.context) ?? null;
    if (answer) this.socket.send(encodeData(answer));
  }

  private refuse(reason: NsRefuseReason, text: string): void {
    this.socket.send(encodeRefuse({
      userReason: reason,
      systemReason: NsRefuseReason.None,
      refuseData: `(DESCRIPTION=(ERR=${errorNumber(text)})(ERROR_STACK=(ERROR=(CODE=${errorNumber(text)})(EMFI=4)))(TEXT=${text}))`,
    }));
    this.socket.close();
  }
}

function errorNumber(text: string): number {
  const match = /ORA-(\d+)/.exec(text);
  return match ? Number.parseInt(match[1], 10) : 12500;
}

export class OracleNetService {
  private handler: OracleNetCallHandler | null = null;

  constructor(private readonly listener: ListenerControl) {}

  setCallHandler(handler: OracleNetCallHandler | null): void {
    this.handler = handler;
  }

  accept(socket: OracleNetSocket): void {
    new OracleNetConnection(socket, this.listener, this.handler).attach();
  }
}
