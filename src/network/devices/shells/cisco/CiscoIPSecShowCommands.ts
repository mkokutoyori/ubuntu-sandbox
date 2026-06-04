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

  trie.registerGreedy('clear crypto sa', 'Clear IPSec SAs', (args) => {
    const e = eng();
    if (!e) return 'IPSec not configured.';
    const peer = parsePeerFromArgs(args);
    const n = e.clearIPSecSAs(peer);
    return n === 0 ? 'No matching IPSec SAs found' : `Cleared ${n} IPSec SA${n === 1 ? '' : 's'}`;
  });
  trie.registerGreedy('clear crypto isakmp', 'Clear ISAKMP SAs', (args) => {
    const e = eng();
    if (!e) return 'IPSec not configured.';
    const peer = parsePeerFromArgs(args);
    const n = e.clearISAKMPSAs(peer);
    return n === 0 ? 'No matching ISAKMP SAs found' : `Cleared ${n} ISAKMP SA${n === 1 ? '' : 's'}`;
  });
  trie.registerGreedy('clear crypto isakmp sa', 'Clear ISAKMP SAs', (args) => {
    const e = eng();
    if (!e) return 'IPSec not configured.';
    const peer = parsePeerFromArgs(args);
    const n = e.clearISAKMPSAs(peer);
    return n === 0 ? 'No matching ISAKMP SAs found' : `Cleared ${n} ISAKMP SA${n === 1 ? '' : 's'}`;
  });
  trie.registerGreedy('clear crypto session', 'Clear crypto sessions', () => {
    const e = eng();
    if (!e) return 'IPSec not configured.';
    const n = e.clearSessions();
    return n === 0 ? 'No active crypto sessions' : `Cleared ${n} crypto session entries`;
  });
  trie.registerGreedy('clear crypto ikev2 sa', 'Clear IKEv2 SAs', (args) => {
    const e = eng();
    if (!e) return 'IPSec not configured.';
    const peer = parsePeerFromArgs(args);
    const n = e.clearIKEv2SAs(peer);
    return n === 0 ? 'No matching IKEv2 SAs found' : `Cleared ${n} IKEv2 SA${n === 1 ? '' : 's'}`;
  });

  const debugSvc = () => getRouter().getDebugService();
  trie.registerGreedy('debug crypto isakmp', 'Enable ISAKMP debug', () => {
    eng()?.setDebug('isakmp', true);
    return debugSvc().enable('crypto.isakmp');
  });
  trie.registerGreedy('debug crypto ipsec', 'Enable IPSec debug', () => {
    eng()?.setDebug('ipsec', true);
    return debugSvc().enable('crypto.ipsec');
  });
  trie.registerGreedy('debug crypto ikev2', 'Enable IKEv2 debug', () => {
    eng()?.setDebug('ikev2', true);
    return debugSvc().enable('crypto.ikev2');
  });
  trie.registerGreedy('debug crypto pki', 'Enable PKI debug', (args) => {
    const scope = args.join(' ').toLowerCase();
    if (scope.startsWith('transactions')) return debugSvc().enable('crypto.pki.transactions');
    if (scope.startsWith('messages')) return debugSvc().enable('crypto.pki.messages');
    return debugSvc().enable('crypto.pki');
  });
  trie.registerGreedy('no debug crypto isakmp', 'Disable ISAKMP debug', () => {
    eng()?.setDebug('isakmp', false);
    return debugSvc().disable('crypto.isakmp');
  });
  trie.registerGreedy('no debug crypto ipsec', 'Disable IPSec debug', () => {
    eng()?.setDebug('ipsec', false);
    return debugSvc().disable('crypto.ipsec');
  });
  trie.registerGreedy('no debug crypto ikev2', 'Disable IKEv2 debug', () => {
    eng()?.setDebug('ikev2', false);
    return debugSvc().disable('crypto.ikev2');
  });
  trie.registerGreedy('no debug crypto pki', 'Disable PKI debug', () => debugSvc().disable('crypto.pki'));
  trie.register('undebug all', 'Disable all debug', () => debugSvc().disableAll());
  trie.register('show debugging', 'Display active debug flags', () => debugSvc().format());

  const nhrp = () => getRouter().getNhrpService();
  trie.register('show ip nhrp', 'Display NHRP cache', () => nhrp().formatCache());
  trie.register('show ip nhrp brief', 'NHRP cache brief', () => nhrp().formatCacheBrief());
  trie.register('show ip nhrp summary', 'NHRP cache summary', () => nhrp().formatSummary());
  const dmvpn = () => getRouter().getDmvpnService();
  trie.register('show dmvpn', 'Display DMVPN status', () => dmvpn().formatSessions(false));
  trie.register('show dmvpn detail', 'Detailed DMVPN status', () => dmvpn().formatSessions(true));
}

function parsePeerFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'peer' && args[i + 1]) return args[i + 1];
    if (/^\d+\.\d+\.\d+\.\d+$/.test(args[i])) return args[i];
  }
  return undefined;
}
