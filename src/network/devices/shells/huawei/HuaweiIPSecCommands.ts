/**
 * HuaweiIPSecCommands — IPsec/IKE commands for Huawei VRP CLI
 *
 * Implements:
 *   System view:
 *     ike proposal N            → ike-proposal sub-view
 *     ike peer NAME             → ike-peer sub-view
 *     ipsec proposal NAME       → ipsec-proposal sub-view
 *     ipsec policy NAME SEQ isakmp|manual → ipsec-policy sub-view
 *     display ike/ipsec         → show commands
 *   Interface view:
 *     ipsec policy NAME         → apply policy to interface
 */

import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';

// ─── Context interface for Huawei IPSec sub-modes ────────────────────

export interface HuaweiIPSecContext {
  r(): Router;
  setMode(mode: string): void;
  getSelectedInterface(): string | null;

  // IPSec sub-mode selections
  setSelectedIKEProposal(n: number | null): void;
  getSelectedIKEProposal(): number | null;
  setSelectedIKEPeer(name: string | null): void;
  getSelectedIKEPeer(): string | null;
  setSelectedIPSecProposal(name: string | null): void;
  getSelectedIPSecProposal(): string | null;
  setSelectedIPSecPolicy(name: string | null): void;
  getSelectedIPSecPolicy(): string | null;
  setSelectedIPSecPolicySeq(seq: number | null): void;
  getSelectedIPSecPolicySeq(): number | null;
}

// ─── Helper ──────────────────────────────────────────────────────────

function eng(ctx: HuaweiIPSecContext) {
  return (ctx.r() as any)._getOrCreateIPSecEngine();
}

function engOrNull(router: Router) {
  return (router as any)._getIPSecEngineInternal?.() ?? null;
}

// ─── System view: IKE / IPSec config commands ────────────────────────

