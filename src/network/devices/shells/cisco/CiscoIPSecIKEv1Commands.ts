/**
 * CiscoIPSecIKEv1Commands — IKEv1 / ISAKMP global config commands
 *
 * Handles:
 *   crypto isakmp policy N        → config-isakmp mode
 *   crypto isakmp key ... address ...
 *   crypto isakmp nat keepalive N
 *   crypto isakmp keepalive N R [periodic|on-demand]
 *   crypto ipsec transform-set    → config-tfset mode
 *   crypto map NAME SEQ ipsec-isakmp  → config-crypto-map mode
 *   crypto dynamic-map NAME SEQ   → config-crypto-map mode
 *   crypto map NAME SEQ ipsec-isakmp dynamic DYNMAP
 *   crypto ipsec profile NAME     → config-ipsec-profile mode
 */

import { CommandTrie } from '../CommandTrie';
import type { CiscoShellContext } from './CiscoConfigCommands';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { AdapterKeyword } from '@/cli/commands/trieAdapter';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';

const IPV4_LITERAL_RE = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
function isIPv4Literal(s: string): boolean { return IPV4_LITERAL_RE.test(s); }

// ─── Helper: get or create IPSec engine on the router ───────────────

function eng(ctx: CiscoShellContext) {
  return (ctx.r() as any)._getOrCreateIPSecEngine();
}

// ─── Global config mode: crypto isakmp / ipsec ───────────────────────

