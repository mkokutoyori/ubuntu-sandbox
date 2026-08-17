import type { CommandSpec } from '../../CommandTable';

export interface CryptoClearHost {
  clearAllSecurityAssociations(): void;
  clearSecurityAssociationsForPeer(peer: string): void;
}

function host(device: unknown): CryptoClearHost | null {
  const candidate = device as CryptoClearHost | null;
  return typeof candidate?.clearAllSecurityAssociations === 'function' ? candidate : null;
}

function clearAll(id: string, family: string, description: string): CommandSpec {
  return {
    id,
    path: ['clear', 'crypto', family, 'sa'],
    description,
    modes: ['privileged'],
    minPrivilege: 15,
    run: (session) => { host(session.device)?.clearAllSecurityAssociations(); return ''; },
  };
}

export const CLEAR_CRYPTO_SESSION: CommandSpec = {
  id: 'clear-crypto-session',
  path: ['clear', 'crypto', 'session', { name: 'selector', type: 'REST', optional: true }],
  description: 'Clear IPSec session',
  modes: ['privileged'],
  minPrivilege: 15,
  run: (session, args) => {
    const target = host(session.device);
    if (!target) return '';

    const words = (args.selector ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words[0] === 'remote') {
      target.clearSecurityAssociationsForPeer(words[1]);
    } else {
      target.clearAllSecurityAssociations();
    }
    return '';
  },
};

export const CLEAR_CRYPTO_FAMILY: readonly CommandSpec[] = Object.freeze([
  clearAll('clear-crypto-isakmp-sa', 'isakmp', 'Clear all IKE SAs'),
  clearAll('clear-crypto-ipsec-sa', 'ipsec', 'Clear all IPSec SAs'),
  clearAll('clear-crypto-ikev2-sa', 'ikev2', 'Clear all IKEv2 SAs'),
  CLEAR_CRYPTO_SESSION,
]);

export const CLEAR_CRYPTO_PATHS: readonly string[] = Object.freeze(
  CLEAR_CRYPTO_FAMILY.map(spec =>
    spec.path.filter((s): s is string => typeof s === 'string').join(' ')),
);
