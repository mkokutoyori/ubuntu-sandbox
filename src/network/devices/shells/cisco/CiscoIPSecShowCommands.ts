/**
 * CiscoIPSecShowCommands — register "show crypto" commands on a CommandTrie
 *
 * Delegates to IPSecEngine show methods.
 */

import { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';

export function registerIPSecShowCommands(
  trie: CommandTrie,
  getRouter: () => Router,
): void {
  const eng = () => (getRouter() as any)._getIPSecEngineInternal?.();

  trie.register('show crypto isakmp sa', 'Display IKEv1 ISAKMP SAs', () =>
    eng()?.showCryptoISAKMPSA() ?? 'IPSec not configured.');

  trie.register('show crypto isakmp sa detail', 'Display detailed IKEv1 ISAKMP SAs', () =>
    eng()?.showCryptoISAKMPSADetail() ?? 'IPSec not configured.');

  trie.register('show crypto isakmp policy', 'Display IKEv1 ISAKMP policies', () =>
    eng()?.showCryptoISAKMPPolicy() ?? 'IPSec not configured.');

  trie.register('show crypto ipsec sa', 'Display IPSec SAs', () =>
    eng()?.showCryptoIPSecSA() ?? 'IPSec not configured.');

  trie.register('show crypto ipsec transform-set', 'Display IPSec transform sets', () =>
    eng()?.showCryptoIPSecTransformSet() ?? 'IPSec not configured.');

  trie.register('show crypto map', 'Display crypto maps', () =>
    eng()?.showCryptoMap() ?? 'IPSec not configured.');

  trie.register('show crypto ikev2 sa', 'Display IKEv2 SAs', () =>
    eng()?.showCryptoIKEv2SA() ?? 'IPSec not configured.');

  trie.register('show crypto ikev2 sa detail', 'Display detailed IKEv2 SAs', () =>
    eng()?.showCryptoIKEv2SADetail() ?? 'IPSec not configured.');

  trie.register('show crypto session', 'Display crypto session status', () =>
    eng()?.showCryptoSession() ?? 'IPSec not configured.');
}