export function buildIPSecGlobalCommands(trie: CommandTrie, ctx: CiscoShellContext): void {

  // ── crypto isakmp policy N ────────────────────────────────────────
  trie.registerGreedy('crypto isakmp policy', 'Define an IKE policy', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const priority = parseInt(args[0], 10);
    if (isNaN(priority)) return '% Invalid priority.';
    eng(ctx).getOrCreateISAKMPPolicy(priority);
    ctx.setSelectedISAKMPPriority(priority);
    ctx.setMode('config-isakmp');
    return '';
  });

  // ── crypto isakmp key KEY address IP ─────────────────────────────
  /**
   * `crypto isakmp key KEY {address IP | hostname NOM}`
   *
   * La forme `hostname` était refusée, alors que tout ce qu'il lui faut
   * existait déjà : un pair configuré `crypto isakmp identity hostname`
   * annonce son nom dans l'offre IKE, et le répondeur cherche la clé par
   * cette identité AVANT l'adresse source. Il ne manquait que la
   * commande qui pose la clé sous un nom — l'authentification par nom
   * marche donc pour de vrai, elle n'est pas mémorisée pour l'affichage.
   */
  trie.registerGreedy('crypto isakmp key', 'Set IKE pre-shared key', (args) => {
    const idx = args.findIndex((a) => a === 'address' || a === 'hostname');
    if (idx <= 0) {
      return '% Incomplete command. Usage: crypto isakmp key KEY {address IP | hostname NAME}';
    }
    const cible = args[idx + 1];
    if (!cible) return '% Incomplete command.';
    const key = args.slice(0, idx).join(' ');
    if (args[idx] === 'hostname') {
      // Un nom, pas une adresse : le refuser ici évite qu'une faute de
      // frappe soit stockée comme une identité que rien n'annoncera.
      if (isIPv4Literal(cible)) return "% Invalid input detected at '^' marker.";
      // Minuscule à la pose : un nom d'hôte est insensible à la casse
      // (RFC 4343), et la table `ip host` de l'équipement le range déjà
      // ainsi. Sans cette normalisation, `hostname rB` ne se retrouvait
      // pas depuis un `ip host rB …` rangé en `rb` — mesuré : le tunnel
      // ne montait pas alors que les deux côtés étaient bien configurés.
      eng(ctx).addPreSharedKey(cible.toLowerCase(), key, true);
      return '';
    }
    eng(ctx).addPreSharedKey(cible, key);
    return '';
  });

  // ── crypto isakmp nat keepalive N ─────────────────────────────────
  trie.registerGreedy('crypto isakmp nat keepalive', 'Configure NAT keepalive interval', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const n = parseInt(args[0], 10);
    if (!isNaN(n)) eng(ctx).setNATKeepalive(n);
    return '';
  });

  // ── crypto isakmp keepalive N R [periodic|on-demand] ─────────────
  trie.register('crypto isakmp invalid-spi-recovery', 'Enable invalid SPI recovery', () => {
    eng(ctx).setInvalidSpiRecovery(true);
    return '';
  });
  trie.registerGreedy('crypto isakmp identity', 'Set IKE identity', (args) => {
    eng(ctx).setIsakmpIdentity(args.join(' ').toLowerCase());
    return '';
  });

  // ── no crypto isakmp policy N ────────────────────────────────────
  trie.registerGreedy('no crypto isakmp policy', 'Remove an IKE policy', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const priority = parseInt(args[0], 10);
    if (isNaN(priority)) return '% Invalid priority.';
    eng(ctx).removeISAKMPPolicy(priority);
    return '';
  });

  // ── no crypto isakmp key KEY {address IP | hostname NOM} ────────
  // La forme `hostname` retirait l'entrée `0.0.0.0` au lieu de la
  // bonne : `indexOf('address')` ne la voyait pas et le repli sur le
  // joker s'appliquait, si bien que la clé nommée survivait à son
  // propre `no` — et qu'une clé joker configurée disparaissait à sa
  // place.
  trie.registerGreedy('no crypto isakmp key', 'Remove IKE pre-shared key', (args) => {
    const idx = args.findIndex((a) => a === 'address' || a === 'hostname');
    const cible = idx >= 0 ? (args[idx + 1] || '0.0.0.0') : '0.0.0.0';
    eng(ctx).removePreSharedKey(args[idx] === 'hostname' ? cible.toLowerCase() : cible);
    return '';
  });

  // ── no crypto ipsec transform-set NAME ──────────────────────────
  trie.registerGreedy('no crypto ipsec transform-set', 'Remove IPSec transform set', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    eng(ctx).removeTransformSet(args[0]);
    return '';
  });

  // ── no crypto map NAME [SEQ] ────────────────────────────────────
  trie.registerGreedy('no crypto map', 'Remove crypto map or entry', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const mapName = args[0];
    if (args.length >= 2) {
      const seq = parseInt(args[1], 10);
      if (!isNaN(seq)) {
        eng(ctx).removeCryptoMapEntry(mapName, seq);
        return '';
      }
    }
    eng(ctx).removeCryptoMap(mapName);
    return '';
  });

  // ── no crypto dynamic-map NAME ──────────────────────────────────
  trie.registerGreedy('no crypto dynamic-map', 'Remove dynamic crypto map', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    eng(ctx).removeDynamicCryptoMap(args[0]);
    return '';
  });

  // ── no crypto ipsec profile NAME ────────────────────────────────
  trie.registerGreedy('no crypto ipsec profile', 'Remove IPSec profile', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    eng(ctx).removeIPSecProfile(args[0]);
    return '';
  });

  // ── crypto ipsec security-association lifetime seconds N ─────────
  trie.registerGreedy('crypto ipsec security-association lifetime seconds', 'Set global IPSec SA lifetime (seconds)', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const n = parseInt(args[0], 10);
    if (isNaN(n) || n < 120 || n > 86400) return '% Invalid value. Range: 120-86400';
    eng(ctx).setGlobalSALifetime(n);
    return '';
  });

  // ── crypto ipsec security-association lifetime kilobytes N ──────
  trie.registerGreedy('crypto ipsec security-association lifetime kilobytes', 'Set global IPSec SA lifetime (KB)', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const n = parseInt(args[0], 10);
    if (isNaN(n) || n < 1) return '% Invalid value.';
    eng(ctx).setGlobalSALifetimeKB(n);
    return '';
  });

  // ── crypto ipsec security-association replay window-size N ──────
  trie.registerGreedy('crypto ipsec security-association replay window-size', 'Set anti-replay window size', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const n = parseInt(args[0], 10);
    if (isNaN(n) || n < 0 || n > 1024) return '% Invalid value. Range: 0-1024';
    eng(ctx).setReplayWindowSize(n);
    return '';
  });

  // ── no crypto ipsec security-association replay ─────────────────
  trie.register('no crypto ipsec security-association replay', 'Disable anti-replay', () => {
    eng(ctx).setReplayWindowSize(0);
    return '';
  });

  // ── crypto ipsec security-association esn ──────────────────────
  trie.register('crypto ipsec security-association esn', 'Enable Extended Sequence Numbers (64-bit)', () => {
    eng(ctx).setESN(true);
    return '';
  });

  trie.register('no crypto ipsec security-association esn', 'Disable Extended Sequence Numbers', () => {
    eng(ctx).setESN(false);
    return '';
  });

  trie.registerGreedy('crypto isakmp profile', 'Define an ISAKMP profile', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    eng(ctx).getOrCreateISAKMPProfile(name);
    ctx.setSelectedISAKMPProfile(name);
    ctx.setMode('config-isakmp-profile');
    return '';
  });
  trie.registerGreedy('no crypto isakmp profile', 'Remove an ISAKMP profile', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    eng(ctx).removeISAKMPProfile(args[0]);
    return '';
  });

  // ── crypto keyring NAME ───────────────────────────────────────────
  trie.registerGreedy('crypto keyring', 'Define an ISAKMP keyring', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    eng(ctx).getOrCreateISAKMPKeyring(name);
    ctx.setSelectedISAKMPKeyring(name);
    ctx.setMode('config-keyring');
    return '';
  });
  trie.registerGreedy('no crypto keyring', 'Remove an ISAKMP keyring', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    eng(ctx).removeISAKMPKeyring(args[0]);
    return '';
  });

  // ── crypto isakmp aggressive-mode ───────────────────────────────
  trie.register('crypto isakmp aggressive-mode disable', 'Disable Aggressive Mode', () => {
    eng(ctx).setAggressiveMode(false);
    return '';
  });

  trie.register('no crypto isakmp aggressive-mode disable', 'Enable Aggressive Mode (default)', () => {
    eng(ctx).setAggressiveMode(true);
    return '';
  });

  // ── crypto isakmp keepalive ───────────────────────────────────
  trie.registerGreedy('crypto isakmp keepalive', 'Configure IKE DPD keepalive', (args) => {
    if (args.length < 2) return '% Usage: crypto isakmp keepalive INTERVAL RETRIES [periodic|on-demand]';
    const interval = parseInt(args[0], 10);
    const retries = parseInt(args[1], 10);
    if (isNaN(interval) || isNaN(retries)) return '% Invalid values.';
    const mode = (args[2]?.toLowerCase() === 'on-demand' ? 'on-demand' : 'periodic') as 'periodic' | 'on-demand';
    eng(ctx).setDPD(interval, retries, mode);
    return '';
  });

  trie.register('no crypto isakmp keepalive', 'Disable IKE DPD', () => {
    (eng(ctx) as any).dpdConfig = null;
    return '';
  });

  // ── crypto ipsec security-policy NAME action direction selectors ─────
  // RFC 4301 SPD configuration:
  //   crypto ipsec security-policy NAME PROTECT|BYPASS|DISCARD in|out [src SRC WILDCARD] [dst DST WILDCARD] [proto N]
  trie.registerGreedy('crypto ipsec security-policy', 'Define an IPSec security policy (SPD)', (args) => {
    if (args.length < 3) return '% Usage: crypto ipsec security-policy NAME PROTECT|BYPASS|DISCARD in|out [src IP WILDCARD] [dst IP WILDCARD] [proto N]';
    const name = args[0];
    const action = args[1].toUpperCase();
    if (action !== 'PROTECT' && action !== 'BYPASS' && action !== 'DISCARD') {
      return '% Invalid action. Use PROTECT, BYPASS, or DISCARD.';
    }
    const direction = args[2].toLowerCase();
    if (direction !== 'in' && direction !== 'out') {
      return '% Invalid direction. Use in or out.';
    }

    let srcAddress = '', srcWildcard = '', dstAddress = '', dstWildcard = '';
    let protocol = 0;
    let i = 3;
    while (i < args.length) {
      const kw = args[i].toLowerCase();
      if (kw === 'src' && args[i + 1]) {
        srcAddress = args[i + 1];
        srcWildcard = args[i + 2] || '0.0.0.0';
        i += 3;
      } else if (kw === 'dst' && args[i + 1]) {
        dstAddress = args[i + 1];
        dstWildcard = args[i + 2] || '0.0.0.0';
        i += 3;
      } else if (kw === 'proto' && args[i + 1]) {
        protocol = parseInt(args[i + 1], 10) || 0;
        i += 2;
      } else {
        i++;
      }
    }

    eng(ctx).addSecurityPolicy({
      name,
      direction: direction as 'in' | 'out',
      action: action as 'PROTECT' | 'BYPASS' | 'DISCARD',
      srcAddress, srcWildcard, dstAddress, dstWildcard,
      protocol, srcPort: 0, dstPort: 0,
    });
    return '';
  });

  // ── no crypto ipsec security-policy NAME ──────────────────────────
  trie.registerGreedy('no crypto ipsec security-policy', 'Remove an IPSec security policy', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    eng(ctx).removeSecurityPolicyByName(args[0]);
    return '';
  });

  // ── crypto ipsec transform-set NAME transforms... ─────────────────
  // Syntax: crypto ipsec transform-set MYTS esp-aes esp-sha-hmac
  //    OR:  crypto ipsec transform-set MYTS esp-aes 256 esp-sha256-hmac
  trie.registerGreedy('crypto ipsec transform-set', 'Define an IPSec transform set', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const name = args[0];
    const transforms = normalizeTransforms(args.slice(1));
    eng(ctx).addTransformSet(name, transforms, 'tunnel');
    ctx.setSelectedTransformSet(name);
    ctx.setMode('config-tfset');
    return '';
  });

  // ── crypto map NAME SEQ ipsec-isakmp [dynamic DYNMAP] ────────────
  trie.registerGreedy('crypto map', 'Define a crypto map entry', (args) => {
    // args: NAME SEQ ipsec-isakmp [dynamic DYNMAP]
    //    or: NAME SEQ ipsec-isakmp dynamic DYNMAP
    if (args.length < 3) return '% Incomplete command.';
    const mapName = args[0];
    const seq     = parseInt(args[1], 10);
    if (isNaN(seq)) return '% Invalid sequence number.';

    const keyword = args[2]?.toLowerCase();

    if (keyword === 'ipsec-isakmp') {
      if (args[3]?.toLowerCase() === 'dynamic' && args[4]) {
        // Reference to dynamic map: crypto map NAME SEQ ipsec-isakmp dynamic DYNMAP
        eng(ctx).addDynamicRefToCryptoMap(mapName, seq, args[4]);
        return '';
      }
      eng(ctx).getOrCreateCryptoMapEntry(mapName, seq);
      ctx.setSelectedCryptoMap(mapName);
      ctx.setSelectedCryptoMapSeq(seq);
      ctx.setSelectedCryptoMapIsDynamic(false);
      ctx.setMode('config-crypto-map');
      return '';
    }
    return '% Invalid crypto map type. Use ipsec-isakmp.';
  });

  // ── crypto dynamic-map NAME SEQ ───────────────────────────────────
  trie.registerGreedy('crypto dynamic-map', 'Define a dynamic crypto map', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const dynName = args[0];
    const seq     = parseInt(args[1], 10);
    if (isNaN(seq)) return '% Invalid sequence number.';
    eng(ctx).getOrCreateDynamicMapEntry(dynName, seq);
    ctx.setSelectedCryptoMap(dynName);
    ctx.setSelectedCryptoMapSeq(seq);
    ctx.setSelectedCryptoMapIsDynamic(true);
    ctx.setMode('config-crypto-map');
    return '';
  });

  // ── crypto ipsec profile NAME ─────────────────────────────────────
  trie.registerGreedy('crypto ipsec profile', 'Define an IPSec profile (for GRE)', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    eng(ctx).getOrCreateIPSecProfile(name);
    ctx.setSelectedIPSecProfile(name);
    ctx.setMode('config-ipsec-profile');
    return '';
  });
}

