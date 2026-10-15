import { SshHostKey, type SshKeyAlgorithm } from '../SshHostKey';

export interface HostKeyFileAccess {
  exists(path: string): boolean;
  read(path: string): string | null;
  write(path: string, content: string, secret: boolean): void;
  writeDeferred(path: string, produce: () => string, secret: boolean, declaredSize: number): void;
}

interface HostKeyKind {
  readonly type: string;
  readonly algorithm: SshKeyAlgorithm;
  readonly bits?: number;
  readonly deferred: boolean;
  readonly privateSize: number;
  readonly publicSize: number;
}

export const HOST_KEY_KINDS: readonly HostKeyKind[] = [
  { type: 'rsa', algorithm: 'ssh-rsa', bits: 3072, deferred: true, privateSize: 2602, publicSize: 569 },
  { type: 'ecdsa', algorithm: 'ecdsa-sha2-nistp256', deferred: false, privateSize: 505, publicSize: 179 },
  { type: 'ed25519', algorithm: 'ssh-ed25519', deferred: false, privateSize: 411, publicSize: 99 },
];

export function hostKeyPath(directory: string, separator: string, type: string): string {
  return `${directory}${separator}ssh_host_${type}_key`;
}

function publicFileLine(key: SshHostKey, hostname: string): string {
  return `${key.publicKeyLine} root@${hostname}\n`;
}

export function provisionHostKeyFiles(
  access: HostKeyFileAccess, directory: string, separator: string, hostname: string,
): void {
  for (const kind of HOST_KEY_KINDS) {
    const path = hostKeyPath(directory, separator, kind.type);
    if (access.exists(path) && access.exists(`${path}.pub`)) continue;
    if (!kind.deferred) {
      const key = SshHostKey.generate(hostname, kind.algorithm, kind.bits);
      access.write(`${path}.pub`, publicFileLine(key, hostname), false);
      access.write(path, key.privateKeyBlob, true);
      continue;
    }
    let generated: SshHostKey | null = null;
    const key = (): SshHostKey => (generated ??= SshHostKey.generate(hostname, kind.algorithm, kind.bits));
    access.writeDeferred(`${path}.pub`, () => publicFileLine(key(), hostname), false, kind.publicSize);
    access.writeDeferred(path, () => key().privateKeyBlob, true, kind.privateSize);
  }
}

const KIND_OF_FILE = /ssh_host_(rsa|ecdsa|ed25519)_key$/;

export function configuredHostKeyPaths(rawConfig: string, defaults: readonly string[]): string[] {
  const configured: string[] = [];
  for (const line of rawConfig.split('\n')) {
    const match = /^\s*HostKey\s+(\S+)/i.exec(line);
    if (match !== null) configured.push(match[1]);
  }
  return configured.length > 0 ? configured : [...defaults];
}

export function hostKeyFromFile(access: HostKeyFileAccess, privatePath: string): SshHostKey | null {
  const named = KIND_OF_FILE.exec(privatePath.replace(/\\/g, '/'))?.[1];
  let algorithm: SshKeyAlgorithm | null = HOST_KEY_KINDS.find((kind) => kind.type === named)?.algorithm ?? null;
  if (algorithm === null) {
    const first = access.read(`${privatePath}.pub`)?.trim().split(/\s+/)[0];
    algorithm = (first === 'ssh-rsa' || first === 'ssh-ed25519' || first?.startsWith('ecdsa-sha2-nistp'))
      ? first as SshKeyAlgorithm : null;
  }
  if (algorithm === null || !access.exists(privatePath)) return null;
  const resolvedAlgorithm = algorithm;
  return SshHostKey.deferred(resolvedAlgorithm, () => {
    const pub = access.read(`${privatePath}.pub`) ?? '';
    const priv = access.read(privatePath) ?? '';
    return { publicKey: pub.trim().split(/\s+/)[1] ?? '', privateKey: priv.trim() };
  });
}