export function registerHuaweiIPSecSystemCommands(
  trie: CommandTrie,
  ctx: HuaweiIPSecContext,
): void {

  // ── ike proposal N ─────────────────────────────────────────────
  trie.registerGreedy('ike proposal', 'Create or enter IKE proposal view', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const n = parseInt(args[0], 10);
    if (isNaN(n) || n < 1 || n > 100) return 'Error: Invalid proposal number (1-100).';
    eng(ctx).getOrCreateISAKMPPolicy(n);
    ctx.setSelectedIKEProposal(n);
    ctx.setMode('ike-proposal');
    return '';
  });

  // ── undo ike proposal N ────────────────────────────────────────
  trie.registerGreedy('undo ike proposal', 'Remove IKE proposal', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const n = parseInt(args[0], 10);
    if (!isNaN(n)) eng(ctx).removeISAKMPPolicy(n);
    return '';
  });

  // ── ike peer NAME ──────────────────────────────────────────────
  trie.registerGreedy('ike peer', 'Create or enter IKE peer view', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const name = args[0];
    // Store peer config in IKEv2 keyring with the peer name
    const kr = eng(ctx).getOrCreateIKEv2Keyring('default');
    if (!kr.peers.has(name)) {
      kr.peers.set(name, { name, address: '0.0.0.0', preSharedKey: '' });
    }
    ctx.setSelectedIKEPeer(name);
    ctx.setMode('ike-peer');
    return '';
  });

  // ── undo ike peer NAME ─────────────────────────────────────────
  trie.registerGreedy('undo ike peer', 'Remove IKE peer', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const kr = eng(ctx).getOrCreateIKEv2Keyring('default');
    kr.peers.delete(args[0]);
    return '';
  });

  // ── ipsec proposal NAME ────────────────────────────────────────
  trie.registerGreedy('ipsec proposal', 'Create or enter IPSec proposal view', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const name = args[0];
    eng(ctx).getOrCreateTransformSet(name, []);
    ctx.setSelectedIPSecProposal(name);
    ctx.setMode('ipsec-proposal');
    return '';
  });

  // ── undo ipsec proposal NAME ───────────────────────────────────
  trie.registerGreedy('undo ipsec proposal', 'Remove IPSec proposal', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    eng(ctx).removeTransformSet(args[0]);
    return '';
  });

  // ── ipsec policy NAME SEQ isakmp|manual ────────────────────────
  trie.registerGreedy('ipsec policy', 'Create or enter IPSec policy view', (args) => {
    if (args.length < 2) return 'Error: Usage: ipsec policy NAME SEQ isakmp|manual';
    const name = args[0];
    const seq = parseInt(args[1], 10);
    if (isNaN(seq)) return 'Error: Invalid sequence number.';
    // Create a crypto map entry to represent the IPsec policy
    eng(ctx).getOrCreateCryptoMapEntry(name, seq);
    ctx.setSelectedIPSecPolicy(name);
    ctx.setSelectedIPSecPolicySeq(seq);
    ctx.setMode('ipsec-policy');
    return '';
  });

  // ── undo ipsec policy NAME [SEQ] ───────────────────────────────
  trie.registerGreedy('undo ipsec policy', 'Remove IPSec policy', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const name = args[0];
    if (args.length >= 2) {
      const seq = parseInt(args[1], 10);
      if (!isNaN(seq)) {
        eng(ctx).removeCryptoMapEntry(name, seq);
        return '';
      }
    }
    eng(ctx).removeCryptoMap(name);
    return '';
  });

  // ── ipsec profile NAME ─────────────────────────────────────────
  trie.registerGreedy('ipsec profile', 'Create or enter IPSec profile view', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const name = args[0];
    eng(ctx).getOrCreateIPSecProfile(name);
    ctx.setSelectedIPSecPolicy(name);
    ctx.setSelectedIPSecPolicySeq(0);
    ctx.setMode('ipsec-policy');
    return '';
  });

  // ── undo ipsec profile NAME ────────────────────────────────────
  trie.registerGreedy('undo ipsec profile', 'Remove IPSec profile', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    eng(ctx).removeIPSecProfile(args[0]);
    return '';
  });

  // ── ipsec security-policy NAME action direction [selectors] ────
  trie.registerGreedy('ipsec security-policy', 'Define an IPSec security policy (SPD)', (args) => {
    if (args.length < 3) return 'Error: Usage: ipsec security-policy NAME PROTECT|BYPASS|DISCARD in|outbound [source IP WILDCARD] [destination IP WILDCARD]';
    const name = args[0];
    const action = args[1].toUpperCase();
    if (action !== 'PROTECT' && action !== 'BYPASS' && action !== 'DISCARD') {
      return 'Error: Invalid action. Use PROTECT, BYPASS, or DISCARD.';
    }
    const dirRaw = args[2].toLowerCase();
    const direction = dirRaw === 'outbound' ? 'out' : dirRaw === 'inbound' ? 'in' : dirRaw as 'in' | 'out';

    let srcAddress = '', srcWildcard = '', dstAddress = '', dstWildcard = '';
    let protocol = 0;
    let i = 3;
    while (i < args.length) {
      const kw = args[i].toLowerCase();
      if (kw === 'source' && args[i + 1]) {
        srcAddress = args[i + 1];
        srcWildcard = args[i + 2] || '0.0.0.0';
        i += 3;
      } else if (kw === 'destination' && args[i + 1]) {
        dstAddress = args[i + 1];
        dstWildcard = args[i + 2] || '0.0.0.0';
        i += 3;
      } else if (kw === 'protocol' && args[i + 1]) {
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

  // ── undo ipsec security-policy NAME ────────────────────────────
  trie.registerGreedy('undo ipsec security-policy', 'Remove an IPSec security policy', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    eng(ctx).removeSecurityPolicyByName(args[0]);
    return '';
  });

  // ── ipsec sa global-duration time-based N ──────────────────────
  trie.registerGreedy('ipsec sa global-duration time-based', 'Set global IPSec SA lifetime (seconds)', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const n = parseInt(args[0], 10);
    if (isNaN(n)) return 'Error: Invalid value.';
    eng(ctx).setGlobalSALifetime(n);
    return '';
  });

  // ── ipsec sa global-duration traffic-based N ───────────────────
  trie.registerGreedy('ipsec sa global-duration traffic-based', 'Set global IPSec SA lifetime (kilobytes)', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const n = parseInt(args[0], 10);
    if (!isNaN(n)) eng(ctx).setGlobalSALifetimeKB(n);
    return '';
  });
}

// ─── IKE Proposal sub-view ───────────────────────────────────────────