// ─── config-isakmp sub-mode ───────────────────────────────────────────

export function buildISAKMPPolicyCommands(trie: CommandTrie, ctx: CiscoShellContext): void {

  trie.registerGreedy('encryption', 'Set encryption algorithm', (args) => {
    const p = ctx.getSelectedISAKMPPriority();
    if (p === null) return '% No policy selected';
    const policy = eng(ctx).getOrCreateISAKMPPolicy(p);
    // Normalize: 'aes 256' or 'aes' or '3des'
    policy.encryption = args.join(' ').toLowerCase();
    return '';
  });

  trie.registerGreedy('hash', 'Set hash algorithm', (args) => {
    const p = ctx.getSelectedISAKMPPriority();
    if (p === null) return '% No policy selected';
    const policy = eng(ctx).getOrCreateISAKMPPolicy(p);
    policy.hash = args[0]?.toLowerCase() || 'sha';
    return '';
  });

  trie.registerGreedy('authentication', 'Set authentication method', (args) => {
    const p = ctx.getSelectedISAKMPPriority();
    if (p === null) return '% No policy selected';
    const policy = eng(ctx).getOrCreateISAKMPPolicy(p);
    policy.auth = args[0]?.toLowerCase() || 'pre-share';
    return '';
  });

  trie.registerGreedy('group', 'Set DH group', (args) => {
    const p = ctx.getSelectedISAKMPPriority();
    if (p === null) return '% No policy selected';
    const policy = eng(ctx).getOrCreateISAKMPPolicy(p);
    policy.group = parseInt(args[0] ?? '1', 10);
    return '';
  });

  trie.registerGreedy('lifetime', 'Set SA lifetime (seconds)', (args) => {
    const p = ctx.getSelectedISAKMPPriority();
    if (p === null) return '% No policy selected';
    const policy = eng(ctx).getOrCreateISAKMPPolicy(p);
    policy.lifetime = parseInt(args[0] ?? '86400', 10);
    return '';
  });
}

