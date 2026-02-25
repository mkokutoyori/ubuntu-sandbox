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
  trie.registerGreedy('crypto isakmp key', 'Set IKE pre-shared key', (args) => {
    // Syntax: crypto isakmp key KEY address IP [/mask]
    const addrIdx = args.indexOf('address');
    if (addrIdx === -1 || addrIdx === 0) return '% Incomplete command. Usage: crypto isakmp key KEY address IP';
    const key = args.slice(0, addrIdx).join(' ');
    const addr = args[addrIdx + 1] || '0.0.0.0';
    eng(ctx).addPreSharedKey(addr, key);
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
  trie.registerGreedy('crypto isakmp keepalive', 'Configure IKE keepalive (DPD)', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const interval = parseInt(args[0], 10);
    const retries  = parseInt(args[1] ?? '3', 10);
    const modeStr  = (args[2] ?? 'periodic').toLowerCase();
    const mode     = modeStr === 'on-demand' ? 'on-demand' : 'periodic';
    if (!isNaN(interval)) eng(ctx).setDPD(interval, isNaN(retries) ? 3 : retries, mode);
    return '';
  });

  // ── no crypto isakmp keepalive ────────────────────────────────────
  trie.register('no crypto isakmp keepalive', 'Disable DPD', () => {
    eng(ctx).setDPD(0, 0, 'periodic');
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
}

// ─── config-crypto-map sub-mode ──────────────────────────────────────

export function buildCryptoMapEntryCommands(trie: CommandTrie, ctx: CiscoShellContext): void {

  trie.registerGreedy('set peer', 'Set crypto map peer', (args) => {
    const mapName = ctx.getSelectedCryptoMap();
    const seq     = ctx.getSelectedCryptoMapSeq();
    if (!mapName || seq === null) return '% No crypto map selected';
    if (ctx.getSelectedCryptoMapIsDynamic()) return '% Dynamic maps do not have static peers';
    const entry = eng(ctx).getOrCreateCryptoMapEntry(mapName, seq);
    entry.peers = args.filter(a => a && a !== 'default');
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
  trie.registerGreedy('tunnel protection ipsec profile', 'Apply IPSec profile to tunnel', (args) => {
    const iface = ctx.getSelectedInterface();
    if (!iface) return '% No interface selected';
    if (args.length < 1) return '% Incomplete command.';
    const profileName = args[0];
    const shared = args.includes('shared');
    eng(ctx).setTunnelProtection(iface, profileName, shared);
    return '';
  });
}

// ─── Privileged mode: clear crypto commands ──────────────────────────

export function buildIPSecPrivilegedCommands(trie: CommandTrie, ctx: CiscoShellContext): void {

  trie.register('clear crypto isakmp sa', 'Clear all IKE SAs', () => {
    (ctx.r() as any)._getIPSecEngineInternal()?.clearAllSAs();
    return '';
  });

  trie.register('clear crypto ipsec sa', 'Clear all IPSec SAs', () => {
    (ctx.r() as any)._getIPSecEngineInternal()?.clearAllSAs();
    return '';
  });

  trie.register('clear crypto ikev2 sa', 'Clear all IKEv2 SAs', () => {
    (ctx.r() as any)._getIPSecEngineInternal()?.clearAllSAs();
    return '';
  });

  trie.registerGreedy('clear crypto session', 'Clear IPSec session', (args) => {
    const engine = (ctx.r() as any)._getIPSecEngineInternal();
    if (!engine) return '';
    if (args.length >= 2 && args[0] === 'remote') {
      engine.clearSAsForPeer(args[1]);
    } else {
      engine.clearAllSAs();
    }
    return '';
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
