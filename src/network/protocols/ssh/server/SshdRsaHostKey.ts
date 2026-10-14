import { SshHostKey, type SshKeyAlgorithm } from '../SshHostKey';
import { sshdAlgorithmPreferences } from './SshdAlgorithmDirectives';

export interface HostKeyFileStore {
  read(path: string): string | null;
  write(path: string, content: string, privateKey: boolean): void;
}

export function offersRsaHostKey(hostKeyAlgorithms: readonly string[] | undefined): boolean {
  return (hostKeyAlgorithms ?? []).some((name) => name === 'ssh-rsa' || name.startsWith('rsa-sha2-'));
}

export function rsaHostKeysFor(
  rawConfig: string,
  hostname: string,
  store: HostKeyFileStore,
  privatePath: string,
): SshHostKey[] {
  if (!offersRsaHostKey(sshdAlgorithmPreferences(rawConfig).hostKey)) return [];
  const pub = store.read(`${privatePath}.pub`);
  const priv = store.read(privatePath);
  if (pub && priv) {
    return [SshHostKey.fromFiles(pub.trim().split(/\s+/)[1] ?? pub.trim(), priv.trim(), 'ssh-rsa')];
  }
  const generated = SshHostKey.generate(hostname, 'ssh-rsa', 2048);
  store.write(`${privatePath}.pub`, generated.publicKeyLine + '\n', false);
  store.write(privatePath, generated.privateKeyBlob, true);
  return [generated];
}

export class AdditionalRsaHostKey {
  private cached: { hostname: string; key: SshHostKey } | null = null;

  keysFor(hostname: string, primary: SshKeyAlgorithm, offered: readonly string[] | undefined): SshHostKey[] {
    if (primary === 'ssh-rsa' || !offersRsaHostKey(offered)) return [];
    if (this.cached?.hostname !== hostname) {
      this.cached = { hostname, key: SshHostKey.generate(hostname, 'ssh-rsa', 2048) };
    }
    return [this.cached.key];
  }
}