export function buildHuaweiIKEProposalCommands(
  trie: CommandTrie,
  ctx: HuaweiIPSecContext,
): void {

  trie.registerGreedy('encryption-algorithm', 'Set encryption algorithm', (args) => {
    const n = ctx.getSelectedIKEProposal();
    if (n === null) return 'Error: No IKE proposal selected.';
    const policy = eng(ctx).getOrCreateISAKMPPolicy(n);
    const algoMap: Record<string, string> = {
      'des-cbc': 'des', '3des-cbc': '3des',
      'aes-128': 'aes', 'aes-cbc-128': 'aes',
      'aes-192': 'aes 192', 'aes-cbc-192': 'aes 192',
      'aes-256': 'aes 256', 'aes-cbc-256': 'aes 256',
    };
    const raw = args.join('-').toLowerCase();
    policy.encryption = algoMap[raw] || args.join(' ').toLowerCase();
    return '';
  });

  trie.registerGreedy('authentication-algorithm', 'Set authentication (hash) algorithm', (args) => {
    const n = ctx.getSelectedIKEProposal();
    if (n === null) return 'Error: No IKE proposal selected.';
    const policy = eng(ctx).getOrCreateISAKMPPolicy(n);
    const algoMap: Record<string, string> = {
      'md5': 'md5', 'sha1': 'sha', 'sha-1': 'sha',
      'sha2-256': 'sha256', 'sha-256': 'sha256',
      'sha2-384': 'sha384', 'sha-384': 'sha384',
      'sha2-512': 'sha512', 'sha-512': 'sha512',
    };
    const raw = args[0]?.toLowerCase() || 'sha1';
    policy.hash = algoMap[raw] || raw;
    return '';
  });

  trie.registerGreedy('authentication-method', 'Set authentication method', (args) => {
    const n = ctx.getSelectedIKEProposal();
    if (n === null) return 'Error: No IKE proposal selected.';
    const policy = eng(ctx).getOrCreateISAKMPPolicy(n);
    const method = args[0]?.toLowerCase() || 'pre-share';
    policy.auth = method === 'pre-share' ? 'pre-share' : method;
    return '';
  });

  trie.registerGreedy('dh', 'Set Diffie-Hellman group', (args) => {
    const n = ctx.getSelectedIKEProposal();
    if (n === null) return 'Error: No IKE proposal selected.';
    const policy = eng(ctx).getOrCreateISAKMPPolicy(n);
    const groupMap: Record<string, number> = {
      'group1': 1, 'group2': 2, 'group5': 5,
      'group14': 14, 'group19': 19, 'group20': 20, 'group21': 21,
    };
    const raw = args[0]?.toLowerCase() || 'group1';
    policy.group = groupMap[raw] || parseInt(raw.replace('group', ''), 10) || 1;
    return '';
  });

  trie.registerGreedy('sa duration', 'Set IKE SA lifetime (seconds)', (args) => {
    const n = ctx.getSelectedIKEProposal();
    if (n === null) return 'Error: No IKE proposal selected.';
    const policy = eng(ctx).getOrCreateISAKMPPolicy(n);
    const seconds = parseInt(args[0] ?? '86400', 10);
    if (!isNaN(seconds)) policy.lifetime = seconds;
    return '';
  });
}

// ─── IKE Peer sub-view ───────────────────────────────────────────────

export function buildHuaweiIKEPeerCommands(
  trie: CommandTrie,
  ctx: HuaweiIPSecContext,
): void {

  trie.registerGreedy('pre-shared-key', 'Set pre-shared key', (args) => {
    const peerName = ctx.getSelectedIKEPeer();
    if (!peerName) return 'Error: No IKE peer selected.';
    const kr = eng(ctx).getOrCreateIKEv2Keyring('default');
    const peer = kr.peers.get(peerName);
    // Syntax: pre-shared-key cipher|simple KEY
    if (peer) {
      const key = args.length >= 2 ? args[1] : args[0] || '';
      peer.preSharedKey = key;
    }
    // Also set as IKEv1 PSK (for backward compat)
    if (peer?.address && peer.address !== '0.0.0.0') {
      eng(ctx).addPreSharedKey(peer.address, peer?.preSharedKey || '');
    }
    return '';
  });

  trie.registerGreedy('remote-address', 'Set remote peer IP address', (args) => {
    const peerName = ctx.getSelectedIKEPeer();
    if (!peerName) return 'Error: No IKE peer selected.';
    const kr = eng(ctx).getOrCreateIKEv2Keyring('default');
    const peer = kr.peers.get(peerName);
    if (peer) {
      peer.address = args[0] || '0.0.0.0';
      // Also register as IKEv1 PSK address if key is set
      if (peer.preSharedKey) {
        eng(ctx).addPreSharedKey(peer.address, peer.preSharedKey);
      }
    }
    return '';
  });

  trie.registerGreedy('ike-proposal', 'Reference an IKE proposal', (_args) => {
    // In Huawei, this binds the peer to a specific proposal — we don't track this separately
    // since IPSecEngine negotiates by comparing all policies.
    return '';
  });

  trie.registerGreedy('exchange-mode', 'Set IKE exchange mode (main/aggressive)', (_args) => {
    // Stored but not yet affecting negotiation
    return '';
  });

  trie.registerGreedy('local-address', 'Set local address for IKE', (_args) => {
    return '';
  });

  trie.registerGreedy('nat traversal', 'Enable NAT traversal', () => {
    eng(ctx).setNATKeepalive(20); // default 20s
    return '';
  });

  trie.registerGreedy('dpd type', 'Configure Dead Peer Detection', (args) => {
    const mode = args[0]?.toLowerCase() === 'on-demand' ? 'on-demand' : 'periodic';
    eng(ctx).setDPD(10, 3, mode as 'periodic' | 'on-demand');
    return '';
  });
}