export function buildISAKMPProfileCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  const profile = () => {
    const name = ctx.getSelectedISAKMPProfile();
    if (!name) return null;
    return eng(ctx).getOrCreateISAKMPProfile(name);
  };
  trie.registerGreedy('keyring', 'Reference a keyring', (args) => {
    const p = profile(); if (!p) return '';
    p.keyring = args[0] ?? 'default';
    return '';
  });
  trie.registerGreedy('match identity address', 'Match peer identity by address', (args) => {
    const p = profile(); if (!p) return '';
    p.matchAddress = args[0];
    if (args[1]) p.matchAddressMask = args[1];
    return '';
  });
  trie.registerGreedy('match identity hostname', 'Match peer identity by hostname', (args) => {
    const p = profile(); if (!p) return '';
    p.matchHostname = args[0];
    return '';
  });
  trie.registerGreedy('self-identity', 'Set local IKE identity', (args) => {
    const p = profile(); if (!p) return '';
    p.selfIdentity = args.join(' ');
    return '';
  });
  trie.registerGreedy('vrf', 'Bind to a VRF', (args) => {
    const p = profile(); if (!p) return '';
    p.vrf = args[0];
    return '';
  });
}

// ─── config-keyring sub-mode ──────────────────────────────────────────

export function buildISAKMPKeyringCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('pre-shared-key', 'Configure a pre-shared key for a peer', (args) => {
    const name = ctx.getSelectedISAKMPKeyring();
    if (!name) return '% No keyring selected';
    if (args[0]?.toLowerCase() !== 'address' || !args[1]) {
      return '% Usage: pre-shared-key address IP [MASK] key SECRET';
    }
    const address = args[1];
    const keyIdx = args.indexOf('key');
    if (keyIdx === -1 || !args[keyIdx + 1]) {
      return '% Usage: pre-shared-key address IP [MASK] key SECRET';
    }
    const kr = eng(ctx).getOrCreateISAKMPKeyring(name);
    kr.peers.set(address, args.slice(keyIdx + 1).join(' '));
    return '';
  });
}

// ─── config-tfset sub-mode ────────────────────────────────────────────

export function buildTransformSetCommands(trie: CommandTrie, ctx: CiscoShellContext): void {

  trie.registerGreedy('mode', 'Set IPSec mode (tunnel or transport)', (args) => {
    const ts = ctx.getSelectedTransformSet();
    if (!ts) return '% No transform set selected';
    const mode = args[0]?.toLowerCase();
    if (mode === 'tunnel' || mode === 'transport') {
      eng(ctx).setTransformSetMode(ts, mode);
    } else {
      return '% Invalid mode. Use tunnel or transport.';
    }
    return '';
  });

  trie.registerGreedy('crypto ipsec transform-set', 'Define an IPSec transform set', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const name = args[0];
    const transforms = normalizeTransforms(args.slice(1));
    eng(ctx).addTransformSet(name, transforms, 'tunnel');
    ctx.setSelectedTransformSet(name);
    return '';
  });
  trie.registerGreedy('crypto ipsec security-association lifetime seconds', 'Global SA lifetime (seconds)', (args) => {
    const n = parseInt(args[0] ?? '', 10);
    if (Number.isFinite(n)) eng(ctx).setGlobalSALifetime(n);
    return '';
  });
  trie.registerGreedy('crypto ipsec security-association lifetime kilobytes', 'Global SA lifetime (KB)', (args) => {
    const n = parseInt(args[0] ?? '', 10);
    if (Number.isFinite(n)) eng(ctx).setGlobalSALifetimeKB(n);
    return '';
  });
  trie.registerGreedy('crypto ipsec security-association replay window-size', 'Set anti-replay window', (args) => {
    const n = parseInt(args[0] ?? '', 10);
    if (Number.isFinite(n)) eng(ctx).setReplayWindowSize(n);
    return '';
  });
  trie.registerGreedy('crypto ipsec security-association idle-time', 'Set SA idle time', () => '');
  trie.registerGreedy('crypto ipsec df-bit', 'Configure DF-bit handling', () => '');
  trie.registerGreedy('crypto ipsec fragmentation', 'Configure IPSec fragmentation', () => '');
  trie.registerGreedy('crypto ipsec profile', 'Enter IPSec profile config', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    eng(ctx).getOrCreateIPSecProfile(args[0]);
    ctx.setSelectedIPSecProfile(args[0]);
    ctx.setMode('config-ipsec-profile' as any);
    return '';
  });
}

