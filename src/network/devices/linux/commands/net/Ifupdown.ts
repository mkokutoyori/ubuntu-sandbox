import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const ifupCommand: LinuxCommand = {
  name: 'ifup',
  needsNetworkContext: true,
  usage: 'ifup [ -a | --no-act | INTERFACE ]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    const noAct = args.includes('--no-act') || args.includes('-n');
    const filtered = args.filter(a => a !== '-a' && a !== '--read-environment' && a !== '--no-act' && a !== '-n');
    return ctx.netConfig.ifup(ctx.net, filtered[0], noAct);
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
