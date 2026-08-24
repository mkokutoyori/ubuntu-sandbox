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
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { AdapterKeyword } from '@/cli/commands/trieAdapter';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';

function eng(ctx: CiscoShellContext) {
  return (ctx.r() as any)._getOrCreateIPSecEngine();
}

// ─── Global config mode: IKEv2 ───────────────────────────────────────

const IKEV2_GLOBAL_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'crypto ikev2 proposal': { name: 'nom', type: 'WORD',
    description: 'Name of the IKEv2 proposal' },
  'crypto ikev2 policy': { name: 'nom', type: 'WORD',
    description: 'Name of the IKEv2 policy' },
  'crypto ikev2 keyring': { name: 'nom', type: 'WORD',
    description: 'Name of the IKEv2 keyring' },
  'crypto ikev2 profile': { name: 'nom', type: 'WORD',
    description: 'Name of the IKEv2 profile' },
  'crypto ikev2 dpd': { name: 'reste', type: 'REST',
    description: 'Interval and retry, then `periodic` or `on-demand`' },
  'crypto ikev2 cookie-challenge': { name: 'seuil', type: 'REST',
    description: 'Number of half-open sessions above which a cookie is required' },
  'crypto ikev2 window': { name: 'taille', type: 'REST',
    description: 'Number of outstanding requests allowed' },
  'crypto ikev2 nat keepalive': { name: 'secondes', type: 'REST',
    description: 'Interval between NAT keepalives, in seconds' },
};

