export interface ProbedHostKey {
  algorithm: string;
  publicKey: string;
}

export interface HostKeyProbeConnection {
  onData(handler: (data: unknown) => void): () => void;
  write(data: string): void;
  close(): void;
}

const CLIENT_VERSION = 'SSH-2.0-OpenSSH_8.9';

export function probeSshHostKey(conn: HostKeyProbeConnection | null): ProbedHostKey | null {
  if (!conn) return null;

  let hostKey: ProbedHostKey | null = null;
  const off = conn.onData((data) => {
    if (typeof data !== 'string') return;
    try {
      const parsed = JSON.parse(data) as { hostKey?: ProbedHostKey; serverVersion?: string };
      if (parsed.hostKey && parsed.serverVersion) hostKey = parsed.hostKey;
    } catch {
      return;
    }
  });

  conn.write(JSON.stringify({ op: 'hello', clientVersion: CLIENT_VERSION }));
  off();
  conn.close();
  return hostKey;
}
