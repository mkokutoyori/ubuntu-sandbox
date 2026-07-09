import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const ifupCommand: LinuxCommand = {
  name: 'ifup',
  needsNetworkContext: true,
  usage: 'ifup [ -a | INTERFACE ]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    const filtered = args.filter(a => a !== '-a' && a !== '--read-environment');
    return ctx.netConfig.ifup(ctx.net, filtered[0]);
  },
};

export const ifdownCommand: LinuxCommand = {
  name: 'ifdown',
  needsNetworkContext: true,
  usage: 'ifdown INTERFACE',
  run(ctx: LinuxCommandContext, args: string[]): string {
    const filtered = args.filter(a => !a.startsWith('-'));
    if (!filtered[0]) return 'ifdown: interface name required';
    return ctx.netConfig.ifdown(ctx.net, filtered[0]);
  },
};