export function ikev2GlobalSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildIKEv2GlobalCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => IKEV2_GLOBAL_ARGUMENTS[path],
    },
  );
}

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

  // ── no forms ───────────────────────────────────────────────────────
  trie.registerGreedy('no crypto ikev2 proposal', 'Remove IKEv2 proposal', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    eng(ctx).removeIKEv2Proposal(args[0]);
    return '';
  });

  trie.registerGreedy('no crypto ikev2 policy', 'Remove IKEv2 policy', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    eng(ctx).removeIKEv2Policy(args[0]);
    return '';
  });

  trie.registerGreedy('no crypto ikev2 keyring', 'Remove IKEv2 keyring', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    eng(ctx).removeIKEv2Keyring(args[0]);
    return '';
  });

  trie.registerGreedy('no crypto ikev2 profile', 'Remove IKEv2 profile', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    eng(ctx).removeIKEv2Profile(args[0]);
    return '';
  });

  trie.registerGreedy('crypto ikev2 dpd', 'Global IKEv2 DPD interval / retry', (args) => {
    const interval = parseInt(args[0] ?? '', 10);
    const retry = parseInt(args[1] ?? '', 10);
    eng(ctx).setIkev2GlobalDpd(
      Number.isFinite(interval) ? interval : undefined,
      Number.isFinite(retry) ? retry : undefined,
      args[2]?.toLowerCase(),
    );
    return '';
  });
  trie.registerGreedy('crypto ikev2 nat keepalive', 'Set IKEv2 NAT keepalive', (args) => {
    const n = parseInt(args[0] ?? '', 10);
    if (Number.isFinite(n)) eng(ctx).setIkev2NatKeepalive(n);
    return '';
  });
  trie.registerGreedy('crypto ikev2 cookie-challenge', 'Set IKEv2 cookie-challenge threshold', (args) => {
    const n = parseInt(args[0] ?? '', 10);
    if (Number.isFinite(n)) eng(ctx).setIkev2CookieChallenge(n);
    return '';
  });
  trie.registerGreedy('crypto ikev2 window', 'Set IKEv2 window size', (args) => {
    const n = parseInt(args[0] ?? '', 10);
    if (Number.isFinite(n)) eng(ctx).setIkev2WindowSize(n);
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

  trie.registerGreedy('prf', 'Set pseudo-random function', (args) => {
    const name = ctx.getSelectedIKEv2Proposal();
    if (!name) return '';
    const prop = eng(ctx).getOrCreateIKEv2Proposal(name) as unknown as Record<string, unknown>;
    prop.prf = args.map((a: string) => a.toLowerCase());
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

  trie.registerGreedy('identity local', 'Set local identity', (args) => {
    const name = ctx.getSelectedIKEv2Profile();
    if (!name) return '';
    const prof = eng(ctx).getOrCreateIKEv2Profile(name);
    prof.identityLocal = args.join(' ');
    return '';
  });
  trie.registerGreedy('self-identity', 'Self-identity', (args) => {
    const name = ctx.getSelectedIKEv2Profile();
    if (!name) return '';
    const prof = eng(ctx).getOrCreateIKEv2Profile(name);
    prof.selfIdentity = args.join(' ');
    return '';
  });
  trie.registerGreedy('dpd', 'Dead Peer Detection', (args) => {
    const name = ctx.getSelectedIKEv2Profile();
    if (!name) return '';
    const prof = eng(ctx).getOrCreateIKEv2Profile(name);
    prof.dpd = {
      interval: parseInt(args[0] ?? '10', 10),
      retry: parseInt(args[1] ?? '2', 10),
      mode: args[2] ?? 'periodic',
    };
    return '';
  });
  trie.registerGreedy('lifetime', 'Set lifetime', (args) => {
    const name = ctx.getSelectedIKEv2Profile();
    if (!name) return '';
    const prof = eng(ctx).getOrCreateIKEv2Profile(name);
    prof.lifetime = parseInt(args[0] ?? '86400', 10);
    return '';
  });
}

const IKEV2_ENUM = (
  name: string, description: string,
  valeurs: ReadonlyArray<readonly [string, string]>,
): ArgumentSpec => ({
  name, type: 'ENUM', description,
  values: valeurs.map(([keyword, texte]) => ({ keyword, description: texte })),
});

const AUTRES: ArgumentSpec = {
  name: 'autres', type: 'REST', optional: true, values: [], description: '',
};

const GROUPES_DH: ReadonlyArray<readonly [string, string]> = [
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
];

const CONDENSES: ReadonlyArray<readonly [string, string]> = [
  ['md5', 'Message Digest 5'],
  ['sha1', 'Secure Hash Standard'],
  ['sha256', 'Secure Hash Standard 2 (256 bit)'],
  ['sha384', 'Secure Hash Standard 2 (384 bit)'],
  ['sha512', 'Secure Hash Standard 2 (512 bit)'],
];

const METHODE_AUTH = IKEV2_ENUM('methode', 'Authentication method', [
  ['ecdsa-sig', 'Elliptic Curve Digital Signature Algorithm'],
  ['pre-share', 'Pre-Shared Key'],
  ['rsa-sig', 'Rivest-Shamir-Adleman Signature'],
]);

const IKEV2_PROPOSAL_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  encryption: [IKEV2_ENUM('algorithme', 'Encryption algorithm', [
    ['3des', 'Three key triple DES'],
    ['aes-cbc-128', 'AES-CBC with a 128 bit key'],
    ['aes-cbc-192', 'AES-CBC with a 192 bit key'],
    ['aes-cbc-256', 'AES-CBC with a 256 bit key'],
    ['aes-gcm-128', 'AES-GCM with a 128 bit key'],
    ['aes-gcm-256', 'AES-GCM with a 256 bit key'],
    ['des', 'DES - Data Encryption Standard (56 bit keys)'],
  ]), AUTRES],
  integrity: [IKEV2_ENUM('algorithme', 'Integrity algorithm', CONDENSES), AUTRES],
  group: [IKEV2_ENUM('groupe', 'Diffie-Hellman group', GROUPES_DH), AUTRES],
  prf: [IKEV2_ENUM('fonction', 'Pseudo-random function', CONDENSES), AUTRES],
};

const IKEV2_POLICY_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  proposal: [{ name: 'nom', type: 'WORD', description: 'Name of the IKEv2 proposal' },
    AUTRES],
  'match address local': {
    name: 'adresse', type: 'IP_ADDR', description: 'Local address the policy matches',
  },
};

const IKEV2_KEYRING_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  peer: { name: 'nom', type: 'WORD', description: 'Name of the peer block' },
};

