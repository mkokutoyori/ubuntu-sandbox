/**
 * CiscoIPSecIKEv2Commands — IKEv2 global config commands
 *
 * Handles:
 *   crypto ikev2 proposal NAME  → config-ikev2-proposal
 *   crypto ikev2 policy N       → config-ikev2-policy
 *   crypto ikev2 keyring NAME   → config-ikev2-keyring
 *     peer NAME                 → config-ikev2-keyring-peer
 *   crypto ikev2 profile NAME   → config-ikev2-profile
 */

import { CommandTrie } from '../CommandTrie';
import type { CiscoShellContext } from './CiscoConfigCommands';

function eng(ctx: CiscoShellContext) {
  return (ctx.r() as any)._getOrCreateIPSecEngine();
}

// ─── Global config mode: IKEv2 ───────────────────────────────────────

export function buildIKEv2GlobalCommands(trie: CommandTrie, ctx: CiscoShellContext): void {

  // crypto ikev2 proposal NAME
  trie.registerGreedy('crypto ikev2 proposal', 'Define IKEv2 proposal', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    eng(ctx).getOrCreateIKEv2Proposal(name);
    ctx.setSelectedIKEv2Proposal(name);
    ctx.setMode('config-ikev2-proposal');
    return '';
  });

  // crypto ikev2 policy NAME|N
  trie.registerGreedy('crypto ikev2 policy', 'Define IKEv2 policy', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    eng(ctx).getOrCreateIKEv2Policy(name);
    ctx.setSelectedIKEv2Policy(name);
    ctx.setMode('config-ikev2-policy');
    return '';
  });

  // crypto ikev2 keyring NAME
  trie.registerGreedy('crypto ikev2 keyring', 'Define IKEv2 keyring', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    eng(ctx).getOrCreateIKEv2Keyring(name);
    ctx.setSelectedIKEv2Keyring(name);
    ctx.setMode('config-ikev2-keyring');
    return '';
  });

  // crypto ikev2 profile NAME
  trie.registerGreedy('crypto ikev2 profile', 'Define IKEv2 profile', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    eng(ctx).getOrCreateIKEv2Profile(name);
    ctx.setSelectedIKEv2Profile(name);
    ctx.setMode('config-ikev2-profile');
    return '';
  });
}

// ─── config-ikev2-proposal sub-mode ──────────────────────────────────

export function buildIKEv2ProposalCommands(trie: CommandTrie, ctx: CiscoShellContext): void {

  trie.registerGreedy('encryption', 'Set encryption algorithm(s)', (args) => {
    const name = ctx.getSelectedIKEv2Proposal();
    if (!name) return '% No IKEv2 proposal selected';
    const prop = eng(ctx).getOrCreateIKEv2Proposal(name);
    prop.encryption = args.map((a: string) => a.toLowerCase());
    return '';
  });

  trie.registerGreedy('integrity', 'Set integrity algorithm(s)', (args) => {
    const name = ctx.getSelectedIKEv2Proposal();
    if (!name) return '% No IKEv2 proposal selected';
    const prop = eng(ctx).getOrCreateIKEv2Proposal(name);
    prop.integrity = args.map((a: string) => a.toLowerCase());
    return '';
  });

  trie.registerGreedy('group', 'Set DH group(s)', (args) => {
    const name = ctx.getSelectedIKEv2Proposal();
    if (!name) return '% No IKEv2 proposal selected';
    const prop = eng(ctx).getOrCreateIKEv2Proposal(name);
    prop.dhGroup = args.map((a: string) => parseInt(a, 10)).filter((n: number) => !isNaN(n));
    return '';
  });
}

// ─── config-ikev2-policy sub-mode ─────────────────────────────────────

export function buildIKEv2PolicyCommands(trie: CommandTrie, ctx: CiscoShellContext): void {

  trie.registerGreedy('proposal', 'Reference an IKEv2 proposal', (args) => {
    const priority = ctx.getSelectedIKEv2Policy();
    if (priority === null) return '% No IKEv2 policy selected';
    const pol = eng(ctx).getOrCreateIKEv2Policy(priority);
    pol.proposalNames.push(...args);
    return '';
  });

  trie.registerGreedy('match address local', 'Match local address for policy', (args) => {
    const priority = ctx.getSelectedIKEv2Policy();
    if (priority === null) return '% No IKEv2 policy selected';
    const pol = eng(ctx).getOrCreateIKEv2Policy(priority);
    pol.matchAddressLocal = args[0] || '';
    return '';
  });
}

// ─── config-ikev2-keyring sub-mode ────────────────────────────────────

