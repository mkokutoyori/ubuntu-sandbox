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

  trie.register('show crypto isakmp', 'Display IKE global config', () =>
    eng()?.showCryptoISAKMP() ?? 'IPSec not configured.');

  trie.register('show crypto ipsec sa', 'Display IPSec SAs', () =>
    eng()?.showCryptoIPSecSA() ?? 'IPSec not configured.');

  trie.register('show crypto ipsec sa detail', 'Display detailed IPSec SAs', () =>
    eng()?.showCryptoIPSecSADetail() ?? 'IPSec not configured.');

  trie.register('show crypto ipsec transform-set', 'Display IPSec transform sets', () =>
    eng()?.showCryptoIPSecTransformSet() ?? 'IPSec not configured.');

  trie.register('show crypto ipsec profile', 'Display IPSec profiles', () =>
    eng()?.showCryptoIPSecProfile() ?? 'IPSec not configured.');

  trie.register('show crypto map', 'Display crypto maps', () =>
    eng()?.showCryptoMap() ?? 'IPSec not configured.');

  trie.register('show crypto dynamic-map', 'Display dynamic crypto maps', () =>
    eng()?.showCryptoDynamicMap() ?? 'IPSec not configured.');

  trie.register('show crypto ikev2 sa', 'Display IKEv2 SAs', () =>
    eng()?.showCryptoIKEv2SA() ?? 'IPSec not configured.');

  trie.register('show crypto ikev2 sa detail', 'Display detailed IKEv2 SAs', () =>
    eng()?.showCryptoIKEv2SADetail() ?? 'IPSec not configured.');

  trie.register('show crypto session', 'Display crypto session status', () =>
    eng()?.showCryptoSession() ?? 'IPSec not configured.');

  trie.register('show crypto ipsec security-policy', 'Display IPSec security policies (SPD)', () =>
    eng()?.showSecurityPolicy() ?? 'IPSec not configured.');

  trie.register('show crypto engine brief', 'Display crypto engine brief', () =>
    eng()?.showCryptoEngineBrief() ?? 'IPSec not configured.');

  trie.register('show crypto engine configuration', 'Display crypto engine configuration', () =>
    eng()?.showCryptoEngineConfiguration() ?? 'IPSec not configured.');

  trie.register('show crypto ikev2 proposal', 'Display IKEv2 proposals', () =>
    eng()?.showCryptoIKEv2Proposal() ?? 'IPSec not configured.');

  trie.register('show crypto ikev2 policy', 'Display IKEv2 policies', () =>
    eng()?.showCryptoIKEv2Policy() ?? 'IPSec not configured.');

  trie.register('show crypto ikev2 profile', 'Display IKEv2 profiles', () =>
    eng()?.showCryptoIKEv2Profile() ?? 'IPSec not configured.');

  trie.register('show crypto ikev2 keyring', 'Display IKEv2 keyrings', () =>
    eng()?.showCryptoIKEv2Keyring() ?? 'IPSec not configured.');

  trie.register('show crypto isakmp key', 'Display ISAKMP pre-shared keys', () =>
    eng()?.showCryptoISAKMPKey() ?? 'IPSec not configured.');

  trie.register('show crypto isakmp profile', 'Display ISAKMP profiles', () =>
    'No active ISAKMP profile sessions');
  trie.registerGreedy('show crypto ikev2 sa detailed', 'Detailed IKEv2 SAs', () =>
    eng()?.showCryptoIKEv2SADetail?.() ?? eng()?.showCryptoIKEv2SA?.() ?? 'IPSec not configured.');
  trie.register('show crypto ikev2 stats', 'IKEv2 statistics', () => {
    const e = eng();
    if (!e) return 'IPSec not configured.';
    const stats = (e as unknown as { getIKEv2Stats?: () => Record<string, number> }).getIKEv2Stats?.();
    if (!stats) return 'Crypto IKEv2 stats not available';
    return Object.entries(stats).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  });
  trie.register('show crypto eli', 'Encryption Library Information', () => 'Hardware Encryption Layer: not available\nCryptographic API library: software');
  trie.register('show crypto engine connections active', 'Active crypto engine connections', () => {
    const e = eng();
    if (!e) return 'No crypto engine connections active.';
    return e.showCryptoSession();
  });
  trie.registerGreedy('show crypto session detail', 'Detailed crypto sessions', () =>
    eng()?.showCryptoSession?.() ?? 'IPSec not configured.');
  trie.registerGreedy('show crypto ipsec sa interface', 'IPSec SAs for an interface', () =>
    eng()?.showCryptoIPSecSADetail?.() ?? eng()?.showCryptoIPSecSA?.() ?? 'IPSec not configured.');
  trie.register('show crypto ipsec security-association lifetime', 'IPSec SA lifetime', () => {
    const e = eng() as unknown as { globalSALifetimeSeconds?: number; globalSALifetimeKB?: number } | undefined;
    return `Security association lifetime: ${e?.globalSALifetimeKB ?? 4608000} kilobytes / ${e?.globalSALifetimeSeconds ?? 3600} seconds`;
  });
  trie.registerGreedy('show crypto map interface', 'Crypto maps on an interface', () =>
    eng()?.showCryptoMap?.() ?? 'No crypto maps configured');

  trie.register('show crypto pki certificates verbose', 'Detailed PKI certificates', () => 'No PKI certificates installed');

  trie.registerGreedy('clear crypto sa', 'Clear IPSec SAs', () => {
    const e = eng();
    if (!e) return 'IPSec not configured.';
    (e as unknown as { clearAllSAs?: () => void }).clearAllSAs?.();
    return '';
  });
  trie.register('clear crypto isakmp', 'Clear ISAKMP SAs', () => '');
  trie.register('clear crypto isakmp sa', 'Clear ISAKMP SAs', () => '');
  trie.register('clear crypto session', 'Clear crypto sessions', () => '');
  trie.register('clear crypto ikev2 sa', 'Clear IKEv2 SAs', () => '');
  trie.registerGreedy('debug crypto isakmp', 'Enable ISAKMP debug', () => 'Crypto ISAKMP debugging is on');
  trie.registerGreedy('debug crypto ipsec', 'Enable IPSec debug', () => 'Crypto IPSec debugging is on');
  trie.registerGreedy('debug crypto ikev2', 'Enable IKEv2 debug', () => 'Crypto IKEv2 debugging is on');
  trie.registerGreedy('debug crypto pki', 'Enable PKI debug', () => 'Crypto PKI debugging is on');
  trie.registerGreedy('no debug crypto isakmp', 'Disable ISAKMP debug', () => 'Crypto ISAKMP debugging is off');
  trie.registerGreedy('no debug crypto ipsec', 'Disable IPSec debug', () => 'Crypto IPSec debugging is off');
  trie.registerGreedy('no debug crypto ikev2', 'Disable IKEv2 debug', () => 'Crypto IKEv2 debugging is off');
  trie.registerGreedy('no debug crypto pki', 'Disable PKI debug', () => 'Crypto PKI debugging is off');
  trie.register('undebug all', 'Disable all debug', () => 'All possible debugging has been turned off');

  trie.register('show dmvpn', 'Display DMVPN status', () => 'No DMVPN sessions');
  trie.register('show dmvpn detail', 'Detailed DMVPN status', () => 'No DMVPN sessions');
  trie.register('show ip nhrp', 'Display NHRP cache', () => 'IP-NHRP table contains no entries');
  trie.register('show ip nhrp brief', 'NHRP cache brief', () => 'IP-NHRP table contains no entries');
}
