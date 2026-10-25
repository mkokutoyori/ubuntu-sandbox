import type { RsyslogHost } from '../engine/Host';
import { CryptoProvider, type CryptoEnvironment, type CryptoParameters, type CryptoProviderName } from './CryptoProvider';

export const CRYPTO_PROVIDER_NAMES: readonly CryptoProviderName[] = ['gcry', 'ossl'];

export function cryptoEnvironment(host: RsyslogHost, report: (text: string, code: number) => void): CryptoEnvironment {
  return {
    files: host.files,
    random: () => host.random(),
    runKeyProgram: (program) => {
      const child = host.process?.run?.([program]);
      return child === undefined || child.output === undefined ? null : { output: child.output, exitCode: child.exitCode };
    },
    report,
  };
}

export function isCryptoProviderName(name: string): name is CryptoProviderName {
  return (CRYPTO_PROVIDER_NAMES as readonly string[]).includes(name);
}

export function configureCryptoProvider(
  name: CryptoProviderName, parameters: CryptoParameters, host: RsyslogHost, report: (text: string, code: number) => void,
): CryptoProvider | null {
  return CryptoProvider.configure(name, parameters, cryptoEnvironment(host, report));
}

export function cryptoParameterDescriptors(name: CryptoProviderName, prefix: 'cry.' | 'queue.cry.'): readonly { readonly name: string; readonly type: 'word' }[] {
  const names = name === 'gcry' ? ['key', 'keyfile', 'keyprogram', 'mode', 'algo'] : ['key', 'keyfile', 'mode', 'algo'];
  return names.map((parameter) => ({ name: `${prefix}${parameter}`, type: 'word' as const }));
}