export function buildIKEv2KeyringCommands(trie: CommandTrie, ctx: CiscoShellContext): void {

  trie.registerGreedy('peer', 'Define a keyring peer', (args) => {
    const krName = ctx.getSelectedIKEv2Keyring();
    if (!krName) return '% No IKEv2 keyring selected';
    if (args.length < 1) return '% Incomplete command.';
    const peerName = args[0];
    const kr = eng(ctx).getOrCreateIKEv2Keyring(krName);
    if (!kr.peers.has(peerName)) {
      kr.peers.set(peerName, { name: peerName, address: '0.0.0.0', preSharedKey: '' });
    }
    ctx.setSelectedIKEv2KeyringPeer(peerName);
    ctx.setMode('config-ikev2-keyring-peer');
    return '';
  });
}

// ─── config-ikev2-keyring-peer sub-mode ──────────────────────────────

export function buildIKEv2KeyringPeerCommands(trie: CommandTrie, ctx: CiscoShellContext): void {

  trie.registerGreedy('address', 'Set peer IP address', (args) => {
    const krName   = ctx.getSelectedIKEv2Keyring();
    const peerName = ctx.getSelectedIKEv2KeyringPeer();
    if (!krName || !peerName) return '% No keyring peer selected';
    const kr   = eng(ctx).getOrCreateIKEv2Keyring(krName);
    const peer = kr.peers.get(peerName);
    if (peer) peer.address = args[0] || '0.0.0.0';
    return '';
  });

  trie.registerGreedy('pre-shared-key', 'Set pre-shared key', (args) => {
    const krName   = ctx.getSelectedIKEv2Keyring();
    const peerName = ctx.getSelectedIKEv2KeyringPeer();
    if (!krName || !peerName) return '% No keyring peer selected';
    const kr   = eng(ctx).getOrCreateIKEv2Keyring(krName);
    const peer = kr.peers.get(peerName);
    // Syntax: pre-shared-key KEY  OR  pre-shared-key local KEY
    const idx = args.indexOf('local');
    if (peer) peer.preSharedKey = idx !== -1 ? (args[idx + 1] || '') : (args[0] || '');
    return '';
  });
}

// ─── config-ikev2-profile sub-mode ───────────────────────────────────

export function buildIKEv2ProfileCommands(trie: CommandTrie, ctx: CiscoShellContext): void {

  trie.registerGreedy('match identity remote address', 'Match remote identity by address', (args) => {
    const name = ctx.getSelectedIKEv2Profile();
    if (!name) return '% No IKEv2 profile selected';
    const prof = eng(ctx).getOrCreateIKEv2Profile(name);
    prof.matchIdentityRemoteAddress = args[0] || '';
    return '';
  });

  trie.register('match identity remote any', 'Match any remote identity', () => {
    const name = ctx.getSelectedIKEv2Profile();
    if (!name) return '% No IKEv2 profile selected';
    const prof = eng(ctx).getOrCreateIKEv2Profile(name);
    prof.matchIdentityRemoteAny = true;
    return '';
  });

  trie.registerGreedy('authentication local', 'Set local authentication method', (args) => {
    const name = ctx.getSelectedIKEv2Profile();
    if (!name) return '% No IKEv2 profile selected';
    const prof = eng(ctx).getOrCreateIKEv2Profile(name);
    prof.authLocal = args[0]?.toLowerCase() || 'pre-share';
    return '';
  });

  trie.registerGreedy('authentication remote', 'Set remote authentication method', (args) => {
    const name = ctx.getSelectedIKEv2Profile();
    if (!name) return '% No IKEv2 profile selected';
    const prof = eng(ctx).getOrCreateIKEv2Profile(name);
    prof.authRemote = args[0]?.toLowerCase() || 'pre-share';
    return '';
  });

  // keyring local NAME  OR  keyring NAME
  trie.registerGreedy('keyring', 'Associate keyring with profile', (args) => {
    const name = ctx.getSelectedIKEv2Profile();
    if (!name) return '% No IKEv2 profile selected';
    const prof = eng(ctx).getOrCreateIKEv2Profile(name);
    if (args[0]?.toLowerCase() === 'local') {
      prof.keyringLocalName = args[1] || '';
    } else {
      prof.keyringName = args[0] || '';
    }
    return '';
  });

  trie.registerGreedy('keyring local', 'Associate local keyring', (args) => {
    const name = ctx.getSelectedIKEv2Profile();
    if (!name) return '% No IKEv2 profile selected';
    const prof = eng(ctx).getOrCreateIKEv2Profile(name);
    prof.keyringLocalName = args[0] || '';
    return '';
  });
}
