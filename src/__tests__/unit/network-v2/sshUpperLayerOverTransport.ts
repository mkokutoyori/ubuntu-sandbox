import type { TcpStream } from '@/network/tcp/types';
import { SshTransport, legacyFrameStream } from '@/network/protocols/ssh/transport/SshTransport';

export async function upperLayerOverTransport(socket: TcpStream): Promise<TcpStream | null> {
  const transport = new SshTransport(socket, { role: 'client', identification: 'SSH-2.0-probe' });
  const outcome = await transport.established;
  return outcome.ok ? legacyFrameStream(transport, socket) : null;
}
