/**
 * CiscoRipCommands - Extracted RIP command registration for Cisco IOS CLI
 *
 * Handles:
 *   - Router config mode (config-router)# — RIP network, version
 */

import { IPAddress, SubnetMask } from '../../../core/types';
import { CommandTrie } from '../CommandTrie';
import type { CiscoShellContext } from './CiscoConfigCommands';
import { classfulMask } from './CiscoConfigCommands';

// ─── Router Config Mode Commands (config-router)# ────────────────────

export function buildConfigRouterCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('network', 'Advertise a network in RIP', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!ctx.r().isRIPEnabled()) return '% RIP is not enabled.';
    try {
      const network = new IPAddress(args[0]);
      const mask = args.length >= 2 ? new SubnetMask(args[1]) : classfulMask(network);
      ctx.r().ripAdvertiseNetwork(network, mask);
      return '';
    } catch (e: any) {
      return `% Invalid input: ${e.message}`;
    }
  });

  trie.register('version 2', 'Use RIPv2', () => '');

  trie.register('no router rip', 'Disable RIP and exit to config mode', () => {
    ctx.setMode('config');
    ctx.r().disableRIP();
    return '';
  });
}
