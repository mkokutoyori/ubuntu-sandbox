import { SshReader, SshWriter } from '../wire/SshDataTypes';
import {
  SSH_MSG_CHANNEL_CLOSE, SSH_MSG_CHANNEL_DATA, SSH_MSG_CHANNEL_EOF, SSH_MSG_CHANNEL_EXTENDED_DATA,
  SSH_MSG_CHANNEL_FAILURE, SSH_MSG_CHANNEL_OPEN, SSH_MSG_CHANNEL_OPEN_CONFIRMATION, SSH_MSG_CHANNEL_OPEN_FAILURE,
  SSH_MSG_CHANNEL_REQUEST, SSH_MSG_CHANNEL_SUCCESS, SSH_MSG_CHANNEL_WINDOW_ADJUST, SSH_MSG_GLOBAL_REQUEST,
  SSH_MSG_REQUEST_FAILURE, SSH_MSG_REQUEST_SUCCESS,
} from '../transport/SshMessageNumbers';

export type ConnectionMessage =
  | { readonly kind: 'global-request'; readonly name: string; readonly wantReply: boolean; readonly payload: Uint8Array }
  | { readonly kind: 'request-success'; readonly payload: Uint8Array }
  | { readonly kind: 'request-failure' }
  | {
    readonly kind: 'channel-open'; readonly channelType: string; readonly senderChannel: number;
    readonly initialWindow: number; readonly maxPacket: number; readonly payload: Uint8Array;
  }
  | {
    readonly kind: 'open-confirmation'; readonly recipient: number; readonly senderChannel: number;
    readonly initialWindow: number; readonly maxPacket: number; readonly payload: Uint8Array;
  }
  | {
    readonly kind: 'open-failure'; readonly recipient: number; readonly reason: number;
    readonly description: string; readonly language: string;
  }
  | { readonly kind: 'window-adjust'; readonly recipient: number; readonly bytes: number }
  | { readonly kind: 'data'; readonly recipient: number; readonly data: Uint8Array }
  | { readonly kind: 'extended-data'; readonly recipient: number; readonly dataType: number; readonly data: Uint8Array }
  | { readonly kind: 'eof'; readonly recipient: number }
  | { readonly kind: 'close'; readonly recipient: number }
  | {
    readonly kind: 'channel-request'; readonly recipient: number; readonly name: string;
    readonly wantReply: boolean; readonly payload: Uint8Array;
  }
  | { readonly kind: 'channel-success'; readonly recipient: number }
  | { readonly kind: 'channel-failure'; readonly recipient: number };

export function encodeConnectionMessage(message: ConnectionMessage): Uint8Array {
  switch (message.kind) {
    case 'global-request':
      return new SshWriter().writeByte(SSH_MSG_GLOBAL_REQUEST).writeString(message.name)
        .writeByte(message.wantReply ? 1 : 0).writeRaw(message.payload).toBytes();
    case 'request-success':
      return new SshWriter().writeByte(SSH_MSG_REQUEST_SUCCESS).writeRaw(message.payload).toBytes();
    case 'request-failure':
      return new Uint8Array([SSH_MSG_REQUEST_FAILURE]);
    case 'channel-open':
      return new SshWriter().writeByte(SSH_MSG_CHANNEL_OPEN).writeString(message.channelType)
        .writeUint32(message.senderChannel).writeUint32(message.initialWindow).writeUint32(message.maxPacket)
        .writeRaw(message.payload).toBytes();
    case 'open-confirmation':
      return new SshWriter().writeByte(SSH_MSG_CHANNEL_OPEN_CONFIRMATION).writeUint32(message.recipient)
        .writeUint32(message.senderChannel).writeUint32(message.initialWindow).writeUint32(message.maxPacket)
        .writeRaw(message.payload).toBytes();
    case 'open-failure':
      return new SshWriter().writeByte(SSH_MSG_CHANNEL_OPEN_FAILURE).writeUint32(message.recipient)
        .writeUint32(message.reason).writeString(message.description).writeString(message.language).toBytes();
    case 'window-adjust':
      return new SshWriter().writeByte(SSH_MSG_CHANNEL_WINDOW_ADJUST).writeUint32(message.recipient)
        .writeUint32(message.bytes).toBytes();
    case 'data':
      return new SshWriter().writeByte(SSH_MSG_CHANNEL_DATA).writeUint32(message.recipient)
        .writeBytes(message.data).toBytes();
    case 'extended-data':
      return new SshWriter().writeByte(SSH_MSG_CHANNEL_EXTENDED_DATA).writeUint32(message.recipient)
        .writeUint32(message.dataType).writeBytes(message.data).toBytes();
    case 'eof':
      return new SshWriter().writeByte(SSH_MSG_CHANNEL_EOF).writeUint32(message.recipient).toBytes();
    case 'close':
      return new SshWriter().writeByte(SSH_MSG_CHANNEL_CLOSE).writeUint32(message.recipient).toBytes();
    case 'channel-request':
      return new SshWriter().writeByte(SSH_MSG_CHANNEL_REQUEST).writeUint32(message.recipient)
        .writeString(message.name).writeByte(message.wantReply ? 1 : 0).writeRaw(message.payload).toBytes();
    case 'channel-success':
      return new SshWriter().writeByte(SSH_MSG_CHANNEL_SUCCESS).writeUint32(message.recipient).toBytes();
    case 'channel-failure':
      return new SshWriter().writeByte(SSH_MSG_CHANNEL_FAILURE).writeUint32(message.recipient).toBytes();
  }
}

