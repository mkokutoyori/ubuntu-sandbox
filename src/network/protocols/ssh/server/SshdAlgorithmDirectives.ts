import { sshClientAlgorithms } from '../SshConnectOptions';
import type { SshAlgorithmPreferences } from '../transport/SshTransport';

const ALGORITHM_DIRECTIVE = /^(kexalgorithms|hostkeyalgorithms|ciphers|macs)\s/i;

export function sshdAlgorithmPreferences(rawConfig: string): SshAlgorithmPreferences {
  const directives: string[] = [];
  for (const raw of rawConfig.split('\n')) {
    const line = raw.trim();
    if (/^match\s/i.test(line)) break;
    if (ALGORITHM_DIRECTIVE.test(line)) directives.push(line);
  }
  return sshClientAlgorithms(directives);
}
