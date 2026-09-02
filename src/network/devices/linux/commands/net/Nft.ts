import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const nftCommand: LinuxCommand = {
  name: 'nft',
  package: 'nftables',
  needsNetworkContext: true,
  usage: 'nft list ruleset',
  run(ctx: LinuxCommandContext, args: string[]): string {
    if (args[0] === 'list' && args[1] === 'ruleset') {
      const v4 = ctx.executor.iptables.listRuleset();
      const v6 = ctx.executor.ip6tables.listRuleset();
      return [v4, v6].filter(Boolean).join('\n');
    }
    return 'Usage: nft list ruleset';
  },
};
