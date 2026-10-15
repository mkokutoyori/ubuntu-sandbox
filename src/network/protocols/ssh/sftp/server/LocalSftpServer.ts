import type { SftpPacketChannel } from '../client/SftpWireClient';
import type { SftpWireSession } from '../SftpWireSession';

export function attachSftpServer(session: SftpWireSession): SftpPacketChannel {
  const reply = session.handle({ type: 'INIT', version: 3 });
  const extensions = reply.type === 'VERSION' ? reply.extensions ?? [] : [];
  session.begin();
  return {
    exchange: (packet) => session.handle(packet),
    protocolVersion: reply.type === 'VERSION' ? reply.version : 3,
    serverExtensions: new Map(extensions.map((pair) => [pair.name, pair.data])),
  };
}
