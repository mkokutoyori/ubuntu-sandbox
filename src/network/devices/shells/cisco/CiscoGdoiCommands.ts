/**
 * CiscoGdoiCommands — GDOI / GET-VPN group configuration (RFC 6407)
 *
 * Handles:
 *   crypto gdoi group NAME        → config-gdoi-group
 *     identity number N
 *     match address ipv4 IP        (protected multicast group address)
 *     transform-set NAME
 *     address ipv4 IP              (key server's own local address override)
 *     server local                 (activate this router as the key server)
 *     server address ipv4 IP       (register with a remote key server)
 */

import { CommandTrie } from '../CommandTrie';
import type { CiscoShellContext } from './CiscoConfigCommands';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';

function eng(ctx: CiscoShellContext) {
  return (ctx.r() as any)._getOrCreateIPSecEngine();
}

// ─── Global config mode ───────────────────────────────────────────────

export function gdoiGlobalSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildGdoiGlobalCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => path === 'crypto gdoi group'
        ? { name: 'nom', type: 'WORD', description: 'Name of the GDOI group' } : null,
    },
  );
}

export function buildGdoiGlobalCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('crypto gdoi group', 'Define a GDOI GET-VPN group', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    eng(ctx).getOrCreateGdoiGroup(name);
    ctx.setSelectedGdoiGroup(name);
    ctx.setMode('config-gdoi-group');
    return '';
  });

  trie.registerGreedy('no crypto gdoi group', 'Remove a GDOI GET-VPN group', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    eng(ctx).removeGdoiGroup(args[0]);
    return '';
  });
}

// ─── config-gdoi-group sub-mode ───────────────────────────────────────

export function buildGdoiGroupCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('identity number', 'Set the GDOI group identity number', (args) => {
    const name = ctx.getSelectedGdoiGroup();
    if (!name) return '% No GDOI group selected';
    const n = parseInt(args[0] ?? '', 10);
    if (Number.isFinite(n)) eng(ctx).getOrCreateGdoiGroup(name).identityNumber = n;
    return '';
  });

  trie.registerGreedy('match address ipv4', 'Set the protected multicast group address', (args) => {
    const name = ctx.getSelectedGdoiGroup();
    if (!name) return '% No GDOI group selected';
    eng(ctx).getOrCreateGdoiGroup(name).groupAddress = args[0] || '';
    return '';
  });

  trie.registerGreedy('transform-set', 'Set the transform-set used for the group SA', (args) => {
    const name = ctx.getSelectedGdoiGroup();
    if (!name) return '% No GDOI group selected';
    eng(ctx).getOrCreateGdoiGroup(name).transformSetName = args[0] || '';
    return '';
  });

  trie.registerGreedy('address ipv4', "Set the key server's own local address", (args) => {
    const name = ctx.getSelectedGdoiGroup();
    if (!name) return '% No GDOI group selected';
    eng(ctx).getOrCreateGdoiGroup(name).localAddress = args[0] || '';
    return '';
  });

  trie.register('server local', 'Activate this router as the GDOI key server', () => {
    const name = ctx.getSelectedGdoiGroup();
    if (!name) return '% No GDOI group selected';
    const msa = eng(ctx).activateGdoiKeyServer(name);
    return msa ? '' : '% GDOI group incomplete (need match address + transform-set)';
  });

  trie.registerGreedy('server address ipv4', 'Register as a group member with a GDOI key server', (args) => {
    const name = ctx.getSelectedGdoiGroup();
    if (!name) return '% No GDOI group selected';
    if (args.length < 1) return '% Incomplete command.';
    const group = eng(ctx).getOrCreateGdoiGroup(name);
    group.keyServerAddress = args[0];
    eng(ctx).registerWithGdoiKeyServer(name);
    return '';
  });
}

const GDOI_GROUP_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'identity number': {
    name: 'numero', type: 'INT', range: [1, 2147483647],
    description: 'Identity of the GDOI group',
  },
  'match address ipv4': {
    name: 'liste', type: 'WORD',
    description: 'Access list name that selects the protected traffic',
    alternatives: [
      { keyword: '<100-199>', description: 'IP extended access list number' },
    ],
  },
  'transform-set': {
    name: 'nom', type: 'WORD', description: 'Name of the transform set',
  },
  'address ipv4': {
    name: 'adresse', type: 'IP_ADDR', description: 'Local address of the key server',
  },
  'server address ipv4': {
    name: 'adresse', type: 'IP_ADDR', description: 'Address of the key server to register with',
  },
};

export function gdoiGroupSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildGdoiGroupCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-gdoi-group'], minPrivilege: 15,
      argumentFor: (path) => GDOI_GROUP_ARGUMENTS[path],
    },
  );
}
