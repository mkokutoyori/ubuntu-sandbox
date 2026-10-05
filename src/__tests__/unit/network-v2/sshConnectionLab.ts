import { expect } from 'vitest';
import type { TcpStream } from '@/network/tcp/types';
import { SshTransport, type SshTransportConfig } from '@/network/protocols/ssh/transport/SshTransport';
import { SshHostKey } from '@/network/protocols/ssh/SshHostKey';
import { keygenPrivateKey } from '@/network/devices/linux/network/SshKeygenMaterial';
import { base64ToBytes } from '@/crypto/encoding';
import { SshConnection } from '@/network/protocols/ssh/connection/SshConnection';

export function pipePair(deferred = false): [TcpStream, TcpStream] {
  const make = (): { stream: TcpStream; deliver: (d: string) => void; end: () => void; peer: { write?: (d: string) => void; end?: () => void } } => {
    const handlers: Array<(d: string) => void> = [];
    const unread: string[] = [];
    const closers: Array<(r: string) => void> = [];
    const peer: { write?: (d: string) => void; end?: () => void } = {};
    return {
      peer,
      deliver: (d) => {
        const hand = (): void => { if (handlers.length === 0) unread.push(d); else for (const h of [...handlers]) h(d); };
        if (deferred) setTimeout(hand, 0); else hand();
      },
      end: () => { for (const c of [...closers]) c('fin'); },
      stream: {
        localIp: '10.0.0.1', localPort: 1, remoteIp: '10.0.0.2', remotePort: 22,
        write: (d: string) => peer.write?.(d),
        close: () => { peer.end?.(); },
        onData: (h) => { handlers.push(h); for (const u of unread.splice(0)) h(u); return () => {}; },
        onClose: (h) => { closers.push(h); return () => {}; },
      } as TcpStream,
    };
  };
  const a = make();
  const b = make();
  a.peer.write = b.deliver;
  b.peer.write = a.deliver;
  a.peer.end = b.end;
  b.peer.end = a.end;
  return [a.stream, b.stream];
}

export async function lab(
  serverOptions: { windowSize?: number } = {},
  transports: { client?: Partial<SshTransportConfig>; server?: Partial<SshTransportConfig>; deferred?: boolean } = {},
): Promise<{
  client: SshConnection; server: SshConnection; clientTransport: SshTransport; serverTransport: SshTransport;
  wire: Uint8Array[];
}> {
  const hostKey = SshHostKey.generate('srv', 'ssh-ed25519');
  const privateKey = keygenPrivateKey(hostKey.privateKeyBlob)!;
  const [clientSide, serverSide] = pipePair(transports.deferred);
  const wire: Uint8Array[] = [];
  const serverTransport = new SshTransport(serverSide, {
    role: 'server', identification: 'SSH-2.0-probe-server',
    hostKeys: [{ publicKeyBlob: base64ToBytes(hostKey.publicKey), privateKey }],
    ...transports.server,
  });
  const clientTransport = new SshTransport(clientSide, { role: 'client', identification: 'SSH-2.0-probe-client', ...transports.client });
  expect((await clientTransport.established).ok).toBe(true);
  const client = new SshConnection(clientTransport);
  const server = new SshConnection(serverTransport, serverOptions);
  serverTransport.onMessage((p) => wire.push(p));
  clientTransport.onMessage((p) => wire.push(p));
  return { client, server, clientTransport, serverTransport, wire };
}