// ─── config-crypto-map sub-mode ──────────────────────────────────────

export function buildCryptoMapEntryCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('description', 'Crypto map entry description', (args) => {
    const mapName = ctx.getSelectedCryptoMap();
    const seq = ctx.getSelectedCryptoMapSeq();
    if (!mapName || seq === null) return '% No crypto map selected';
    const entry = eng(ctx).getOrCreateCryptoMapEntry(mapName, seq) as unknown as Record<string, unknown>;
    entry.description = args.join(' ');
    return '';
  });
  trie.register('reverse-route', 'Add static routes for protected networks', () => {
    const mapName = ctx.getSelectedCryptoMap();
    const seq = ctx.getSelectedCryptoMapSeq();
    if (!mapName || seq === null) return '% No crypto map selected';
    const entry = eng(ctx).getOrCreateCryptoMapEntry(mapName, seq) as unknown as Record<string, unknown>;
    entry.reverseRoute = true;
    return '';
  });

  trie.registerGreedy('set peer', 'Set crypto map peer', (args) => {
    const mapName = ctx.getSelectedCryptoMap();
    const seq     = ctx.getSelectedCryptoMapSeq();
    if (!mapName || seq === null) return '% No crypto map selected';
    if (ctx.getSelectedCryptoMapIsDynamic()) return '% Dynamic maps do not have static peers';
    const filtered = args.filter(a => a && a !== 'default' && a.toLowerCase() !== 'dynamic');
    if (filtered.length === 1 && !isIPv4Literal(filtered[0])) {
      const err = eng(ctx).setDdnsPeer(mapName, seq, filtered[0]);
      return err ? `% ${err}` : '';
    }
    const entry = eng(ctx).getOrCreateCryptoMapEntry(mapName, seq);
    entry.peerHostname = undefined;
    entry.peers = filtered;
    return '';
  });

  trie.registerGreedy('set transform-set', 'Set transform set', (args) => {
    const mapName = ctx.getSelectedCryptoMap();
    const seq     = ctx.getSelectedCryptoMapSeq();
    if (!mapName || seq === null) return '% No crypto map selected';
    if (ctx.getSelectedCryptoMapIsDynamic()) {
      const e = eng(ctx).getOrCreateDynamicMapEntry(mapName, seq);
      e.transformSets = args;
    } else {
      const entry = eng(ctx).getOrCreateCryptoMapEntry(mapName, seq);
      entry.transformSets = args;
    }
    return '';
  });

  trie.registerGreedy('match address', 'Set ACL for crypto map', (args) => {
    const mapName = ctx.getSelectedCryptoMap();
    const seq     = ctx.getSelectedCryptoMapSeq();
    if (!mapName || seq === null) return '% No crypto map selected';
    if (ctx.getSelectedCryptoMapIsDynamic()) {
      const e = eng(ctx).getOrCreateDynamicMapEntry(mapName, seq);
      e.aclName = args[0] || '';
    } else {
      const entry = eng(ctx).getOrCreateCryptoMapEntry(mapName, seq);
      entry.aclName = args[0] || '';
    }
    return '';
  });

  trie.registerGreedy('set pfs', 'Set Perfect Forward Secrecy group', (args) => {
    const mapName = ctx.getSelectedCryptoMap();
    const seq     = ctx.getSelectedCryptoMapSeq();
    if (!mapName || seq === null) return '% No crypto map selected';
    const groupStr = args[0]?.toLowerCase() || '';
    if (ctx.getSelectedCryptoMapIsDynamic()) {
      const e = eng(ctx).getOrCreateDynamicMapEntry(mapName, seq);
      e.pfsGroup = groupStr;
    } else {
      const entry = eng(ctx).getOrCreateCryptoMapEntry(mapName, seq);
      entry.pfsGroup = groupStr;
    }
    return '';
  });

  trie.registerGreedy('set security-association lifetime seconds', 'Set SA lifetime', (args) => {
    const mapName = ctx.getSelectedCryptoMap();
    const seq     = ctx.getSelectedCryptoMapSeq();
    if (!mapName || seq === null) return '% No crypto map selected';
    const seconds = parseInt(args[0] ?? '3600', 10);
    if (!ctx.getSelectedCryptoMapIsDynamic()) {
      const entry = eng(ctx).getOrCreateCryptoMapEntry(mapName, seq);
      entry.saLifetimeSeconds = seconds;
    }
    return '';
  });

  trie.registerGreedy('set ikev2-profile', 'Associate IKEv2 profile', (args) => {
    const mapName = ctx.getSelectedCryptoMap();
    const seq     = ctx.getSelectedCryptoMapSeq();
    if (!mapName || seq === null || ctx.getSelectedCryptoMapIsDynamic()) return '';
    const entry = eng(ctx).getOrCreateCryptoMapEntry(mapName, seq);
    entry.ikev2ProfileName = args[0] || '';
    return '';
  });

  trie.registerGreedy('set isakmp-profile', 'Associate ISAKMP profile', (args) => {
    const mapName = ctx.getSelectedCryptoMap();
    const seq     = ctx.getSelectedCryptoMapSeq();
    if (!mapName || seq === null || ctx.getSelectedCryptoMapIsDynamic()) return '';
    const entry = eng(ctx).getOrCreateCryptoMapEntry(mapName, seq);
    entry.isakmpProfileName = args[0] || '';
    return '';
  });
}