const IKEV2_KEYRING_PEER_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  address: [{ name: 'adresse', type: 'IP_ADDR', description: 'Address of the peer' },
    AUTRES],
  'pre-shared-key': [{
    name: 'secret', type: 'WORD', description: 'The shared secret',
  }, AUTRES],
};

const IKEV2_KEYRING_PEER_KEYWORDS:
Readonly<Record<string, ReadonlyArray<AdapterKeyword>>> = {
  'pre-shared-key': [{
    keyword: 'local', description: 'Key this router presents',
    argument: { name: 'secret', type: 'WORD', description: 'The shared secret' },
  }],
};

const IKEV2_PROFILE_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'match identity remote address': [
    { name: 'adresse', type: 'IP_ADDR', description: 'Address of the remote peer' },
    AUTRES],
  'authentication local': METHODE_AUTH,
  'authentication remote': METHODE_AUTH,
  keyring: { name: 'nom', type: 'WORD', description: 'Name of the IKEv2 keyring' },
  'keyring local': { name: 'nom', type: 'WORD', description: 'Name of the local IKEv2 keyring' },
  'identity local': [IKEV2_ENUM('genre', 'Local identity', [
    ['address', 'Use the interface address as the identity'],
    ['dn', 'Use the certificate distinguished name'],
    ['email', 'Use an email address'],
    ['fqdn', 'Use a fully qualified domain name'],
    ['key-id', 'Use an opaque key identifier'],
  ]), AUTRES],
  'self-identity': [IKEV2_ENUM('genre', 'Local identity', [
    ['address', 'Use the interface address as the identity'],
    ['fqdn', 'Use a fully qualified domain name'],
  ]), AUTRES],
  dpd: [
    { name: 'intervalle', type: 'INT', range: [10, 3600], description: 'Interval between liveness checks, in seconds' },
    { name: 'reprise', type: 'INT', range: [2, 60], description: 'Interval between retries, in seconds' },
    IKEV2_ENUM('mode', 'When to send the liveness check', [
      ['on-demand', 'Only when there is no incoming traffic'],
      ['periodic', 'At every interval'],
    ]),
  ],
  lifetime: { name: 'secondes', type: 'INT', range: [120, 86400], description: 'Lifetime of the IKEv2 SA, in seconds' },
};

export function ikev2ProposalSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildIKEv2ProposalCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-ikev2-proposal'], minPrivilege: 15,
      argumentFor: (path) => IKEV2_PROPOSAL_ARGUMENTS[path],
    },
  );
}

export function ikev2PolicySpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildIKEv2PolicyCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-ikev2-policy'], minPrivilege: 15,
      argumentFor: (path) => IKEV2_POLICY_ARGUMENTS[path],
    },
  );
}

export function ikev2KeyringSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildIKEv2KeyringCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-ikev2-keyring'], minPrivilege: 15,
      argumentFor: (path) => IKEV2_KEYRING_ARGUMENTS[path],
    },
  );
}

export function ikev2KeyringPeerSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildIKEv2KeyringPeerCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-ikev2-keyring-peer'], minPrivilege: 15,
      argumentFor: (path) => IKEV2_KEYRING_PEER_ARGUMENTS[path],
      keywordsFor: (path) => IKEV2_KEYRING_PEER_KEYWORDS[path],
    },
  );
}

export function ikev2ProfileSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildIKEv2ProfileCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-ikev2-profile'], minPrivilege: 15,
      argumentFor: (path) => IKEV2_PROFILE_ARGUMENTS[path],
    },
  );
}
