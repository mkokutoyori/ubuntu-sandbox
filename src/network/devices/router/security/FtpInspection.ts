import type { IPv4Packet } from '../../../core/types';
import { payloadBytes } from '../../../layers/transport/L4Checksum';
import { decodePortArgument, decodeEprtArgument, decodeEpsvReplyArgument } from '../../../ftp/DataChannel';
import { decodeCommand, decodeReply } from '../../../ftp/replies';
import { FTP_CONTROL_PORT } from '../../../ftp/FtpServer';

export interface FtpDataExpectation {
  readonly initiator: string;
  readonly responder: string;
  readonly responderPort: number;
}

function textOf(packet: IPv4Packet): string {
  const segment = packet.payload as { type?: string; payload?: unknown } | undefined;
  if (segment?.type !== 'tcp') return '';
  return String.fromCharCode(...payloadBytes(segment.payload));
}

export function ftpDataExpectation(packet: IPv4Packet): FtpDataExpectation | null {
  const segment = packet.payload as { type?: string; sourcePort?: number; destinationPort?: number } | undefined;
  if (segment?.type !== 'tcp') return null;
  const text = textOf(packet);
  if (text === '') return null;
  const server = packet.destinationIP.toString();
  if (segment.destinationPort === FTP_CONTROL_PORT) {
    const command = decodeCommand(text);
    if (command?.argument === undefined) return null;
    if (command.verb === 'PORT') {
      const endpoint = decodePortArgument(command.argument);
      return endpoint === null ? null
        : { initiator: server, responder: endpoint.address, responderPort: endpoint.port };
    }
    if (command.verb === 'EPRT') {
      const endpoint = decodeEprtArgument(command.argument);
      return endpoint === null || endpoint.protocol !== 1 ? null
        : { initiator: server, responder: endpoint.address, responderPort: endpoint.port };
    }
    return null;
  }
  if (segment.sourcePort !== FTP_CONTROL_PORT) return null;
  const reply = decodeReply(text);
  if (reply === null) return null;
  const serverAddress = packet.sourceIP.toString();
  const clientAddress = packet.destinationIP.toString();
  if (reply.code === 227) {
    const match = /\(([\d,]+)\)/.exec(reply.lines[0]);
    const endpoint = match ? decodePortArgument(match[1]) : null;
    return endpoint === null ? null
      : { initiator: clientAddress, responder: endpoint.address, responderPort: endpoint.port };
  }
  if (reply.code === 229) {
    const port = decodeEpsvReplyArgument(reply.lines[0]);
    return port === null ? null : { initiator: clientAddress, responder: serverAddress, responderPort: port };
  }
  return null;
}