// ─── IPSec Proposal sub-view ─────────────────────────────────────────

export function buildHuaweiIPSecProposalCommands(
  trie: CommandTrie,
  ctx: HuaweiIPSecContext,
): void {

  trie.registerGreedy('transform', 'Set transform mode (esp/ah/ah-esp)', (args) => {
    const name = ctx.getSelectedIPSecProposal();
    if (!name) return 'Error: No IPSec proposal selected.';
    // 'esp', 'ah', 'ah-esp' → stored for reference but transforms are set separately
    return '';
  });

  trie.registerGreedy('encapsulation-mode', 'Set encapsulation mode (tunnel/transport)', (args) => {
    const name = ctx.getSelectedIPSecProposal();
    if (!name) return 'Error: No IPSec proposal selected.';
    const mode = args[0]?.toLowerCase();
    if (mode === 'tunnel' || mode === 'transport') {
      eng(ctx).setTransformSetMode(name, mode);
    }
    return '';
  });

  trie.registerGreedy('esp authentication-algorithm', 'Set ESP authentication algorithm', (args) => {
    const name = ctx.getSelectedIPSecProposal();
    if (!name) return 'Error: No IPSec proposal selected.';
    const ts = eng(ctx).getOrCreateTransformSet(name, []);
    const algoMap: Record<string, string> = {
      'md5': 'esp-md5-hmac', 'sha1': 'esp-sha-hmac',
      'sha2-256': 'esp-sha256-hmac', 'sha2-384': 'esp-sha384-hmac',
      'sha2-512': 'esp-sha512-hmac',
    };
    const raw = args[0]?.toLowerCase() || 'sha1';
    const transform = algoMap[raw] || `esp-${raw}-hmac`;
    // Replace existing auth transform
    ts.transforms = ts.transforms.filter(t => !t.includes('hmac'));
    ts.transforms.push(transform);
    return '';
  });

  trie.registerGreedy('esp encryption-algorithm', 'Set ESP encryption algorithm', (args) => {
    const name = ctx.getSelectedIPSecProposal();
    if (!name) return 'Error: No IPSec proposal selected.';
    const ts = eng(ctx).getOrCreateTransformSet(name, []);
    const algoMap: Record<string, string> = {
      'des': 'esp-des', '3des': 'esp-3des',
      'aes-128': 'esp-aes', 'aes-192': 'esp-aes 192', 'aes-256': 'esp-aes 256',
    };
    const raw = args[0]?.toLowerCase() || 'aes-128';
    const transform = algoMap[raw] || `esp-${raw}`;
    // Replace existing encryption transform
    ts.transforms = ts.transforms.filter(t => !t.match(/^esp-(aes|des|3des|gcm)/));
    ts.transforms.push(transform);
    return '';
  });

  trie.registerGreedy('ah authentication-algorithm', 'Set AH authentication algorithm', (args) => {
    const name = ctx.getSelectedIPSecProposal();
    if (!name) return 'Error: No IPSec proposal selected.';
    const ts = eng(ctx).getOrCreateTransformSet(name, []);
    const algoMap: Record<string, string> = {
      'md5': 'ah-md5-hmac', 'sha1': 'ah-sha-hmac',
      'sha2-256': 'ah-sha256-hmac',
    };
    const raw = args[0]?.toLowerCase() || 'sha1';
    const transform = algoMap[raw] || `ah-${raw}-hmac`;
    ts.transforms = ts.transforms.filter(t => !t.startsWith('ah-'));
    ts.transforms.push(transform);
    return '';
  });
}

// ─── IPSec Policy sub-view ───────────────────────────────────────────

