import type { CommandTrie } from '../CommandTrie';
import type { KeypairService } from '../../router/security/KeypairService';

export interface HuaweiKeypairHost {
  getHostname(): string;
  getKeypairService(): KeypairService;
  _refreshSshAvailability?(): void;
}

export function registerHuaweiKeypairCommands(
  trie: CommandTrie, host: () => HuaweiKeypairHost | null | undefined,
): void {
  trie.register('rsa local-key-pair create', 'Generate RSA key pair', () => {
    const dev = host();
    if (!dev) return '';
    const pair = dev.getKeypairService().generate(`${dev.getHostname()}_Host`, 'rsa', 2048);
    dev._refreshSshAvailability?.();
    return [
      `Info: The name of the key pair will be: ${pair.name}`,
      `The range of public key size is (512 ~ 2048).`,
      `Input the bits in the modulus[default = 2048]: ${pair.modulusBits}`,
      `Info: Keys are generated. Fingerprint: ${pair.fingerprint}`,
    ].join('\n');
  });
  trie.register('rsa local-key-pair destroy', 'Destroy the RSA key pair', () => {
    const dev = host();
    if (!dev) return '';
    const ks = dev.getKeypairService();
    const pairs = ks.list().filter((k) => k.algo === 'rsa');
    if (pairs.length === 0) return 'Error: The RSA host key does not exist.';
    for (const p of pairs) ks.destroy(p.name);
    dev._refreshSshAvailability?.();
    return [
      `% The name for the keys which will be destroyed is ${dev.getHostname()}_Host.`,
      'Info: The key pair has been destroyed.',
    ].join('\n');
  });
  trie.register('dsa local-key-pair create', 'Generate DSA key pair', () => {
    const dev = host();
    if (!dev) return '';
    const pair = dev.getKeypairService().generate(`${dev.getHostname()}_Host`, 'dsa', 1024);
    return [
      `Info: The name of the key pair will be: ${pair.name}`,
      `Info: Keys are generated. Fingerprint: ${pair.fingerprint}`,
    ].join('\n');
  });
}