// ─── config-ipsec-profile sub-mode ───────────────────────────────────

export function buildIPSecProfileCommands(trie: CommandTrie, ctx: CiscoShellContext): void {

  trie.registerGreedy('set transform-set', 'Set transform set for IPSec profile', (args) => {
    const name = ctx.getSelectedIPSecProfile();
    if (!name) return '% No IPSec profile selected';
    const profile = eng(ctx).getOrCreateIPSecProfile(name);
    profile.transformSetName = args[0] || '';
    return '';
  });

  trie.registerGreedy('set security-association lifetime seconds', 'Set SA lifetime', (args) => {
    const name = ctx.getSelectedIPSecProfile();
    if (!name) return '% No IPSec profile selected';
    const profile = eng(ctx).getOrCreateIPSecProfile(name);
    profile.saLifetimeSeconds = parseInt(args[0] ?? '3600', 10);
    return '';
  });
  trie.registerGreedy('set pfs', 'Set Perfect Forward Secrecy group', (args) => {
    const name = ctx.getSelectedIPSecProfile();
    if (!name) return '% No IPSec profile selected';
    const profile = eng(ctx).getOrCreateIPSecProfile(name) as any;
    profile.pfsGroup = args[0]?.toLowerCase() || 'group14';
    return '';
  });
  trie.registerGreedy('set ikev2-profile', 'Associate IKEv2 profile', (args) => {
    const name = ctx.getSelectedIPSecProfile();
    if (!name) return '% No IPSec profile selected';
    const profile = eng(ctx).getOrCreateIPSecProfile(name) as any;
    profile.ikev2Profile = args[0];
    return '';
  });
  trie.registerGreedy('set security-association lifetime kilobytes', 'Set SA lifetime KB', (args) => {
    const name = ctx.getSelectedIPSecProfile();
    if (!name) return '% No IPSec profile selected';
    const profile = eng(ctx).getOrCreateIPSecProfile(name) as any;
    profile.saLifetimeKb = parseInt(args[0] ?? '', 10);
    return '';
  });
}

// ─── Interface config mode: crypto map + tunnel protection ───────────

export function buildIPSecIfCommands(trie: CommandTrie, ctx: CiscoShellContext): void {

  trie.registerGreedy('crypto map', 'Apply crypto map to interface', (args) => {
    const iface = ctx.getSelectedInterface();
    if (!iface) return '% No interface selected';
    if (args.length < 1) return '% Incomplete command.';
    eng(ctx).applyCryptoMapToInterface(iface, args[0]);
    return '';
  });

  trie.register('no crypto map', 'Remove crypto map from interface', () => {
    const iface = ctx.getSelectedInterface();
    if (!iface) return '% No interface selected';
    eng(ctx).removeCryptoMapFromInterface(iface);
    return '';
  });

  // tunnel protection ipsec profile NAME [shared]

}

// ─── Privileged mode: clear crypto commands ──────────────────────────

export function buildIPSecPrivilegedCommands(trie: CommandTrie, ctx: CiscoShellContext): void {





  // ── debug crypto commands ─────────────────────────────────────────
  const debugSvc = () => ctx.r().getDebugService();
  const engineFor = () => (ctx.r() as any)._getOrCreateIPSecEngine();

  const IKEV2_REFUS = '% IKEv2 has no trace point on this platform:'
    + ' the IPSec engine emits its exchange on the ISAKMP channel';
  trie.registerGreedy('debug crypto ikev2', 'Enable IKEv2 debug output', () => IKEV2_REFUS);
  trie.registerGreedy('no debug crypto ikev2', 'Disable IKEv2 debug output', () => IKEV2_REFUS);
  for (const [verb, kind, category] of [
    ['isakmp', 'isakmp', 'crypto.isakmp'],
    ['ipsec', 'ipsec', 'crypto.ipsec'],
  ] as const) {
    trie.registerGreedy(`debug crypto ${verb}`, `Enable ${verb.toUpperCase()} debug output`, (args) => {
      const detail = /^detail$/i.test(args.join(' ').trim());
      engineFor().setDebug(kind, true);
      engineFor().setDebugDetail?.(kind, detail);
      return detail ? debugSvc().enable(category, 'detail') : debugSvc().enable(category);
    }, ['detail']);
    trie.registerGreedy(`no debug crypto ${verb}`, `Disable ${verb.toUpperCase()} debug output`, () => {
      (ctx.r() as any)._getIPSecEngineInternal()?.setDebug(kind, false);
      return debugSvc().disable(category);
    }, ['detail']);
  }

  const ipsecEngineOf = (r: unknown): { setDebug(k: string, on: boolean): void } | undefined =>
    (r as { _getIPSecEngineInternal?: () => { setDebug(k: string, on: boolean): void } })
      ._getIPSecEngineInternal?.();
  const turnEverythingOff = (): string => {
    const engine = ipsecEngineOf(ctx.r());
    if (engine) {
      engine.setDebug('isakmp', false);
      engine.setDebug('ipsec', false);
      engine.setDebug('ikev2', false);
    }
    const nat = ctx.r()._getNATEngine();
    nat.setDebugEnabled(false);
    nat.setDebugDetailed(false);
    const dhcp = ctx.r()._getDHCPServerInternal?.();
    dhcp?.setDebugServerPacket(false);
    dhcp?.setDebugServerEvents(false);
    ctx.r().getDebugService().disableAll();
    return 'All possible debugging has been turned off';
  };

  trie.register('debug all', 'Enable all debugging', () => {
    const engine = ipsecEngineOf(ctx.r());
    if (engine) {
      engine.setDebug('isakmp', true);
      engine.setDebug('ipsec', true);
    }
    const nat = ctx.r()._getNATEngine();
    nat.setDebugEnabled(true);
    const dhcp = ctx.r()._getDHCPServerInternal?.();
    dhcp?.setDebugServerPacket(true);
    dhcp?.setDebugServerEvents(true);
    return ctx.r().getDebugService().enableAll();
  });
  trie.register('undebug all', 'Disable all debugging', turnEverythingOff);
  trie.register('no debug all', 'Disable all debugging', turnEverythingOff);
  trie.register('undebug', 'Disable all debugging', turnEverythingOff);

  // ── show crypto engine ─────────────────────────────────────────────
  trie.register('show crypto engine brief', 'Display crypto engine information', () => {
    const engine = (ctx.r() as any)._getIPSecEngineInternal();
    if (!engine) return 'IPSec not configured.';
    return engine.showCryptoEngineBrief();
  });

  trie.register('show crypto engine configuration', 'Display crypto engine config', () => {
    const engine = (ctx.r() as any)._getIPSecEngineInternal();
    if (!engine) return 'IPSec not configured.';
    return engine.showCryptoEngineConfiguration();
  });
}