export function buildHuaweiIPSecPolicyCommands(
  trie: CommandTrie,
  ctx: HuaweiIPSecContext,
): void {

  trie.registerGreedy('security acl', 'Set traffic selection ACL', (args) => {
    const name = ctx.getSelectedIPSecPolicy();
    const seq = ctx.getSelectedIPSecPolicySeq();
    if (!name || seq === null) return 'Error: No IPSec policy selected.';
    const entry = eng(ctx).getOrCreateCryptoMapEntry(name, seq);
    entry.aclName = args[0] || '';
    return '';
  });

  trie.registerGreedy('ike-peer', 'Reference IKE peer', (args) => {
    const name = ctx.getSelectedIPSecPolicy();
    const seq = ctx.getSelectedIPSecPolicySeq();
    if (!name || seq === null) return 'Error: No IPSec policy selected.';
    const entry = eng(ctx).getOrCreateCryptoMapEntry(name, seq);
    // Find the peer's IP address from the keyring
    const peerName = args[0] || '';
    const kr = eng(ctx).getOrCreateIKEv2Keyring('default');
    const peer = kr.peers.get(peerName);
    if (peer && peer.address !== '0.0.0.0') {
      entry.peers = [peer.address];
    }
    return '';
  });

  trie.registerGreedy('proposal', 'Reference IPSec proposal', (args) => {
    const name = ctx.getSelectedIPSecPolicy();
    const seq = ctx.getSelectedIPSecPolicySeq();
    if (!name || seq === null) return 'Error: No IPSec policy selected.';
    const entry = eng(ctx).getOrCreateCryptoMapEntry(name, seq);
    entry.transformSets = args.filter(a => a.trim());
    return '';
  });

  trie.registerGreedy('pfs', 'Set Perfect Forward Secrecy', (args) => {
    const name = ctx.getSelectedIPSecPolicy();
    const seq = ctx.getSelectedIPSecPolicySeq();
    if (!name || seq === null) return 'Error: No IPSec policy selected.';
    const entry = eng(ctx).getOrCreateCryptoMapEntry(name, seq);
    entry.pfsGroup = args[0]?.toLowerCase() || 'group14';
    return '';
  });

  trie.registerGreedy('sa duration time-based', 'Set SA lifetime (seconds)', (args) => {
    const name = ctx.getSelectedIPSecPolicy();
    const seq = ctx.getSelectedIPSecPolicySeq();
    if (!name || seq === null) return 'Error: No IPSec policy selected.';
    const entry = eng(ctx).getOrCreateCryptoMapEntry(name, seq);
    entry.saLifetimeSeconds = parseInt(args[0] ?? '3600', 10);
    return '';
  });

  trie.registerGreedy('sa duration traffic-based', 'Set SA lifetime (kilobytes)', (args) => {
    const kb = parseInt(args[0] ?? '4608000', 10);
    if (!isNaN(kb)) eng(ctx).setGlobalSALifetimeKB(kb);
    return '';
  });
}

// ─── Interface view: ipsec policy binding ────────────────────────────

export function registerHuaweiIPSecInterfaceCommands(
  trie: CommandTrie,
  ctx: HuaweiIPSecContext,
): void {

  trie.registerGreedy('ipsec policy', 'Apply IPSec policy to interface', (args) => {
    const iface = ctx.getSelectedInterface();
    if (!iface) return 'Error: No interface selected.';
    if (args.length < 1) return 'Error: Incomplete command.';
    eng(ctx).applyCryptoMapToInterface(iface, args[0]);
    return '';
  });

  trie.registerGreedy('undo ipsec policy', 'Remove IPSec policy from interface', () => {
    const iface = ctx.getSelectedInterface();
    if (!iface) return 'Error: No interface selected.';
    eng(ctx).removeCryptoMapFromInterface(iface);
    return '';
  });

  trie.registerGreedy('ipsec profile', 'Apply IPSec profile to tunnel interface', (args) => {
    const iface = ctx.getSelectedInterface();
    if (!iface) return 'Error: No interface selected.';
    if (args.length < 1) return 'Error: Incomplete command.';
    eng(ctx).setTunnelProtection(iface, args[0], false);
    return '';
  });

  trie.registerGreedy('undo ipsec profile', 'Remove IPSec profile from interface', () => {
    const iface = ctx.getSelectedInterface();
    if (!iface) return 'Error: No interface selected.';
    eng(ctx).removeTunnelProtection(iface);
    return '';
  });
}

// ─── Display commands (available in all views) ───────────────────────

