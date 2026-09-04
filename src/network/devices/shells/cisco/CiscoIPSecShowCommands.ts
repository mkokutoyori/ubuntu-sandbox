/**
 * CiscoIPSecShowCommands — register "show crypto" commands on a CommandTrie
 *
 * Delegates to IPSecEngine show methods.
 */

import { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';

import type { CommandSpec } from '@/cli/CommandTable';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';
import { SHOW_CRYPTO_FAMILY } from '@/cli/commands/show/showCrypto';

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
  trie.register('show crypto gdoi', 'Display GDOI GET-VPN group status', () => {
    const e = eng();
    if (!e) return 'IPSec not configured.';
    const groups = e.getGdoiGroups() as Map<string, {
      name: string; identityNumber?: number; groupAddress?: string;
      transformSetName?: string; localAddress?: string; keyServerAddress?: string;
      isKeyServer: boolean;
    }>;
    if (groups.size === 0) return 'No GDOI groups configured.';
    return [...groups.values()].map((g) => {
      const lines = [
        `Group Name: ${g.name}`,
        `Group Identity: ${g.identityNumber ?? '<none>'}`,
        `Group Members: ${g.isKeyServer ? 'Key Server' : 'Group Member'}`,
      ];
      if (g.isKeyServer) {
        const msa = g.groupAddress ? e.findMulticastSAForOutbound?.(g.groupAddress) : null;
        lines.push(`  Group Address: ${g.groupAddress ?? '<none>'}`);
        lines.push(`  Transform Set: ${g.transformSetName ?? '<none>'}`);
        lines.push(`  Registered Members: ${msa?.receivers?.length ?? 0}`);
      } else {
        lines.push(`  Key Server: ${g.keyServerAddress ?? '<none>'}`);
      }
      return lines.join('\n');
    }).join('\n\n');
  });
  trie.registerGreedy('show crypto ikev2 sa detailed', 'Detailed IKEv2 SAs', () =>
    eng()?.showCryptoIKEv2SADetail?.() ?? eng()?.showCryptoIKEv2SA?.() ?? 'IPSec not configured.');
  trie.register('show crypto ikev2 stats', 'IKEv2 statistics', () => {
    const e = eng();
    if (!e) return 'IPSec not configured.';
    const v = e.stats.get();
    const dbg = e as unknown as { ikev2SADB: Map<string, unknown> };
    const ikev2Count = dbg.ikev2SADB.size;
    return [
      `Crypto IKEv2 statistics:`,
      `  Active SAs: ${ikev2Count}`,
      `  Inbound packets processed: ${v.inboundProcessed}`,
      `  Inbound packets dropped: ${v.inboundDropped}`,
      `  Inbound packets rejected: ${v.inboundRejected}`,
      `  Outbound packets processed: ${v.outboundProcessed ?? 0}`,
      `  Outbound packets dropped: ${v.outboundDropped ?? 0}`,
      `  Outbound packets rejected: ${v.outboundRejected ?? 0}`,
    ].join('\n');
  });
  trie.register('show crypto eli', 'Encryption Library Information', () => {
    const e = eng();
    const sessions = e ? (e as unknown as { ikeSADB: Map<string, unknown>; ikev2SADB: Map<string, unknown>; ipsecSADB: Map<string, unknown[]> }) : null;
    const ikeCount = (sessions?.ikeSADB.size ?? 0) + (sessions?.ikev2SADB.size ?? 0);
    let ipsecCount = 0;
    if (sessions) for (const arr of sessions.ipsecSADB.values()) ipsecCount += arr.length;
    return [
      'Hardware Encryption : ACTIVE',
      '',
      'Number of hardware crypto engines = 1.',
      '',
      'CryptoEngine Onboard VPN details: state = Active',
      ' Capability     : IPPCP, DES, 3DES, AES, RSA',
      `  IKE Sessions   : ${ikeCount} active, 100 max`,
      `  IPSec Sessions : ${ipsecCount} active, 200 max`,
      '  DH Groups      : 1, 2, 5, 14, 19, 20',
    ].join('\n');
  });
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

  trie.register('show crypto pki certificates verbose', 'Detailed PKI certificates', () => {
    const sec = (getRouter() as unknown as { [s: symbol]: { pkiTrustpoints?: Map<string, { name: string; subjectName?: string; enrollmentUrl?: string; revocationCheck?: string; rsaKeypair?: string; importedCertificate?: { format: string; importedAtMs: number } }> } | undefined })[Symbol.for('CiscoSecurityConfig')];
    const tps = sec?.pkiTrustpoints;
    if (!tps || tps.size === 0) return 'No PKI certificates installed';
    return [...tps.values()].map(tp => [
      `Trustpoint ${tp.name} (verbose):`,
      `  Subject Name: ${tp.subjectName ?? '<not configured>'}`,
      `  Enrollment URL: ${tp.enrollmentUrl ?? 'terminal'}`,
      `  Revocation Check: ${tp.revocationCheck ?? 'crl'}`,
      `  RSA Keypair: ${tp.rsaKeypair ?? '<auto>'}`,
      tp.importedCertificate
        ? `  Imported Certificate (${tp.importedCertificate.format}): ${new Date(tp.importedCertificate.importedAtMs).toISOString()}`
        : '  Certificate: pending enrollment',
      '  Validity: 365 days',
      `  Certificate fingerprint (SHA1): ${'AA:BB:CC:DD:EE:FF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB'}`,
    ].join('\n')).join('\n\n');
  });

  const debugSvc = () => getRouter().getDebugService();
  const PKI_REFUS = '% Crypto PKI has no trace point on this platform:'
    + ' the certificate engine publishes no enrolment or validation event';
  trie.registerGreedy('debug crypto pki', 'Enable PKI debug', () => PKI_REFUS);
  trie.registerGreedy('no debug crypto pki', 'Disable PKI debug', () => PKI_REFUS);
  trie.register('show debugging', 'Display active debug flags', () => debugSvc().format());
  trie.register('show debug condition', 'Display standing debug conditions',
    () => debugSvc().formatConditions());
  trie.register('show debugging condition', 'Display standing debug conditions',
    () => debugSvc().formatConditions());

  const nhrp = () => getRouter().getNhrpService();
  trie.register('show ip nhrp', 'Display NHRP cache', () => nhrp().formatCache());
  trie.register('show ip nhrp brief', 'NHRP cache brief', () => nhrp().formatCacheBrief());
  trie.register('show ip nhrp summary', 'NHRP cache summary', () => nhrp().formatSummary());
  const dmvpn = () => getRouter().getDmvpnService();
  trie.register('show dmvpn', 'Display DMVPN status', () => dmvpn().formatSessions(false));
  trie.register('show dmvpn detail', 'Detailed DMVPN status', () => dmvpn().formatSessions(true));
}


const DEJA_AU_SOCLE = new Set(
  SHOW_CRYPTO_FAMILY.map(spec =>
    spec.path.filter((step): step is string => typeof step === 'string').join(' ')));

export function cryptoShowSpecs(ctx: Parameters<typeof registerIPSecShowCommands>[1]): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => registerIPSecShowCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['user', 'privileged'], minPrivilege: 1,
      restDescription: 'Filter',
      restDescriptionFor: (path) => ({
        'show crypto ipsec sa interface': 'Interface name',
        'show crypto map interface': 'Interface name',
      })[path],
      skip: (path) => !path.startsWith('show crypto') || DEJA_AU_SOCLE.has(path),
    },
  );
}
