import type { TcpStack, TcpSocket } from '@/network/tcp/TcpStack';
import type { DHCPServer } from './DHCPServer';
import { DHCPPacket, DHCP_OPTION } from './DHCPPacket';
import type { DhcpBulkRecord } from './types';

export const BULK_LEASEQUERY_PORT = 67;
export const BULK_LQ_MAX_CONNS = 10;

export const BulkStatus = {
  Success: 0,
  UnspecFail: 1,
  QueryTerminated: 2,
  MalformedQuery: 3,
  NotAllowed: 4,
} as const;

const VPN_ID_OPTION = 221;
const MESSAGE_ACTIVE = 13;
const MESSAGE_UNASSIGNED = 11;
const MESSAGE_DONE = 15;

export function frameMessage(packet: DHCPPacket): Uint8Array {
  const body = packet.serialize();
  const framed = new Uint8Array(body.length + 2);
  framed[0] = (body.length >>> 8) & 0xff;
  framed[1] = body.length & 0xff;
  framed.set(body, 2);
  return framed;
}

export function unframeMessages(bytes: Uint8Array): DHCPPacket[] {
  const messages: DHCPPacket[] = [];
  for (let offset = 0; offset + 2 <= bytes.length;) {
    const size = (bytes[offset] << 8) | bytes[offset + 1];
    if (offset + 2 + size > bytes.length) break;
    messages.push(DHCPPacket.deserialize(bytes.slice(offset + 2, offset + 2 + size)));
    offset += 2 + size;
  }
  return messages;
}

