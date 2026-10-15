import { SshHostKey, type SshKeyAlgorithm } from '../SshHostKey';

export function offersRsaHostKey(hostKeyAlgorithms: readonly string[] | undefined): boolean {
  return (hostKeyAlgorithms ?? []).some((name) => name === 'ssh-rsa' || name.startsWith('rsa-sha2-'));
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