// ─── Normalise transform names (handle "aes 256" split across args) ──

export function normalizeTransforms(args: string[]): string[] {
  const transforms: string[] = [];
  let i = 0;
  while (i < args.length) {
    const t = args[i].toLowerCase();
    // Handle "esp-aes 256", "esp-aes 192", "esp-gcm 256", "ah-sha256-hmac" etc.
    if ((t === 'esp-aes' || t === 'esp-gcm') && args[i + 1] && /^\d+$/.test(args[i + 1])) {
      transforms.push(`${t} ${args[i + 1]}`);
      i += 2;
    } else {
      transforms.push(t);
      i++;
    }
  }
  return transforms;
}

const CRYPTO_ENUM = (
  name: string, description: string,
  valeurs: ReadonlyArray<readonly [string, string]>,
): ArgumentSpec => ({
  name, type: 'ENUM', description,
  values: valeurs.map(([keyword, texte]) => ({ keyword, description: texte })),
});

const SUITE_LIBRE: ArgumentSpec = {
  name: 'suite', type: 'REST', optional: true, values: [], description: '',
};

const ISAKMP_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  encryption: [CRYPTO_ENUM('algorithme', 'Encryption algorithm', [
    ['3des', 'Three key triple DES'],
    ['aes', 'AES - Advanced Encryption Standard'],
    ['des', 'DES - Data Encryption Standard (56 bit keys)'],
  ]), SUITE_LIBRE],
  hash: CRYPTO_ENUM('condense', 'Hash algorithm', [
    ['md5', 'Message Digest 5'],
    ['sha', 'Secure Hash Standard'],
    ['sha256', 'Secure Hash Standard 2 (256 bit)'],
    ['sha384', 'Secure Hash Standard 2 (384 bit)'],
    ['sha512', 'Secure Hash Standard 2 (512 bit)'],
  ]),
  authentication: CRYPTO_ENUM('methode', 'Authentication method', [
    ['pre-share', 'Pre-Shared Key'],
    ['rsa-encr', 'Rivest-Shamir-Adleman Encryption'],
    ['rsa-sig', 'Rivest-Shamir-Adleman Signature'],
  ]),
  group: CRYPTO_ENUM('groupe', 'Diffie-Hellman group', [
    ['1', 'Diffie-Hellman group 1 (768 bit)'],
    ['2', 'Diffie-Hellman group 2 (1024 bit)'],
    ['5', 'Diffie-Hellman group 5 (1536 bit)'],
    ['14', 'Diffie-Hellman group 14 (2048 bit)'],
    ['15', 'Diffie-Hellman group 15 (3072 bit)'],
    ['16', 'Diffie-Hellman group 16 (4096 bit)'],
    ['19', 'Diffie-Hellman group 19 (256 bit ECP)'],
    ['20', 'Diffie-Hellman group 20 (384 bit ECP)'],
    ['21', 'Diffie-Hellman group 21 (521 bit ECP)'],
    ['24', 'Diffie-Hellman group 24 (2048 bit, 256 bit subgroup)'],
  ]),
  lifetime: {
    name: 'secondes', type: 'INT', range: [60, 86400],
    description: 'Security association lifetime in seconds',
  },
};

const GROUPE_PFS = CRYPTO_ENUM('groupe', 'Diffie-Hellman group', [
  ['group1', 'Diffie-Hellman group 1 (768 bit)'],
  ['group2', 'Diffie-Hellman group 2 (1024 bit)'],
  ['group5', 'Diffie-Hellman group 5 (1536 bit)'],
  ['group14', 'Diffie-Hellman group 14 (2048 bit)'],
  ['group15', 'Diffie-Hellman group 15 (3072 bit)'],
  ['group16', 'Diffie-Hellman group 16 (4096 bit)'],
  ['group19', 'Diffie-Hellman group 19 (256 bit ECP)'],
  ['group20', 'Diffie-Hellman group 20 (384 bit ECP)'],
  ['group21', 'Diffie-Hellman group 21 (521 bit ECP)'],
  ['group24', 'Diffie-Hellman group 24 (2048 bit, 256 bit subgroup)'],
]);

const NOM_JEU: ArgumentSpec = {
  name: 'nom', type: 'WORD', description: 'Name of the transform set',
};