export function toBinaryString(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

export function fromBinaryChunk(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  const text = String(chunk);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export interface BulkLeasequeryHost {
  tcp(): TcpStack;
  now(): number;
}

export class DhcpBulkLeasequeryService {
  private listening = false;
  private connections = 0;

  constructor(private readonly host: BulkLeasequeryHost, private readonly server: DHCPServer) {
    server.onBulkLeasequeryChange(() => this.sync());
  }

  sync(): void {
    const wanted = this.server.isBulkLeasequeryEnabled();
    if (wanted && !this.listening) {
      this.host.tcp().listen(BULK_LEASEQUERY_PORT, {
        identity: { pid: 1067, processName: 'dhcpd' },
        onAccept: (socket) => this.accept(socket),
      });
      this.listening = true;
    } else if (!wanted && this.listening) {
      this.host.tcp().closeListener(BULK_LEASEQUERY_PORT);
      this.listening = false;
    }
  }

  private accept(socket: TcpSocket): void {
    if (!this.server.mayBulkLeasequery(socket.remoteIp) || this.connections >= BULK_LQ_MAX_CONNS) {
      socket.close();
      return;
    }
    this.connections++;
    socket.onData((data) => {
      const bytes = fromBinaryChunk(data);
      const replies: Uint8Array[] = [];
      for (const request of unframeMessages(bytes)) {
        for (const message of this.answer(request)) replies.push(frameMessage(message));
      }
      if (replies.length > 0) socket.write(toBinaryString(concatenate(replies)));
    });
  }

  answer(request: DHCPPacket): DHCPPacket[] {
    if (request.getMessageType() !== 'DHCPBULKLEASEQUERY') return [];
    const base = Math.floor(this.host.now() / 1000);
    const serverId = this.server.getServerIdentifier();
    const done = (status: number, text: string): DHCPPacket[] => {
      const message = this.message(MESSAGE_DONE, request);
      message.setOption(DHCP_OPTION.SERVER_IDENTIFIER, serverId);
      if (status !== BulkStatus.Success) message.setOption(DHCP_OPTION.STATUS_CODE, { code: status, message: text });
      return [message];
    };
    if (request.ciaddr !== '0.0.0.0' || request.yiaddr !== '0.0.0.0' || request.siaddr !== '0.0.0.0') {
      return done(BulkStatus.MalformedQuery, 'ciaddr, yiaddr and siaddr must be zero');
    }
    const information = request.getOption(DHCP_OPTION.RELAY_AGENT_INFORMATION) as { remoteId?: string } | undefined;
    const clientIdentifier = request.getOption(DHCP_OPTION.CLIENT_IDENTIFIER);
    const byMac = request.chaddr !== '00:00:00:00:00:00';
    const byId = typeof clientIdentifier === 'string' && clientIdentifier.length > 0;
    const byRemote = information?.remoteId !== undefined && information.remoteId !== '';
    if ([byMac, byId, byRemote].filter(Boolean).length > 1) {
      return done(BulkStatus.NotAllowed, 'only one primary query is allowed');
    }
    if (request.getOption(VPN_ID_OPTION) !== undefined) {
      return done(BulkStatus.QueryTerminated, 'VPN selection is not supported by this server');
    }
    const requested = (request.getOption(DHCP_OPTION.PARAMETER_REQUEST_LIST) as number[] | undefined) ?? [];
    const records = this.server.processBulkLeaseQuery({
      hardwareAddress: byMac ? request.chaddr : undefined,
      clientIdentifier: byId ? String(clientIdentifier) : undefined,
      remoteId: byRemote ? information!.remoteId : undefined,
      queryStartTime: request.getOption(DHCP_OPTION.QUERY_START_TIME) as number | undefined,
      queryEndTime: request.getOption(DHCP_OPTION.QUERY_END_TIME) as number | undefined,
    });
    const replies = records.map((record, index) => this.record(record, request, requested, base, index === 0));
    const closing = this.message(MESSAGE_DONE, request);
    if (replies.length === 0) closing.setOption(DHCP_OPTION.SERVER_IDENTIFIER, serverId);
    replies.push(closing);
    return replies;
  }

  private message(type: number, request: DHCPPacket): DHCPPacket {
    const message = new DHCPPacket();
    message.op = 2;
    message.xid = request.xid;
    message.chaddr = request.chaddr;
    message.setOption(DHCP_OPTION.MESSAGE_TYPE, type);
    return message;
  }

  private record(
    record: DhcpBulkRecord, request: DHCPPacket, requested: readonly number[], base: number, first: boolean,
  ): DHCPPacket {
    const message = this.message(record.state === 2 ? MESSAGE_ACTIVE : MESSAGE_UNASSIGNED, request);
    message.ciaddr = record.ipAddress;
    if (record.hardwareAddress !== undefined) message.chaddr = record.hardwareAddress.toUpperCase();
    if (first) message.setOption(DHCP_OPTION.SERVER_IDENTIFIER, this.server.getServerIdentifier());
    const wants = (code: number): boolean => requested.includes(code);
    if (wants(DHCP_OPTION.BASE_TIME)) message.setOption(DHCP_OPTION.BASE_TIME, base);
    if (wants(DHCP_OPTION.DHCP_STATE)) message.setOption(DHCP_OPTION.DHCP_STATE, record.state);
    if (record.state === 2) {
      const seconds = (at: number | undefined): number => Math.max(0, base - Math.floor((at ?? 0) / 1000));
      if (wants(DHCP_OPTION.START_TIME_OF_STATE)) message.setOption(DHCP_OPTION.START_TIME_OF_STATE, seconds(record.leaseStart));
      if (wants(DHCP_OPTION.CLIENT_LAST_TRANSACTION_TIME)) {
        message.setOption(DHCP_OPTION.CLIENT_LAST_TRANSACTION_TIME, seconds(record.lastTransaction ?? record.leaseStart));
      }
      if (wants(DHCP_OPTION.LEASE_TIME) && record.leaseExpiration !== undefined) {
        message.setOption(DHCP_OPTION.LEASE_TIME, Math.max(0, Math.ceil(record.leaseExpiration / 1000) - base));
      }
      if (wants(DHCP_OPTION.CLIENT_IDENTIFIER) && record.clientIdentifierOption !== undefined) {
        message.setOption(DHCP_OPTION.CLIENT_IDENTIFIER, record.clientIdentifierOption);
      }
      if (wants(DHCP_OPTION.RELAY_AGENT_INFORMATION) && record.relayInformation !== undefined) {
        message.setOption(DHCP_OPTION.RELAY_AGENT_INFORMATION, record.relayInformation);
      }
    }
    return message;
  }
}

export interface BulkLeasequeryOutcome {
  readonly messages: readonly DHCPPacket[];
  readonly complete: boolean;
  readonly refused: boolean;
}

export function bulkLeaseQuery(tcp: TcpStack, serverAddress: string, request: DHCPPacket): BulkLeasequeryOutcome {
  const socket = tcp.connect(serverAddress, BULK_LEASEQUERY_PORT);
  if (!socket || socket.state !== 'established') return { messages: [], complete: false, refused: true };
  let received = new Uint8Array(0);
  const stop = socket.onData((data) => {
    received = concatenate([received, fromBinaryChunk(data)]);
  });
  socket.write(toBinaryString(frameMessage(request)));
  stop();
  socket.close();
  const messages = unframeMessages(received);
  return { messages, complete: messages.some(m => m.getMessageType() === 'DHCPLEASEQUERYDONE'), refused: false };
}
