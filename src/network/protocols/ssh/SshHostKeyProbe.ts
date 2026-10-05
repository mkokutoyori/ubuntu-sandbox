import type { TcpStream } from '@/network/tcp/types';
import { bytesToBase64 } from '@/crypto/encoding';
import { sshPublicKeyFromBlob } from '@/network/devices/linux/network/SshKeygenMaterial';
import { SshTransport } from './transport/SshTransport';

export interface ProbedHostKey {
  algorithm: string;
  publicKey: string;
}

export interface HostKeyProbeResult {
  readonly serverIdentification: string | null;
  readonly hostKey: ProbedHostKey | null;
}

export const SSH_KEYSCAN_IDENTIFICATION = 'SSH-2.0-OpenSSH-keyscan';

export function probeSshHostKey(
  conn: TcpStream | null, hostKeyAlgorithms: readonly string[],
): HostKeyProbeResult | null {
  if (!conn) return null;
  let hostKey: ProbedHostKey | null = null;
  const transport = new SshTransport(conn, {
    role: 'client',
    identification: SSH_KEYSCAN_IDENTIFICATION,
    hostKeyAlgorithms,
    verifyHostKey: (_algorithm, blob) => {
      const parsed = sshPublicKeyFromBlob(blob);
      if (parsed !== null) hostKey = { algorithm: parsed.algorithm, publicKey: bytesToBase64(blob) };
      return false;
    },
  });
  if (transport.settled === null) conn.close();
  return { serverIdentification: transport.peerIdentification?.line ?? null, hostKey };
}