const DUREE_SA: ArgumentSpec = {
  name: 'secondes', type: 'INT', range: [120, 86400],
  description: 'Security association duration in seconds',
};

const TFSET_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  mode: CRYPTO_ENUM('encapsulation', 'IPSec encapsulation mode', [
    ['transport', 'Transport mode'],
    ['tunnel', 'Tunnel mode'],
  ]),
  'crypto ipsec profile': {
    name: 'nom', type: 'WORD', description: 'Name of the IPSec profile',
  },
  'crypto ipsec transform-set': [
    { name: 'nom', type: 'WORD', description: 'Name of the transform set' },
    { name: 'transformations', type: 'REST', description: 'Transforms to apply' },
  ],
  'crypto ipsec security-association lifetime seconds': DUREE_SA,
  'crypto ipsec security-association lifetime kilobytes': {
    name: 'kilooctets', type: 'INT',
    description: 'Security association duration in kilobytes of traffic',
  },
  'crypto ipsec security-association replay window-size': {
    name: 'taille', type: 'INT', range: [64, 1024],
    description: 'Size of the anti-replay window',
  },
};

const IPSEC_PROFILE_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'set transform-set': NOM_JEU,
  'set pfs': GROUPE_PFS,
  'set security-association lifetime seconds': DUREE_SA,
  'set security-association lifetime kilobytes': {
    name: 'kilooctets', type: 'INT',
    description: 'Security association duration in kilobytes of traffic',
  },
  'set ikev2-profile': {
    name: 'nom', type: 'WORD', description: 'Name of the IKEv2 profile',
  },
};

const ISAKMP_PROFILE_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  keyring: { name: 'nom', type: 'WORD', description: 'Name of the keyring' },
  'match identity address': [
    { name: 'adresse', type: 'IP_ADDR', description: 'Address of the peer' },
    { name: 'masque', type: 'SUBNET_MASK', optional: true, description: 'Mask of the peer address' },
  ],
  'match identity hostname': {
    name: 'hote', type: 'WORD', description: 'Hostname of the peer',
  },
  'self-identity': [CRYPTO_ENUM('identite', 'Local IKE identity', [
    ['address', 'Use the interface address as the identity'],
    ['dn', 'Use the certificate distinguished name'],
    ['fqdn', 'Use the fully qualified domain name'],
    ['user-fqdn', 'Use a user fully qualified domain name'],
  ]), { name: 'nom', type: 'REST', optional: true, values: [], description: '' }],
  vrf: { name: 'nom', type: 'WORD', description: 'Name of the VRF' },
};

const KEYRING_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'pre-shared-key': [
    CRYPTO_ENUM('genre', 'Identity of the peer', [
      ['address', 'Identify the peer by address'],
    ]),
    { name: 'adresse', type: 'IP_ADDR', description: 'Address of the peer' },
  ],
};

const KEYRING_KEYWORDS:
Readonly<Record<string, ReadonlyArray<AdapterKeyword>>> = {
  'pre-shared-key': [{
    keyword: 'key', description: 'The shared secret', afterArguments: true,
    argument: { name: 'secret', type: 'WORD', description: 'The shared secret' },
  }],
};

const CRYPTO_MAP_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  description: {
    name: 'texte', type: 'REST', literal: 'LINE',
    description: 'Up to 80 characters describing this entry',
  },
  'match address': {
    name: 'liste', type: 'WORD',
    description: 'Access list name',
    alternatives: [
      { keyword: '<100-199>', description: 'IP extended access list number' },
    ],
  },
  'set peer': [{
    name: 'pair', type: 'WORD', description: 'Hostname of the peer',
    alternatives: [{ keyword: 'A.B.C.D', description: 'IP address of the peer' }],
  }, { name: 'options', type: 'REST', optional: true, values: [], description: '' }],
  'set transform-set': [NOM_JEU,
    { name: 'autres', type: 'REST', optional: true, values: [], description: '' }],
  'set pfs': GROUPE_PFS,
  'set security-association lifetime seconds': DUREE_SA,
  'set ikev2-profile': {
    name: 'nom', type: 'WORD', description: 'Name of the IKEv2 profile',
  },
  'set isakmp-profile': {
    name: 'nom', type: 'WORD', description: 'Name of the ISAKMP profile',
  },
};

export function isakmpPolicySpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildISAKMPPolicyCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-isakmp'], minPrivilege: 15,
      argumentFor: (path) => ISAKMP_ARGUMENTS[path],
    },
  );
}

export function isakmpProfileSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildISAKMPProfileCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-isakmp-profile'], minPrivilege: 15,
      argumentFor: (path) => ISAKMP_PROFILE_ARGUMENTS[path],
    },
  );
}

export function isakmpKeyringSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildISAKMPKeyringCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-keyring'], minPrivilege: 15,
      argumentFor: (path) => KEYRING_ARGUMENTS[path],
      keywordsFor: (path) => KEYRING_KEYWORDS[path],
    },
  );
}

export function transformSetSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildTransformSetCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-tfset'], minPrivilege: 15,
      argumentFor: (path) => TFSET_ARGUMENTS[path],
    },
  );
}

export function cryptoMapEntrySpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildCryptoMapEntryCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-crypto-map'], minPrivilege: 15,
      argumentFor: (path) => CRYPTO_MAP_ARGUMENTS[path],
    },
  );
}

export function ipsecProfileSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildIPSecProfileCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-ipsec-profile'], minPrivilege: 15,
      argumentFor: (path) => IPSEC_PROFILE_ARGUMENTS[path],
    },
  );
}