export function registerHuaweiIPSecDisplayCommands(
  trie: CommandTrie,
  getRouter: () => Router,
): void {

  trie.register('display ike proposal', 'Display IKE proposals', () => {
    const e = engOrNull(getRouter());
    if (!e) return 'Info: No IPSec configuration.';
    return e.showCryptoISAKMPPolicy();
  });

  trie.register('display ike sa', 'Display IKE SAs', () => {
    const e = engOrNull(getRouter());
    if (!e) return 'Info: No IPSec configuration.';
    return e.showCryptoISAKMPSA();
  });

  trie.register('display ike sa verbose', 'Display detailed IKE SAs', () => {
    const e = engOrNull(getRouter());
    if (!e) return 'Info: No IPSec configuration.';
    return e.showCryptoISAKMPSADetail();
  });

  trie.register('display ipsec proposal', 'Display IPSec proposals', () => {
    const e = engOrNull(getRouter());
    if (!e) return 'Info: No IPSec configuration.';
    return e.showCryptoIPSecTransformSet();
  });

  trie.register('display ipsec policy', 'Display IPSec policies', () => {
    const e = engOrNull(getRouter());
    if (!e) return 'Info: No IPSec configuration.';
    return e.showCryptoMap();
  });

  trie.register('display ipsec policy brief', 'Display IPSec policies (brief)', () => {
    const e = engOrNull(getRouter());
    if (!e) return 'Info: No IPSec configuration.';
    return e.showCryptoMap();
  });

  trie.register('display ipsec sa', 'Display IPSec SAs', () => {
    const e = engOrNull(getRouter());
    if (!e) return 'Info: No IPSec configuration.';
    return e.showCryptoIPSecSA();
  });

  trie.register('display ipsec sa brief', 'Display IPSec SAs (brief)', () => {
    const e = engOrNull(getRouter());
    if (!e) return 'Info: No IPSec configuration.';
    return e.showCryptoIPSecSA();
  });

  trie.register('display ipsec statistics', 'Display IPSec statistics', () => {
    const e = engOrNull(getRouter());
    if (!e) return 'Info: No IPSec configuration.';
    return e.showCryptoEngineBrief();
  });

  trie.register('display ipsec interface', 'Display interfaces with IPSec', () => {
    const e = engOrNull(getRouter());
    if (!e) return 'Info: No IPSec configuration.';
    return e.showCryptoEngineConfiguration();
  });

  trie.register('display ipsec security-policy', 'Display IPSec security policies (SPD)', () => {
    const e = engOrNull(getRouter());
    if (!e) return 'Info: No IPSec configuration.';
    return e.showSecurityPolicy();
  });

  // ── reset commands (privileged) ────────────────────────────────

  trie.register('reset ike sa', 'Clear all IKE SAs', () => {
    engOrNull(getRouter())?.clearAllSAs();
    return 'Info: IKE SAs cleared.';
  });

  trie.register('reset ipsec sa', 'Clear all IPSec SAs', () => {
    engOrNull(getRouter())?.clearAllSAs();
    return 'Info: IPSec SAs cleared.';
  });

  // ── debug commands ────────────────────────────────────────────

  trie.register('debugging ike', 'Enable IKE debug output', () => {
    const e = engOrNull(getRouter());
    if (!e) {
      (getRouter() as any)._getOrCreateIPSecEngine().setDebug('isakmp', true);
    } else {
      e.setDebug('isakmp', true);
    }
    return 'Info: IKE debugging is on.';
  });

  trie.register('undo debugging ike', 'Disable IKE debug output', () => {
    engOrNull(getRouter())?.setDebug('isakmp', false);
    return 'Info: IKE debugging is off.';
  });

  trie.register('debugging ipsec', 'Enable IPSec debug output', () => {
    const e = engOrNull(getRouter());
    if (!e) {
      (getRouter() as any)._getOrCreateIPSecEngine().setDebug('ipsec', true);
    } else {
      e.setDebug('ipsec', true);
    }
    return 'Info: IPSec debugging is on.';
  });

  trie.register('undo debugging ipsec', 'Disable IPSec debug output', () => {
    engOrNull(getRouter())?.setDebug('ipsec', false);
    return 'Info: IPSec debugging is off.';
  });

  trie.register('undo debugging all', 'Disable all debugging', () => {
    const e = engOrNull(getRouter());
    if (e) {
      e.setDebug('isakmp', false);
      e.setDebug('ipsec', false);
      e.setDebug('ikev2', false);
    }
    return 'Info: All debugging turned off.';
  });
}