export function decodeConnectionMessage(payload: Uint8Array): ConnectionMessage | null {
  try {
    const reader = new SshReader(payload);
    const type = reader.readByte();
    const rest = (): Uint8Array => reader.readRaw(reader.remaining);
    switch (type) {
      case SSH_MSG_GLOBAL_REQUEST: {
        const name = reader.readString();
        const wantReply = reader.readByte() !== 0;
        return { kind: 'global-request', name, wantReply, payload: rest() };
      }
      case SSH_MSG_REQUEST_SUCCESS:
        return { kind: 'request-success', payload: rest() };
      case SSH_MSG_REQUEST_FAILURE:
        return { kind: 'request-failure' };
      case SSH_MSG_CHANNEL_OPEN: {
        const channelType = reader.readString();
        const senderChannel = reader.readUint32();
        const initialWindow = reader.readUint32();
        const maxPacket = reader.readUint32();
        return { kind: 'channel-open', channelType, senderChannel, initialWindow, maxPacket, payload: rest() };
      }
      case SSH_MSG_CHANNEL_OPEN_CONFIRMATION: {
        const recipient = reader.readUint32();
        const senderChannel = reader.readUint32();
        const initialWindow = reader.readUint32();
        const maxPacket = reader.readUint32();
        return { kind: 'open-confirmation', recipient, senderChannel, initialWindow, maxPacket, payload: rest() };
      }
      case SSH_MSG_CHANNEL_OPEN_FAILURE: {
        const recipient = reader.readUint32();
        const reason = reader.readUint32();
        const description = reader.readString();
        const language = reader.remaining > 0 ? reader.readString() : '';
        return { kind: 'open-failure', recipient, reason, description, language };
      }
      case SSH_MSG_CHANNEL_WINDOW_ADJUST:
        return { kind: 'window-adjust', recipient: reader.readUint32(), bytes: reader.readUint32() };
      case SSH_MSG_CHANNEL_DATA:
        return { kind: 'data', recipient: reader.readUint32(), data: reader.readBytes() };
      case SSH_MSG_CHANNEL_EXTENDED_DATA: {
        const recipient = reader.readUint32();
        const dataType = reader.readUint32();
        return { kind: 'extended-data', recipient, dataType, data: reader.readBytes() };
      }
      case SSH_MSG_CHANNEL_EOF:
        return { kind: 'eof', recipient: reader.readUint32() };
      case SSH_MSG_CHANNEL_CLOSE:
        return { kind: 'close', recipient: reader.readUint32() };
      case SSH_MSG_CHANNEL_REQUEST: {
        const recipient = reader.readUint32();
        const name = reader.readString();
        const wantReply = reader.readByte() !== 0;
        return { kind: 'channel-request', recipient, name, wantReply, payload: rest() };
      }
      case SSH_MSG_CHANNEL_SUCCESS:
        return { kind: 'channel-success', recipient: reader.readUint32() };
      case SSH_MSG_CHANNEL_FAILURE:
        return { kind: 'channel-failure', recipient: reader.readUint32() };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function isConnectionMessageType(type: number): boolean {
  return type >= SSH_MSG_GLOBAL_REQUEST && type <= SSH_MSG_CHANNEL_FAILURE;
}
